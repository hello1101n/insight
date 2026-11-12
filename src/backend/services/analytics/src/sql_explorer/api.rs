use axum::extract::{DefaultBodyLimit, Request, State, rejection::JsonRejection};
use axum::http::header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, WWW_AUTHENTICATE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use sea_orm::DatabaseConnection;
use secrecy::ExposeSecret as _;
use serde::Deserialize;
use toolkit_canonical_errors::{CanonicalError, Http, resource_error};
use toolkit_security::crypto::constant_time_eq;

use super::executor::{MAX_REQUEST_BODY_BYTES, QueryCaller, QueryExecutor, QueryFailure};
use crate::config::SqlApiConfig;
use crate::domain::sql_token::{TokenHash, store};

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
struct TokenCheck {
    instance: TokenHash,
    personal: DatabaseConnection,
}

pub(super) fn router(
    config: &SqlApiConfig,
    executor: QueryExecutor,
    personal_tokens: DatabaseConnection,
) -> Router {
    let check = TokenCheck {
        instance: TokenHash::of(config.token.expose_secret()),
        personal: personal_tokens,
    };
    Router::new()
        .route("/api/sql/query", post(query))
        .with_state(executor)
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        .layer(middleware::from_fn_with_state(check, authenticate))
}

async fn authenticate(
    State(check): State<TokenCheck>,
    headers: HeaderMap,
    mut request: Request,
    next: Next,
) -> Response {
    let mut response = match caller(&check, &headers).await {
        Ok(Some(caller)) => {
            request.extensions_mut().insert(caller);
            next.run(request).await
        }
        Ok(None) => unauthenticated(),
        Err(error) => error.into_response(),
    };
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn caller(
    check: &TokenCheck,
    headers: &HeaderMap,
) -> Result<Option<QueryCaller>, CanonicalError> {
    let Some(token) = bearer_token(headers) else {
        return Ok(None);
    };

    let hash = TokenHash::of(token);
    if constant_time_eq(hash.as_bytes(), check.instance.as_bytes()) {
        return Ok(Some(QueryCaller::InstanceToken));
    }

    let holder = store::holder(&check.personal, &hash)
        .await
        .map_err(|error| {
            tracing::error!(%error, "personal SQL token lookup failed");
            CanonicalError::internal("failed to verify credentials").create()
        })?;
    Ok(holder.map(QueryCaller::PersonalToken))
}

fn unauthenticated() -> Response {
    let mut response = CanonicalError::unauthenticated()
        .with_reason("INVALID_INSTANCE_TOKEN")
        .create()
        .into_response();
    response
        .headers_mut()
        .insert(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
    response
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    if headers.get_all(AUTHORIZATION).iter().count() != 1 {
        return None;
    }
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer")
        || token.is_empty()
        || token.len() > 1024
        || !token.bytes().all(|b| b.is_ascii_graphic())
    {
        return None;
    }
    Some(token)
}

async fn query(
    State(executor): State<QueryExecutor>,
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
        .query(request.sql, |result| serde_json::to_vec(&result))
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
