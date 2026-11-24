use std::time::Duration;

use axum::body::Body;
use axum::http::StatusCode;
use axum::http::header::CACHE_CONTROL;
use axum::response::Response;
use chrono::{DateTime, Utc};
use sea_orm::DatabaseConnection;
use tokio::sync::Semaphore;
use uuid::Uuid;

use super::{TokenHash, looks_minted, store};
use crate::api::handlers::{X_GATEWAY_JWT, build_response, cache_control_for};
use crate::config::AuthenticatorConfig;
use crate::jwt::{ApiTokenClaims, KeyStore};

const LOOKUP_TIMEOUT: Duration = Duration::from_secs(2);
const SQL_API_ROLE: &str = "sql_api";
const SUB_TYPE: &str = "api_token";

pub(crate) struct ExchangeEnv<'a> {
    pub(crate) db: Option<&'a DatabaseConnection>,
    pub(crate) slots: &'a Semaphore,
    pub(crate) keystore: &'a KeyStore,
    pub(crate) cfg: &'a AuthenticatorConfig,
}

enum Refusal {
    Unauthenticated,
    Unavailable,
}

struct Exchanged {
    jwt: String,
    exp: u64,
}

pub(crate) async fn respond(
    env: &ExchangeEnv<'_>,
    authorization: Option<&str>,
    now: DateTime<Utc>,
) -> Response {
    match exchange(env, authorization, now).await {
        Ok(exchanged) => build_response(
            StatusCode::OK,
            vec![
                (X_GATEWAY_JWT.clone(), format!("Bearer {}", exchanged.jwt)),
                (
                    CACHE_CONTROL.clone(),
                    cache_control_for(
                        exchanged.exp,
                        seconds(now),
                        env.cfg.authz_cache_max_age_seconds,
                    ),
                ),
            ],
            Body::empty(),
        ),
        Err(Refusal::Unauthenticated) => refusal(StatusCode::UNAUTHORIZED),
        Err(Refusal::Unavailable) => refusal(StatusCode::SERVICE_UNAVAILABLE),
    }
}

fn refusal(status: StatusCode) -> Response {
    build_response(
        status,
        vec![(CACHE_CONTROL.clone(), "no-store".to_owned())],
        Body::empty(),
    )
}

async fn exchange(
    env: &ExchangeEnv<'_>,
    authorization: Option<&str>,
    now: DateTime<Utc>,
) -> Result<Exchanged, Refusal> {
    let token = authorization
        .and_then(bearer_token)
        .filter(|token| looks_minted(token))
        .ok_or(Refusal::Unauthenticated)?;

    let Some(db) = env.db else {
        tracing::warn!("API token exchange refused: personal API tokens are off");
        return Err(Refusal::Unavailable);
    };

    let deadline = tokio::time::Instant::now() + LOOKUP_TIMEOUT;
    let Ok(Ok(_slot)) = tokio::time::timeout_at(deadline, env.slots.acquire()).await else {
        tracing::warn!(
            timeout_ms = LOOKUP_TIMEOUT.as_millis(),
            "API token exchange refused: no lookup slot freed in time"
        );
        return Err(Refusal::Unavailable);
    };

    let holder = match tokio::time::timeout_at(
        deadline,
        store::holder(db, &TokenHash::of(token), now),
    )
    .await
    {
        Ok(Ok(Some(holder))) => holder,
        Ok(Ok(None)) => return Err(Refusal::Unauthenticated),
        Ok(Err(error)) => {
            tracing::warn!(%error, "API token exchange refused: MariaDB lookup failed");
            return Err(Refusal::Unavailable);
        }
        Err(_) => {
            tracing::warn!(
                timeout_ms = LOOKUP_TIMEOUT.as_millis(),
                "API token exchange refused: MariaDB lookup passed its time bound"
            );
            return Err(Refusal::Unavailable);
        }
    };

    let iat = seconds(now);
    let exp = (iat + env.cfg.jwt_ttl_seconds).min(seconds(holder.expires_at));
    let claims = ApiTokenClaims {
        sub: holder.person_id.to_string(),
        tenant_id: holder.tenant_id.to_string(),
        roles: vec![SQL_API_ROLE.to_owned()],
        sub_type: SUB_TYPE.to_owned(),
        sid: holder.token_id.to_string(),
        token_label: holder.label.as_str().to_owned(),
        iss: env.cfg.gateway_issuer.clone(),
        aud: env.cfg.sql_api_audience.clone(),
        iat,
        exp,
        jti: Uuid::now_v7().to_string(),
    };
    let jwt = env.keystore.sign_api_token(&claims).map_err(|error| {
        tracing::warn!(error = ?error, "API token exchange refused: JWT signing failed");
        Refusal::Unavailable
    })?;

    tracing::debug!(
        person_id = %holder.person_id,
        token_id = %holder.token_id,
        "personal API token exchanged"
    );
    Ok(Exchanged { jwt, exp })
}

fn bearer_token(authorization: &str) -> Option<&str> {
    let (scheme, token) = authorization.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then_some(token)
}

fn seconds(at: DateTime<Utc>) -> u64 {
    u64::try_from(at.timestamp()).unwrap_or(0)
}
