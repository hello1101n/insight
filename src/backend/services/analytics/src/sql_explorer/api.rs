use std::sync::Arc;

use authn_resolver_sdk::{AuthNResolverClient, AuthNResolverError};
use axum::extract::{DefaultBodyLimit, Request, State, rejection::JsonRejection};
use axum::http::header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, WWW_AUTHENTICATE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Extension, Json, Router};
use secrecy::ExposeSecret as _;
use serde::Deserialize;
use toolkit_canonical_errors::{CanonicalError, Http, resource_error};
use toolkit_security::crypto::{constant_time_eq, hash::Sha256};

use super::executor::{MAX_REQUEST_BODY_BYTES, QueryExecutor, QueryFailure, TokenHolder};
use crate::config::SqlApiConfig;

const API_TOKEN_SUB_TYPE: &str = "api_token";
const MAX_CREDENTIAL_BYTES: usize = 4096;

#[resource_error("gts.cf.insight.analytics_api.sql_query.v1~")]
struct SqlQueryError;

#[cfg(test)]
mod tests;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct QueryRequest {
    sql: String,
}

#[derive(Clone)]
struct AuthState {
    token_hash: [u8; 32],
    authn: Arc<dyn AuthNResolverClient>,
}

enum AuthFailure {
    Unauthorized,
    Unavailable,
}

#[derive(Debug, Deserialize)]
struct ApiTokenClaims {
    sid: String,
    token_label: String,
}

pub(super) fn router(
    config: &SqlApiConfig,
    authn: Arc<dyn AuthNResolverClient>,
    executor: QueryExecutor,
) -> Router {
    let state = AuthState {
        token_hash: Sha256::digest(config.token.expose_secret().as_bytes()),
        authn,
    };
    Router::new()
        .route("/api/sql/query", post(query))
        .with_state(executor)
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        .layer(middleware::from_fn_with_state(state, authenticate))
}

async fn authenticate(
    State(state): State<AuthState>,
    headers: HeaderMap,
    mut request: Request,
    next: Next,
) -> Response {
    let mut response = match identify(&state, &headers).await {
        Ok(holder) => {
            request.extensions_mut().insert(holder);
            next.run(request).await
        }
        Err(AuthFailure::Unauthorized) => {
            let mut response = CanonicalError::unauthenticated()
                .with_reason("INVALID_INSTANCE_TOKEN")
                .create()
                .into_response();
            response
                .headers_mut()
                .insert(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
            response
        }
        Err(AuthFailure::Unavailable) => CanonicalError::service_unavailable()
            .with_detail("credential verification is unavailable; retry shortly")
            .create()
            .into_response(),
    };
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn identify(
    state: &AuthState,
    headers: &HeaderMap,
) -> Result<Option<TokenHolder>, AuthFailure> {
    let token = bearer_credential(headers).ok_or(AuthFailure::Unauthorized)?;
    if constant_time_eq(&Sha256::digest(token.as_bytes()), &state.token_hash) {
        return Ok(None);
    }
    let subject = state
        .authn
        .authenticate(token)
        .await
        .map_err(|error| match error {
            AuthNResolverError::Unauthorized(_) => AuthFailure::Unauthorized,
            _ => AuthFailure::Unavailable,
        })?
        .security_context;
    if subject.subject_type() != Some(API_TOKEN_SUB_TYPE) {
        return Err(AuthFailure::Unauthorized);
    }
    let claims = jsonwebtoken::dangerous::insecure_decode::<ApiTokenClaims>(token)
        .map_err(|_| AuthFailure::Unauthorized)?
        .claims;
    Ok(Some(TokenHolder {
        person_id: subject.subject_id().to_string(),
        token_id: claims.sid,
        label: claims.token_label,
    }))
}

fn bearer_credential(headers: &HeaderMap) -> Option<&str> {
    if headers.get_all(AUTHORIZATION).iter().count() != 1 {
        return None;
    }
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer")
        || token.is_empty()
        || token.len() > MAX_CREDENTIAL_BYTES
        || !token.bytes().all(|b| b.is_ascii_graphic())
    {
        return None;
    }
    Some(token)
}

async fn query(
    State(executor): State<QueryExecutor>,
    Extension(holder): Extension<Option<TokenHolder>>,
    body: Result<Json<QueryRequest>, JsonRejection>,
) -> Result<Response, CanonicalError> {
    let Json(request) = body.map_err(|error| {
        if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
            oversized_input("body", "Request body exceeds limit")
        } else {
            invalid_request("Expected a JSON object containing only a sql string")
        }
    })?;
    let bytes = executor
        .query(request.sql, holder.as_ref(), |result| {
            serde_json::to_vec(&result)
        })
        .await
        .map_err(|error| query_error(&error))?;
    Ok(([(CONTENT_TYPE, "application/json")], bytes).into_response())
}

fn invalid_request(reason: &str) -> CanonicalError {
    SqlQueryError::invalid_argument()
        .with_field_violation("sql", reason, "INVALID")
        .create()
}

fn oversized_input(field: &str, reason: &str) -> CanonicalError {
    SqlQueryError::invalid_argument()
        .with_field_violation(field, reason, "TOO_LARGE")
        .with_override(Http::status_code(413))
        .create()
}

fn query_error(error: &QueryFailure) -> CanonicalError {
    match error {
        QueryFailure::InvalidSql(_) => invalid_request(&error.public_message()),
        QueryFailure::SqlTooLarge => oversized_input("sql", &error.public_message()),
        QueryFailure::Busy | QueryFailure::ResultTooLarge | QueryFailure::ResourceLimit => {
            SqlQueryError::resource_exhausted("Query exceeded resource limits")
                .with_quota_violation("sql_explorer", error.public_message())
                .create()
        }
        QueryFailure::Timeout => SqlQueryError::deadline_exceeded("Query timed out").create(),
        QueryFailure::ClickHouse(_)
        | QueryFailure::InvalidResponse(_)
        | QueryFailure::ProcessingTask(_) => {
            CanonicalError::internal("query execution failed").create()
        }
    }
}
