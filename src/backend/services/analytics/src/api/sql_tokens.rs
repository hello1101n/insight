use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use axum::Json;
use axum::extract::{Extension, Path};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use chrono::{DateTime, SecondsFormat, SubsecRound as _, Utc};
use secrecy::ExposeSecret as _;
use serde::{Deserialize, Serialize};
use toolkit_canonical_errors::CanonicalError;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::error::SqlTokenError;
use super::person_names::{self, PersonName};
use super::roster_names::{self, Naming, Roster};
use super::{ADMIN_ONLY, AppState, forwarded_authorization, require_admin};
use crate::domain::sql_token::store::{self, NewToken};
use crate::domain::sql_token::{TokenLabel, mint};
use crate::infra::db::entities::sql_api_tokens;

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct SqlTokenRequest {
    pub person_id: Uuid,
    pub label: String,
}
impl toolkit::api::api_dto::RequestApiDto for SqlTokenRequest {}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct CreatedSqlToken {
    pub token_id: String,
    /// Shown in this response only; the service keeps its hash.
    pub token: String,
    pub person_id: String,
    pub label: String,
    pub created_at: String,
}
impl toolkit::api::api_dto::ResponseApiDto for CreatedSqlToken {}

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
    pub person: SqlTokenPerson,
    pub created_by: SqlTokenPerson,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct SqlTokenListResponse {
    pub items: Vec<SqlTokenEntry>,
}
impl toolkit::api::api_dto::ResponseApiDto for SqlTokenListResponse {}

pub async fn list_sql_tokens(
    Extension(state): Extension<Arc<AppState>>,
    Extension(ctx): Extension<SecurityContext>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, CanonicalError> {
    require_admin(&state, &headers, admin_only).await?;

    let tenant = ctx.subject_tenant_id();
    let rows = store::list(&state.db, tenant)
        .await
        .map_err(|error| store_failed("listing", &error))?;

    let people = people(&rows);
    let names = person_names::lookup(&state.ch, tenant, &people).await;
    let roster =
        roster_names::roster(&state.identity, &people, forwarded_authorization(&headers)).await;

    Ok(Json(SqlTokenListResponse {
        items: rows
            .into_iter()
            .map(|row| entry(row, &names, &roster))
            .collect(),
    }))
}

pub async fn create_sql_token(
    Extension(state): Extension<Arc<AppState>>,
    Extension(ctx): Extension<SecurityContext>,
    headers: HeaderMap,
    Json(req): Json<SqlTokenRequest>,
) -> Result<impl IntoResponse, CanonicalError> {
    require_admin(&state, &headers, admin_only).await?;

    let label = TokenLabel::parse(&req.label)
        .map_err(|rejected| violation("label", &rejected.to_string()))?;
    let minted = mint().map_err(|error| {
        tracing::error!(%error, "crypto rng unavailable");
        CanonicalError::internal("failed to create the token").create()
    })?;
    let created_at = Utc::now().trunc_subsecs(0);

    let token_id = store::insert(
        &state.db,
        NewToken {
            tenant_id: ctx.subject_tenant_id(),
            person_id: req.person_id,
            label: &label,
            created_by: ctx.subject_id(),
            hash: &minted.hash,
            created_at,
        },
    )
    .await
    .map_err(|error| store_failed("creating", &error))?;

    let created = CreatedSqlToken {
        token_id: token_id.to_string(),
        token: minted.token.expose_secret().to_owned(),
        person_id: req.person_id.to_string(),
        label: label.as_str().to_owned(),
        created_at: timestamp(created_at),
    };
    Ok((StatusCode::CREATED, Json(created)))
}

pub async fn remove_sql_token(
    Extension(state): Extension<Arc<AppState>>,
    Extension(ctx): Extension<SecurityContext>,
    headers: HeaderMap,
    Path(token_id): Path<Uuid>,
) -> Result<impl IntoResponse, CanonicalError> {
    require_admin(&state, &headers, admin_only).await?;

    let removed = store::remove(&state.db, ctx.subject_tenant_id(), token_id)
        .await
        .map_err(|error| store_failed("removing", &error))?;
    if !removed {
        return Err(SqlTokenError::not_found("token not found")
            .with_resource(token_id.to_string())
            .create());
    }

    Ok(StatusCode::NO_CONTENT)
}

fn people(rows: &[sql_api_tokens::Model]) -> Vec<Uuid> {
    rows.iter()
        .flat_map(|row| [row.person_id, row.created_by])
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn entry(
    row: sql_api_tokens::Model,
    names: &HashMap<Uuid, PersonName>,
    roster: &Roster,
) -> SqlTokenEntry {
    SqlTokenEntry {
        token_id: row.id.to_string(),
        label: row.label,
        created_at: timestamp(row.created_at),
        person: person(row.person_id, names, roster),
        created_by: person(row.created_by, names, roster),
    }
}

fn person(person_id: Uuid, names: &HashMap<Uuid, PersonName>, roster: &Roster) -> SqlTokenPerson {
    let (display_name, username) = names
        .get(&person_id)
        .map(|name| (name.display_name.clone(), name.username.clone()))
        .unwrap_or_default();
    let naming = Naming::of(roster.get(&person_id), display_name, username);

    SqlTokenPerson {
        person_id: person_id.to_string(),
        display_name: naming.display_name,
        username: naming.username,
        email: naming.email,
    }
}

fn timestamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn admin_only() -> CanonicalError {
    SqlTokenError::permission_denied()
        .with_reason(ADMIN_ONLY)
        .create()
}

fn violation(field: &str, description: &str) -> CanonicalError {
    SqlTokenError::invalid_argument()
        .with_field_violation(field, description, "INVALID")
        .create()
}

fn store_failed(what: &str, error: &sea_orm::DbErr) -> CanonicalError {
    tracing::error!(%error, what, "personal SQL token store failed");
    CanonicalError::internal("personal SQL token store failed").create()
}
