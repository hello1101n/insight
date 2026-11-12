use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use axum::routing::post;
use chrono::Utc;
use sea_orm::{DatabaseBackend, DatabaseConnection, DbErr, MockDatabase};
use secrecy::SecretString;
use serde_json::{Value, json};
use tower::ServiceExt as _;
use uuid::Uuid;

use insight_log_context::test_support::capture_output;

use super::*;
use crate::domain::sql_token::TokenHash;
use crate::infra::db::entities::sql_api_tokens;

const TOKEN: &str = "synthetic-test-token-not-a-real-secret";
const PERSONAL_TOKEN: &str = "isql_synthetic-personal-token-not-a-real-secret0";
const HOLDER: Uuid = Uuid::from_u128(0x5eed_0000_0000_4000_8000_0000_0000_0001);
type R = Result<(), Box<dyn std::error::Error>>;

fn app(url: &str, capacity: usize) -> Router {
    app_with_tokens(url, capacity, no_personal_tokens())
}

fn app_with_tokens(url: &str, capacity: usize, tokens: DatabaseConnection) -> Router {
    let config = SqlApiConfig {
        enabled: true,
        token: SecretString::from(TOKEN.to_owned()),
    };
    let client = insight_clickhouse::Client::new(insight_clickhouse::Config::new(url, "gold"));
    router(&config, QueryExecutor::new(client, capacity), tokens)
}

fn no_personal_tokens() -> DatabaseConnection {
    MockDatabase::new(DatabaseBackend::MySql)
        .append_query_results(vec![Vec::<sql_api_tokens::Model>::new(); 8])
        .into_connection()
}

fn stored_personal_token() -> DatabaseConnection {
    let row = sql_api_tokens::Model {
        id: Uuid::now_v7(),
        insight_tenant_id: Uuid::now_v7(),
        token_hash: TokenHash::of(PERSONAL_TOKEN).as_bytes().to_vec(),
        person_id: HOLDER,
        label: "laptop".to_owned(),
        created_by: Uuid::now_v7(),
        created_at: Utc::now(),
    };
    MockDatabase::new(DatabaseBackend::MySql)
        .append_query_results(vec![vec![row]])
        .into_connection()
}

fn unreachable_token_store() -> DatabaseConnection {
    MockDatabase::new(DatabaseBackend::MySql)
        .append_query_errors(vec![DbErr::Custom("synthetic outage".to_owned()); 4])
        .into_connection()
}

async fn answering_clickhouse()
-> Result<(String, tokio::task::JoinHandle<std::io::Result<()>>), std::io::Error> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let upstream = Router::new().route(
        "/",
        post(|| async {
            Json(json!({"meta":[{"name":"answer","type":"UInt8"}],"data":[{"answer":1}]}))
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await });
    Ok((format!("http://{address}"), server))
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
    assert_eq!(bearer_token(&headers), None);
    Ok(())
}

#[tokio::test]
async fn a_personal_token_reads_the_same_rows_as_the_instance_token() -> R {
    let (url, server) = answering_clickhouse().await?;
    let body = r#"{"sql":"SELECT 1 AS answer"}"#;

    let by_instance = send(app(&url, 1), Some(&format!("Bearer {TOKEN}")), body).await?;
    let by_person = send(
        app_with_tokens(&url, 1, stored_personal_token()),
        Some(&format!("Bearer {PERSONAL_TOKEN}")),
        body,
    )
    .await?;

    assert_eq!(by_instance.status(), StatusCode::OK);
    assert_eq!(by_person.status(), StatusCode::OK);
    assert_eq!(by_person.headers()[CACHE_CONTROL], "no-store");
    let instance_rows = to_bytes(by_instance.into_body(), 4096).await?;
    let person_rows = to_bytes(by_person.into_body(), 4096).await?;
    assert_eq!(person_rows, instance_rows);
    server.abort();
    Ok(())
}

#[tokio::test]
async fn a_token_the_store_does_not_hold_is_unauthenticated() -> R {
    let response = send(
        app("http://127.0.0.1:1", 1),
        Some(&format!("Bearer {PERSONAL_TOKEN}")),
        r#"{"sql":"SELECT 1"}"#,
    )
    .await?;

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response.headers()[WWW_AUTHENTICATE], "Bearer");
    assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
    Ok(())
}

#[tokio::test]
async fn a_failed_token_lookup_is_a_server_error_not_a_refusal() -> R {
    let response = send(
        app_with_tokens("http://127.0.0.1:1", 1, unreachable_token_store()),
        Some(&format!("Bearer {PERSONAL_TOKEN}")),
        r#"{"sql":"SELECT 1"}"#,
    )
    .await?;

    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
    let body = String::from_utf8(to_bytes(response.into_body(), 4096).await?.to_vec())?;
    assert!(!body.contains("synthetic outage"), "leaked: {body}");
    Ok(())
}

#[tokio::test]
async fn the_instance_token_never_waits_on_the_token_store() -> R {
    let response = send(
        app_with_tokens("http://127.0.0.1:1", 1, unreachable_token_store()),
        Some(&format!("Bearer {TOKEN}")),
        "{}",
    )
    .await?;

    assert_eq!(
        response.status(),
        StatusCode::BAD_REQUEST,
        "the instance token must pass authentication with the store down"
    );
    Ok(())
}

#[tokio::test]
async fn malformed_credentials_never_reach_the_token_store() -> R {
    for token in [
        None,
        Some("Basic wrong"),
        Some("Bearer "),
        Some("Bearer two tokens"),
    ] {
        let response = send(
            app_with_tokens("http://127.0.0.1:1", 1, unreachable_token_store()),
            token,
            "{}",
        )
        .await?;
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "credential: {token:?}"
        );
    }
    Ok(())
}

fn logged_while(run: impl AsyncFnOnce() -> R) -> Result<String, Box<dyn std::error::Error>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    // WORKAROUND: with one live dispatcher, tracing-core caches callsite interest from the
    // registering thread; a parallel test without a subscriber would cache `never`.
    let _second_dispatcher = tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default());
    let mut outcome = Ok(());
    let output = capture_output(|| outcome = runtime.block_on(run()));
    outcome?;
    Ok(output)
}

fn line<'a>(output: &'a str, message: &str) -> Option<&'a str> {
    output.lines().find(|line| line.contains(message))
}

#[test]
fn a_personal_token_query_logs_its_holder_and_never_the_token() -> R {
    let output = logged_while(async || {
        let (url, server) = answering_clickhouse().await?;
        let answered = send(
            app_with_tokens(&url, 1, stored_personal_token()),
            Some(&format!("Bearer {PERSONAL_TOKEN}")),
            r#"{"sql":"SELECT 1 AS answer"}"#,
        )
        .await?;
        assert_eq!(answered.status(), StatusCode::OK);
        server.abort();

        let failed = send(
            app_with_tokens("http://127.0.0.1:1", 1, stored_personal_token()),
            Some(&format!("Bearer {PERSONAL_TOKEN}")),
            r#"{"sql":"SELECT 1"}"#,
        )
        .await?;
        assert_eq!(failed.status(), StatusCode::INTERNAL_SERVER_ERROR);
        Ok(())
    })?;

    for message in ["SQL explorer query completed", "SQL explorer query failed"] {
        let Some(logged) = line(&output, message) else {
            panic!("no `{message}` line in {output}");
        };
        assert!(
            logged.contains(&format!(r#""person_id":"{HOLDER}""#)),
            "no holder in: {logged}"
        );
        assert!(
            logged.contains(r#""token_label":"laptop""#),
            "no label in: {logged}"
        );
    }
    assert!(!output.contains(PERSONAL_TOKEN), "leaked token: {output}");
    Ok(())
}

#[test]
fn an_instance_token_query_logs_no_holder() -> R {
    let output = logged_while(async || {
        let (url, server) = answering_clickhouse().await?;
        let answered = send(
            app(&url, 1),
            Some(&format!("Bearer {TOKEN}")),
            r#"{"sql":"SELECT 1 AS answer"}"#,
        )
        .await?;
        assert_eq!(answered.status(), StatusCode::OK);
        server.abort();
        Ok(())
    })?;

    let Some(logged) = line(&output, "SQL explorer query completed") else {
        panic!("no completed line in {output}");
    };
    assert!(!logged.contains("person_id"), "unexpected holder: {logged}");
    assert!(
        !logged.contains("token_label"),
        "unexpected label: {logged}"
    );
    assert!(!output.contains(TOKEN), "leaked token: {output}");
    Ok(())
}

#[tokio::test]
async fn a_bearer_not_shaped_like_a_personal_token_never_reaches_the_store() -> R {
    let response = send(
        app_with_tokens("http://127.0.0.1:1", 1, unreachable_token_store()),
        Some("Bearer synthetic-guess-0123456789abcdef0123456789"),
        r#"{"sql":"SELECT 1"}"#,
    )
    .await?;

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    Ok(())
}

#[tokio::test]
async fn a_token_store_that_never_answers_is_a_server_error_within_the_lookup_bound() -> R {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let silent = tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            held.push(socket);
        }
    });
    let mut options =
        sea_orm::ConnectOptions::new(format!("mysql://synthetic:synthetic@{address}/analytics"));
    options.connect_lazy(true).sqlx_logging(false);
    let store = sea_orm::Database::connect(options).await?;

    let started = std::time::Instant::now();
    let response = send(
        app_with_tokens("http://127.0.0.1:1", 1, store),
        Some(&format!("Bearer {PERSONAL_TOKEN}")),
        r#"{"sql":"SELECT 1"}"#,
    )
    .await?;

    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(10),
        "lookup was not bounded: {:?}",
        started.elapsed()
    );
    silent.abort();
    Ok(())
}
