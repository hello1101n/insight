use std::sync::Arc;

use authn_resolver_sdk::{
    AuthNResolverClient, AuthNResolverError, AuthenticationResult, ClientCredentialsRequest,
};
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use axum::routing::post;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use secrecy::SecretString;
use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use tower::ServiceExt as _;
use uuid::Uuid;

use super::*;

const TOKEN: &str = "synthetic-test-token-not-a-real-secret";
const PERSON: &str = "11111111-1111-4111-8111-111111111111";
const PERSON_ID: Uuid = Uuid::from_u128(0x1111_1111_1111_4111_8111_1111_1111_1111);
const TENANT_ID: Uuid = Uuid::from_u128(0x2222_2222_2222_4222_8222_2222_2222_2222);
const TOKEN_ID: &str = "33333333-3333-4333-8333-333333333333";
type R = Result<(), Box<dyn std::error::Error>>;
type Verdict = dyn Fn(&str) -> Result<AuthenticationResult, AuthNResolverError> + Send + Sync;

struct Gears(Box<Verdict>);

#[async_trait::async_trait]
impl AuthNResolverClient for Gears {
    async fn authenticate(
        &self,
        bearer_token: &str,
    ) -> Result<AuthenticationResult, AuthNResolverError> {
        (self.0)(bearer_token)
    }

    async fn exchange_client_credentials(
        &self,
        _request: &ClientCredentialsRequest,
    ) -> Result<AuthenticationResult, AuthNResolverError> {
        Err(AuthNResolverError::Internal(
            "not used by the SQL API".to_owned(),
        ))
    }
}

fn refusing() -> Gears {
    Gears(Box::new(|_| {
        Err(AuthNResolverError::Unauthorized("refused".to_owned()))
    }))
}

fn failing(error: fn() -> AuthNResolverError) -> Gears {
    Gears(Box::new(move |_| Err(error())))
}

fn accepting(jwt: String, subject_type: Option<&'static str>) -> Gears {
    Gears(Box::new(move |token| {
        if token != jwt {
            return Err(AuthNResolverError::Unauthorized("unknown".to_owned()));
        }
        let mut builder = SecurityContext::builder()
            .subject_id(PERSON_ID)
            .subject_tenant_id(TENANT_ID)
            .token_scopes(vec!["sql_api".to_owned()]);
        if let Some(subject_type) = subject_type {
            builder = builder.subject_type(subject_type);
        }
        let security_context = builder
            .build()
            .map_err(|error| AuthNResolverError::Internal(error.to_string()))?;
        Ok(AuthenticationResult { security_context })
    }))
}

fn jwt(claims: &Value) -> String {
    format!(
        "{}.{}.c2lnbmF0dXJl",
        URL_SAFE_NO_PAD.encode(r#"{"alg":"ES256","typ":"JWT"}"#),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    )
}

fn api_token_claims() -> Value {
    json!({
        "sub": PERSON,
        "sub_type": "api_token",
        "sid": TOKEN_ID,
        "token_label": "synthetic-label",
    })
}

fn config() -> SqlApiConfig {
    SqlApiConfig {
        enabled: true,
        token: SecretString::from(TOKEN.to_owned()),
    }
}

fn app_with(url: &str, capacity: usize, gears: Gears) -> Router {
    let client = insight_clickhouse::Client::new(insight_clickhouse::Config::new(url, "gold"));
    router(
        &config(),
        Arc::new(gears),
        QueryExecutor::new(client, capacity),
    )
}

fn app(url: &str, capacity: usize) -> Router {
    app_with(url, capacity, refusing())
}

async fn send(
    app: Router,
    token: Option<&str>,
    body: &str,
) -> Result<Response, Box<dyn std::error::Error>> {
    let mut request = Request::post("/api/sql/query").header(CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        request = request.header(AUTHORIZATION, token);
    }
    Ok(app
        .oneshot(request.body(Body::from(body.to_owned()))?)
        .await?)
}

#[tokio::test]
async fn invalid_credentials_never_execute_queries() -> R {
    for token in [
        None,
        Some("Bearer wrong"),
        Some("Basic wrong"),
        Some("Bearer "),
        Some("Bearer two tokens"),
    ] {
        let response = send(app("http://127.0.0.1:1", 1), token, "{}").await?;
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "credential: {token:?}"
        );
        assert_eq!(response.headers()[WWW_AUTHENTICATE], "Bearer");
        assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
    }
    Ok(())
}

#[tokio::test]
async fn request_and_sql_validation_precede_database_calls() -> R {
    let auth = format!("bEaReR {TOKEN}");
    for body in [
        "{}",
        "{",
        r#"{"sql":1}"#,
        r#"{"sql":"SELECT 1","extra":true}"#,
        r#"{"sql":"DROP TABLE gold.events"}"#,
        r#"{"sql":"SELECT 1; SELECT 2"}"#,
    ] {
        let response = send(app("http://127.0.0.1:1", 1), Some(&auth), body).await?;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "body: {body}");
    }
    Ok(())
}

#[tokio::test]
async fn query_returns_the_shared_result_contract() -> R {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let upstream = Router::new().route(
        "/",
        post(|| async {
            Json(json!({"meta":[{"name":"answer","type":"UInt8"}],"data":[{"answer":1}]}))
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await });
    let response = send(
        app(&format!("http://{address}"), 1),
        Some(&format!("Bearer {TOKEN}")),
        r#"{"sql":"SELECT 1 AS answer"}"#,
    )
    .await?;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
    let body: Value = serde_json::from_slice(&to_bytes(response.into_body(), 4096).await?)?;
    assert_eq!(
        body,
        json!({"columns":[{"name":"answer","type":"UInt8"}],"rows":[{"answer":1}],"row_count":1,"truncated":false})
    );
    server.abort();
    Ok(())
}

#[tokio::test]
async fn busy_and_backend_errors_use_generic_http_errors() -> R {
    for (capacity, expected) in [
        (0, StatusCode::TOO_MANY_REQUESTS),
        (1, StatusCode::INTERNAL_SERVER_ERROR),
    ] {
        let response = send(
            app("http://127.0.0.1:1", capacity),
            Some(&format!("Bearer {TOKEN}")),
            r#"{"sql":"SELECT 1"}"#,
        )
        .await?;
        assert_eq!(response.status(), expected);
        let bytes = to_bytes(response.into_body(), 4096).await?;
        let body = String::from_utf8(bytes.to_vec())?;
        assert!(!body.contains("127.0.0.1"));
        assert!(!body.contains(TOKEN));
    }
    Ok(())
}

#[tokio::test]
async fn oversized_requests_are_bounded() -> R {
    for size in [
        super::super::executor::MAX_SQL_BYTES + 1,
        MAX_REQUEST_BODY_BYTES,
    ] {
        let body = json!({"sql":"x".repeat(size)}).to_string();
        let response = send(
            app("http://127.0.0.1:1", 1),
            Some(&format!("Bearer {TOKEN}")),
            &body,
        )
        .await?;
        assert_eq!(
            response.status(),
            StatusCode::PAYLOAD_TOO_LARGE,
            "size: {size}"
        );
        let problem: Value = serde_json::from_slice(&to_bytes(response.into_body(), 4096).await?)?;
        assert_eq!(problem["status"], 413, "size: {size}");
    }
    Ok(())
}

#[tokio::test]
async fn database_exception_codes_map_to_timeout_and_resource_responses() -> R {
    for (code, expected) in [
        (159, StatusCode::GATEWAY_TIMEOUT),
        (209, StatusCode::GATEWAY_TIMEOUT),
        (158, StatusCode::TOO_MANY_REQUESTS),
        (191, StatusCode::TOO_MANY_REQUESTS),
        (201, StatusCode::TOO_MANY_REQUESTS),
        (202, StatusCode::TOO_MANY_REQUESTS),
        (241, StatusCode::TOO_MANY_REQUESTS),
        (290, StatusCode::TOO_MANY_REQUESTS),
        (307, StatusCode::TOO_MANY_REQUESTS),
        (396, StatusCode::TOO_MANY_REQUESTS),
        (9999, StatusCode::INTERNAL_SERVER_ERROR),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let upstream = Router::new().route(
            "/",
            post(move || async move {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Code: {code}. DB::Exception: synthetic-internal-detail"),
                )
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await });
        let response = send(
            app(&format!("http://{address}"), 1),
            Some(&format!("Bearer {TOKEN}")),
            r#"{"sql":"SELECT 1"}"#,
        )
        .await?;
        assert_eq!(response.status(), expected, "code: {code}");
        let bytes = to_bytes(response.into_body(), 4096).await?;
        let problem: Value = serde_json::from_slice(&bytes)?;
        assert_eq!(problem["status"], expected.as_u16(), "code: {code}");
        assert!(!String::from_utf8(bytes.to_vec())?.contains("synthetic-internal-detail"));
        server.abort();
    }
    Ok(())
}

#[test]
fn duplicate_authorization_headers_are_rejected() -> R {
    let mut headers = HeaderMap::new();
    headers.append(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {TOKEN}"))?,
    );
    headers.append(AUTHORIZATION, HeaderValue::from_static("Bearer wrong"));
    assert!(bearer_credential(&headers).is_none());
    Ok(())
}

async fn spawn_upstream() -> anyhow::Result<(String, tokio::task::JoinHandle<()>)> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let upstream = Router::new().route(
        "/",
        post(|| async {
            Json(json!({"meta":[{"name":"answer","type":"UInt8"}],"data":[{"answer":1}]}))
        }),
    );
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, upstream).await;
    });
    Ok((format!("http://{address}"), server))
}

async fn body_of(response: Response) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    Ok(to_bytes(response.into_body(), 4096).await?.to_vec())
}

const QUERY: &str = r#"{"sql":"SELECT 1 AS answer"}"#;

#[tokio::test]
async fn an_api_token_jwt_that_gears_accepts_returns_the_instance_token_body() -> R {
    let (upstream, upstream_server) = spawn_upstream().await?;
    let token = jwt(&api_token_claims());

    let personal = send(
        app_with(&upstream, 1, accepting(token.clone(), Some("api_token"))),
        Some(&format!("Bearer {token}")),
        QUERY,
    )
    .await?;
    let instance = send(app(&upstream, 1), Some(&format!("Bearer {TOKEN}")), QUERY).await?;

    assert_eq!(personal.status(), StatusCode::OK);
    assert_eq!(instance.status(), StatusCode::OK);
    assert_eq!(personal.headers()[CACHE_CONTROL], "no-store");
    assert_eq!(body_of(personal).await?, body_of(instance).await?);
    upstream_server.abort();
    Ok(())
}

#[tokio::test]
async fn a_jwt_gears_refuses_or_that_is_not_an_api_token_gets_the_bad_instance_token_response() -> R
{
    let baseline = send(app("http://127.0.0.1:1", 1), Some("Bearer wrong"), QUERY).await?;
    let baseline_status = baseline.status();
    let baseline_challenge = baseline.headers()[WWW_AUTHENTICATE].clone();
    let baseline_body = body_of(baseline).await?;
    assert_eq!(baseline_status, StatusCode::UNAUTHORIZED);
    let token = jwt(&api_token_claims());
    let incomplete = jwt(&json!({"sub": PERSON, "sub_type": "api_token"}));

    for (case, gears, credential) in [
        ("refused by gears", refusing(), token.clone()),
        (
            "session subject",
            accepting(token.clone(), Some("user")),
            token.clone(),
        ),
        (
            "service subject",
            accepting(token.clone(), Some("service")),
            token.clone(),
        ),
        (
            "no subject type",
            accepting(token.clone(), None),
            token.clone(),
        ),
        (
            "no token id or label",
            accepting(incomplete.clone(), Some("api_token")),
            incomplete.clone(),
        ),
    ] {
        let response = send(
            app_with("http://127.0.0.1:1", 1, gears),
            Some(&format!("Bearer {credential}")),
            QUERY,
        )
        .await?;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "case: {case}");
        assert_eq!(
            response.headers()[WWW_AUTHENTICATE],
            baseline_challenge,
            "case: {case}"
        );
        assert_eq!(
            response.headers()[CACHE_CONTROL],
            "no-store",
            "case: {case}"
        );
        assert_eq!(body_of(response).await?, baseline_body, "case: {case}");
    }
    Ok(())
}

#[tokio::test]
async fn gears_unavailable_fails_a_jwt_with_503_and_spares_the_instance_token() -> R {
    let (upstream, upstream_server) = spawn_upstream().await?;
    let token = jwt(&api_token_claims());
    let errors: [fn() -> AuthNResolverError; 3] = [
        || AuthNResolverError::ServiceUnavailable("starting".to_owned()),
        || AuthNResolverError::NoPluginAvailable,
        || AuthNResolverError::Internal("synthetic-internal-detail".to_owned()),
    ];

    for error in errors {
        let personal = send(
            app_with(&upstream, 1, failing(error)),
            Some(&format!("Bearer {token}")),
            QUERY,
        )
        .await?;
        let instance = send(
            app_with(&upstream, 1, failing(error)),
            Some(&format!("Bearer {TOKEN}")),
            QUERY,
        )
        .await?;

        assert_eq!(personal.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(personal.headers()[CACHE_CONTROL], "no-store");
        let problem: Value = serde_json::from_slice(&body_of(personal).await?)?;
        assert_eq!(problem["status"], 503);
        assert!(problem["title"].is_string(), "{problem}");
        assert!(
            !problem.to_string().contains("synthetic-internal-detail"),
            "{problem}"
        );
        assert_eq!(instance.status(), StatusCode::OK);
    }
    upstream_server.abort();
    Ok(())
}

fn captured_query_log(credential: &str, gears: Gears, failing: bool) -> anyhow::Result<String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let mut outcome = Ok(());
    let output = insight_log_context::test_support::capture_output(|| {
        outcome = runtime.block_on(async {
            let (upstream, upstream_server) = spawn_upstream().await?;
            let upstream = if failing {
                "http://127.0.0.1:1".to_owned()
            } else {
                upstream
            };
            let response = send(
                app_with(&upstream, 1, gears),
                Some(&format!("Bearer {credential}")),
                QUERY,
            )
            .await
            .map_err(|error| anyhow::anyhow!("{error}"))?;
            anyhow::ensure!(response.status() != StatusCode::UNAUTHORIZED);
            upstream_server.abort();
            Ok::<_, anyhow::Error>(())
        });
    });
    outcome?;
    Ok(output)
}

#[test]
fn completed_and_failed_lines_name_the_person_for_api_tokens_only() -> R {
    let token = jwt(&api_token_claims());

    for failing in [false, true] {
        let personal =
            captured_query_log(&token, accepting(token.clone(), Some("api_token")), failing)?;
        let instance = captured_query_log(TOKEN, refusing(), failing)?;

        let message = if failing {
            "SQL explorer query failed"
        } else {
            "SQL explorer query completed"
        };
        assert!(personal.contains(message), "{personal}");
        assert!(personal.contains(PERSON), "{personal}");
        assert!(personal.contains("\"person_id\""), "{personal}");
        assert!(personal.contains("synthetic-label"), "{personal}");
        assert!(personal.contains(TOKEN_ID), "{personal}");
        assert!(!personal.contains(&token), "the jwt leaked: {personal}");

        assert!(instance.contains(message), "{instance}");
        for field in ["person_id", "token_label", "token_id"] {
            assert!(!instance.contains(field), "{field} in {instance}");
        }
        assert!(!instance.contains(TOKEN), "the token leaked: {instance}");
    }
    Ok(())
}
