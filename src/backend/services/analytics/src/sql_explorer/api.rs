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

use super::executor::{
    MAX_REQUEST_BODY_BYTES, QueryCaller, QueryExecutor, QueryFailure, TokenHolder,
};
use crate::config::SqlApiConfig;
use crate::jwt_verifier::{JwksVerifier, VerifyFailure};

const SQL_TOKEN_SUB_TYPE: &str = "sql_token";
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
    verifier: JwksVerifier,
}

#[derive(Debug, Deserialize)]
struct SqlTokenClaims {
    sub: String,
    sub_type: String,
    sid: String,
    token_label: String,
}

pub(super) fn router(
    config: &SqlApiConfig,
    verifier: JwksVerifier,
    executor: QueryExecutor,
) -> Router {
    let state = AuthState {
        token_hash: Sha256::digest(config.token.expose_secret().as_bytes()),
        verifier,
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
        Ok(caller) => {
            request.extensions_mut().insert(caller);
            next.run(request).await
        }
        Err(VerifyFailure::Unauthorized) => {
            let mut response = CanonicalError::unauthenticated()
                .with_reason("INVALID_INSTANCE_TOKEN")
                .create()
                .into_response();
            response
                .headers_mut()
                .insert(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
            response
        }
        Err(VerifyFailure::Unavailable) => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn identify(state: &AuthState, headers: &HeaderMap) -> Result<QueryCaller, VerifyFailure> {
    let token = bearer_credential(headers).ok_or(VerifyFailure::Unauthorized)?;
    if constant_time_eq(&Sha256::digest(token.as_bytes()), &state.token_hash) {
        return Ok(QueryCaller::InstanceToken);
    }
    let claims = state.verifier.verify::<SqlTokenClaims>(token).await?;
    if claims.sub_type != SQL_TOKEN_SUB_TYPE {
        return Err(VerifyFailure::Unauthorized);
    }
    Ok(QueryCaller::PersonalToken(TokenHolder {
        person_id: claims.sub,
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
    Extension(caller): Extension<QueryCaller>,
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
        .query(request.sql, &caller, |result| serde_json::to_vec(&result))
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
