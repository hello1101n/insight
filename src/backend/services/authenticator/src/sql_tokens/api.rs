use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use axum::Json;
use axum::extract::{Extension, Path};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use chrono::{DateTime, SecondsFormat, SubsecRound as _, Utc};
use sea_orm::{DatabaseConnection, DbErr};
use secrecy::ExposeSecret as _;
use serde::{Deserialize, Serialize};
use toolkit_canonical_errors::CanonicalError;
use toolkit_security::SecurityContext;
use toolkit_security::crypto::CryptoError;
use uuid::Uuid;

use super::entity::sql_api_tokens;
use super::store::{self, NewToken};
use super::{TokenLabel, TokenLifetime, mint};
use crate::api::AppState;
use crate::api::error::SqlTokenError;
use crate::identity::RosterPerson;

const ADMIN_ROLE: &str = "admin";

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct SqlTokenRequest {
    pub person_id: Uuid,
    pub label: String,
    #[schema(minimum = 1, maximum = 730, default = 365)]
    pub lifetime_days: Option<i64>,
}
impl toolkit::api::api_dto::RequestApiDto for SqlTokenRequest {}

#[derive(Serialize, utoipa::ToSchema)]
pub struct CreatedSqlToken {
    pub token_id: String,
    /// Shown in this response only; the service keeps its hash.
    pub token: String,
    pub person_id: String,
    pub label: String,
    pub created_at: String,
    pub expires_at: String,
}
impl toolkit::api::api_dto::ResponseApiDto for CreatedSqlToken {}

impl std::fmt::Debug for CreatedSqlToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CreatedSqlToken")
            .field("token_id", &self.token_id)
            .field("person_id", &self.person_id)
            .field("label", &self.label)
            .field("created_at", &self.created_at)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct SqlTokenPerson {
    pub person_id: String,
    pub display_name: String,
    pub username: String,
    pub email: Option<String>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct SqlTokenEntry {
    pub token_id: String,
    pub label: String,
    pub created_at: String,
    pub expires_at: String,
    pub person: SqlTokenPerson,
    pub created_by: SqlTokenPerson,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct SqlTokenListResponse {
    pub items: Vec<SqlTokenEntry>,
}
impl toolkit::api::api_dto::ResponseApiDto for SqlTokenListResponse {}

type Roster = HashMap<Uuid, RosterPerson>;

pub async fn list_sql_tokens(
    Extension(state): Extension<Arc<AppState>>,
    Extension(ctx): Extension<SecurityContext>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, CanonicalError> {
    let db = authorize(&state, &ctx).await?;

    let rows = store::list(db, ctx.subject_tenant_id())
        .await
        .map_err(|error| store_failed("list", &error))?;

    let roster = roster(&state, &people(&rows), forwarded_authorization(&headers)).await;

    Ok(Json(SqlTokenListResponse {
        items: rows.into_iter().map(|row| entry(row, &roster)).collect(),
    }))
}

pub async fn create_sql_token(
    Extension(state): Extension<Arc<AppState>>,
    Extension(ctx): Extension<SecurityContext>,
    headers: HeaderMap,
    Json(req): Json<SqlTokenRequest>,
) -> Result<impl IntoResponse, CanonicalError> {
    let db = authorize(&state, &ctx).await?;

    let label = TokenLabel::parse(&req.label)
        .map_err(|rejected| violation("label", &rejected.to_string()))?;
    let lifetime = TokenLifetime::parse(req.lifetime_days)
        .map_err(|rejected| violation("lifetime_days", &rejected.to_string()))?;
    require_known_person(&state, req.person_id, forwarded_authorization(&headers)).await?;

    let minted = mint().map_err(mint_failed)?;
    let created_at = Utc::now().trunc_subsecs(0);
    let expires_at = lifetime.expiry_from(created_at);

    let token_id = store::insert(
        db,
        NewToken {
            tenant_id: ctx.subject_tenant_id(),
            person_id: req.person_id,
            label: &label,
            created_by: ctx.subject_id(),
            hash: &minted.hash,
            created_at,
            expires_at,
        },
    )
    .await
    .map_err(|error| store_failed("create", &error))?;

    tracing::info!(
        target: "audit",
        event = "sql_token_created",
        %token_id,
        person_id = %req.person_id,
        created_by = %ctx.subject_id(),
        "personal SQL token created"
    );

    Ok((
        StatusCode::CREATED,
        Json(CreatedSqlToken {
            token_id: token_id.to_string(),
            token: minted.token.expose_secret().to_owned(),
            person_id: req.person_id.to_string(),
            label: label.as_str().to_owned(),
            created_at: timestamp(created_at),
            expires_at: timestamp(expires_at),
        }),
    ))
}

pub async fn remove_sql_token(
    Extension(state): Extension<Arc<AppState>>,
    Extension(ctx): Extension<SecurityContext>,
    Path(token_id): Path<Uuid>,
) -> Result<impl IntoResponse, CanonicalError> {
    let db = authorize(&state, &ctx).await?;

    let removed = store::remove(db, ctx.subject_tenant_id(), token_id)
        .await
        .map_err(|error| store_failed("remove", &error))?;
    let Some(person_id) = removed else {
        return Err(SqlTokenError::not_found("token not found")
            .with_resource(token_id.to_string())
            .create());
    };

    tracing::info!(
        target: "audit",
        event = "sql_token_removed",
        %token_id,
        %person_id,
        removed_by = %ctx.subject_id(),
        "personal SQL token removed"
    );

    Ok(StatusCode::NO_CONTENT)
}

async fn authorize<'a>(
    state: &'a AppState,
    ctx: &SecurityContext,
) -> Result<&'a DatabaseConnection, CanonicalError> {
    if !is_admin(state, ctx).await {
        return Err(SqlTokenError::permission_denied()
            .with_reason("admin_role_required")
            .create());
    }

    state.sql_tokens_db.as_ref().ok_or_else(|| {
        CanonicalError::service_unavailable()
            .with_detail("personal SQL tokens are not configured")
            .create()
    })
}

async fn is_admin(state: &AppState, ctx: &SecurityContext) -> bool {
    match state
        .resolver
        .active_roles(
            &ctx.subject_id().to_string(),
            &ctx.subject_tenant_id().to_string(),
        )
        .await
    {
        Ok(roles) => roles.iter().any(|role| role == ADMIN_ROLE),
        Err(error) => {
            tracing::warn!(error = %error, "could not confirm the admin role for a SQL token request");
            false
        }
    }
}

fn forwarded_authorization(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
}

async fn require_known_person(
    state: &AppState,
    person_id: Uuid,
    authorization: Option<&str>,
) -> Result<(), CanonicalError> {
    let people = state
        .resolver
        .tenant_people(&[person_id], authorization)
        .await
        .map_err(|error| {
            tracing::error!(
                error = %error,
                "tenant roster read for a SQL token holder failed. The request returns 500."
            );
            CanonicalError::internal("failed to verify the person").create()
        })?;

    if people.iter().any(|person| person.person_id == person_id) {
        return Ok(());
    }
    Err(violation("person_id", "person is not in the tenant roster"))
}

async fn roster(state: &AppState, ids: &[Uuid], authorization: Option<&str>) -> Roster {
    match state.resolver.tenant_people(ids, authorization).await {
        Ok(people) => people
            .into_iter()
            .map(|person| (person.person_id, person))
            .collect(),
        Err(error) => {
            tracing::warn!(error = %error, "naming people from the tenant roster failed");
            HashMap::new()
        }
    }
}

fn people(rows: &[sql_api_tokens::Model]) -> Vec<Uuid> {
    rows.iter()
        .flat_map(|row| [row.person_id, row.created_by])
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn entry(row: sql_api_tokens::Model, roster: &Roster) -> SqlTokenEntry {
    SqlTokenEntry {
        token_id: row.id.to_string(),
        label: row.label,
        created_at: timestamp(row.created_at),
        expires_at: timestamp(row.expires_at),
        person: person(row.person_id, roster),
        created_by: person(row.created_by, roster),
    }
}

fn person(person_id: Uuid, roster: &Roster) -> SqlTokenPerson {
    let listed = roster.get(&person_id);

    SqlTokenPerson {
        person_id: person_id.to_string(),
        display_name: listed
            .and_then(|person| person.display_name.clone())
            .unwrap_or_default(),
        username: listed
            .and_then(|person| person.username.clone())
            .unwrap_or_default(),
        email: listed.and_then(|person| person.email.clone()),
    }
}

fn timestamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn violation(field: &str, description: &str) -> CanonicalError {
    SqlTokenError::invalid_argument()
        .with_field_violation(field, description, "INVALID")
        .create()
}

fn mint_failed(error: CryptoError) -> CanonicalError {
    tracing::error!(
        error = %error,
        "SQL token mint read from the crypto RNG failed. The request returns 500."
    );
    CanonicalError::internal("failed to create the token").create()
}

fn store_failed(operation: &str, error: &DbErr) -> CanonicalError {
    tracing::error!(
        error = %error,
        operation,
        "personal SQL token query in MariaDB failed. The request returns 500."
    );
    CanonicalError::internal("personal SQL token store failed").create()
}

#[cfg(test)]
mod tests {
    use super::CreatedSqlToken;

    #[test]
    fn a_created_token_never_prints_its_secret() {
        let created = CreatedSqlToken {
            token_id: "t-1".to_owned(),
            token: "isql_synthetic-token-never-printed".to_owned(),
            person_id: "p-1".to_owned(),
            label: "laptop".to_owned(),
            created_at: "2026-11-12T10:00:00Z".to_owned(),
            expires_at: "2027-11-12T10:00:00Z".to_owned(),
        };

        let printed = format!("{created:?}");

        assert!(!printed.contains("never-printed"), "leaked: {printed}");
        assert!(printed.contains("laptop"), "lost the label: {printed}");
    }
}
