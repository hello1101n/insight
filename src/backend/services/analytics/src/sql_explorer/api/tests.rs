use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use axum::routing::post;
use secrecy::SecretString;
use serde_json::{Value, json};
use tower::ServiceExt as _;

use super::*;
use crate::jwt_verifier::test_keys::{
    SigningMaterial, sign, signing_material, spawn_app, spawn_jwks,
};

const TOKEN: &str = "synthetic-test-token-not-a-real-secret";
const ISSUER: &str = "https://gateway.example.test";
const AUDIENCE: &str = "sql-api";
const UNREACHABLE_JWKS: &str = "http://127.0.0.1:1/.well-known/jwks.json";
type R = Result<(), Box<dyn std::error::Error>>;

fn config() -> SqlApiConfig {
    SqlApiConfig {
        enabled: true,
        token: SecretString::from(TOKEN.to_owned()),
        jwt_issuer: ISSUER.to_owned(),
        jwt_audience: AUDIENCE.to_owned(),
    }
}

fn app_with_jwks(url: &str, capacity: usize, jwks_url: &str) -> anyhow::Result<Router> {
    let client = insight_clickhouse::Client::new(insight_clickhouse::Config::new(url, "gold"));
    let verifier = JwksVerifier::new(ISSUER, AUDIENCE, jwks_url)?;
    Ok(router(
        &config(),
        verifier,
        QueryExecutor::new(client, capacity),
    ))
}

fn app(url: &str, capacity: usize) -> anyhow::Result<Router> {
    app_with_jwks(url, capacity, UNREACHABLE_JWKS)
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
        let response = send(app("http://127.0.0.1:1", 1)?, token, "{}").await?;
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
        let response = send(app("http://127.0.0.1:1", 1)?, Some(&auth), body).await?;
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
        app(&format!("http://{address}"), 1)?,
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
            app("http://127.0.0.1:1", capacity)?,
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
            app("http://127.0.0.1:1", 1)?,
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
            app(&format!("http://{address}"), 1)?,
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

const NOW_PLUS: u64 = 600;

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

fn sql_claims() -> Value {
    let now = now();
    json!({
        "sub": "11111111-1111-4111-8111-111111111111",
        "tenant_id": "22222222-2222-4222-8222-222222222222",
        "roles": "sql_api",
        "sub_type": "sql_token",
        "sid": "33333333-3333-4333-8333-333333333333",
        "token_label": "synthetic-label",
        "iss": ISSUER,
        "aud": AUDIENCE,
        "iat": now,
        "exp": now + NOW_PLUS,
        "jti": "44444444-4444-4444-8444-444444444444",
    })
}

fn with(mut claims: Value, changes: &Value) -> Value {
    if let (Some(target), Some(changes)) = (claims.as_object_mut(), changes.as_object()) {
        for (key, value) in changes {
            target.insert(key.clone(), value.clone());
        }
    }
    claims
}

async fn spawn_upstream() -> anyhow::Result<(String, tokio::task::JoinHandle<()>)> {
    spawn_app(Router::new().route(
        "/",
        post(|| async {
            Json(json!({"meta":[{"name":"answer","type":"UInt8"}],"data":[{"answer":1}]}))
        }),
    ))
    .await
}

async fn body_of(response: Response) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    Ok(to_bytes(response.into_body(), 4096).await?.to_vec())
}

const QUERY: &str = r#"{"sql":"SELECT 1 AS answer"}"#;

#[tokio::test]
async fn a_personal_token_jwt_returns_the_instance_token_body() -> R {
    let material = signing_material()?;
    let (jwks, jwks_server) = spawn_jwks(&material).await?;
    let (upstream, upstream_server) = spawn_upstream().await?;
    let jwks_url = format!("{jwks}/.well-known/jwks.json");
    let jwt = sign(&material, &sql_claims())?;

    let personal = send(
        app_with_jwks(&upstream, 1, &jwks_url)?,
        Some(&format!("Bearer {jwt}")),
        QUERY,
    )
    .await?;
    let instance = send(
        app_with_jwks(&upstream, 1, &jwks_url)?,
        Some(&format!("Bearer {TOKEN}")),
        QUERY,
    )
    .await?;

    assert_eq!(personal.status(), StatusCode::OK);
    assert_eq!(instance.status(), StatusCode::OK);
    assert_eq!(personal.headers()[CACHE_CONTROL], "no-store");
    assert_eq!(body_of(personal).await?, body_of(instance).await?);
    jwks_server.abort();
    upstream_server.abort();
    Ok(())
}

fn rejected_credentials(material: &SigningMaterial) -> anyhow::Result<Vec<(&'static str, String)>> {
    let stranger = signing_material()?;
    let mcp_audience = format!("{ISSUER}/mcp");
    let stale = now().saturating_sub(3600);
    Ok(vec![
        (
            "session jwt",
            sign(
                material,
                &with(
                    sql_claims(),
                    &json!({"aud": "internal-services", "sub_type": "user", "roles": "admin"}),
                ),
            )?,
        ),
        (
            "service jwt",
            sign(
                material,
                &with(
                    sql_claims(),
                    &json!({"aud": "internal-services", "sub_type": "service"}),
                ),
            )?,
        ),
        (
            "mcp access token",
            sign(
                material,
                &with(
                    sql_claims(),
                    &json!({"aud": mcp_audience, "sub_type": "user", "roles": "admin", "scope": "openid mcp:query"}),
                ),
            )?,
        ),
        (
            "right audience, wrong sub_type",
            sign(material, &with(sql_claims(), &json!({"sub_type": "user"})))?,
        ),
        (
            "wrong issuer",
            sign(
                material,
                &with(sql_claims(), &json!({"iss": "https://other.example.test"})),
            )?,
        ),
        (
            "expired",
            sign(
                material,
                &with(sql_claims(), &json!({"iat": stale, "exp": stale + 60})),
            )?,
        ),
        ("bad signature", sign(&stranger, &sql_claims())?),
        ("garbage", "not.a.jwt".to_owned()),
    ])
}

#[tokio::test]
async fn every_other_jwt_gets_the_bad_instance_token_response() -> R {
    let material = signing_material()?;
    let (jwks, jwks_server) = spawn_jwks(&material).await?;
    let jwks_url = format!("{jwks}/.well-known/jwks.json");
    let baseline = send(
        app_with_jwks("http://127.0.0.1:1", 1, &jwks_url)?,
        Some("Bearer wrong"),
        QUERY,
    )
    .await?;
    let baseline_status = baseline.status();
    let baseline_challenge = baseline.headers()[WWW_AUTHENTICATE].clone();
    let baseline_body = body_of(baseline).await?;
    assert_eq!(baseline_status, StatusCode::UNAUTHORIZED);

    for (case, jwt) in rejected_credentials(&material)? {
        let response = send(
            app_with_jwks("http://127.0.0.1:1", 1, &jwks_url)?,
            Some(&format!("Bearer {jwt}")),
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
    jwks_server.abort();
    Ok(())
}

#[tokio::test]
async fn an_unreachable_jwks_fails_a_jwt_with_503_and_spares_the_instance_token() -> R {
    let material = signing_material()?;
    let (upstream, upstream_server) = spawn_upstream().await?;
    let jwt = sign(&material, &sql_claims())?;

    let personal = send(app(&upstream, 1)?, Some(&format!("Bearer {jwt}")), QUERY).await?;
    let instance = send(app(&upstream, 1)?, Some(&format!("Bearer {TOKEN}")), QUERY).await?;
    let garbage = send(app(&upstream, 1)?, Some("Bearer not.a.jwt"), QUERY).await?;

    assert_eq!(personal.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(personal.headers()[CACHE_CONTROL], "no-store");
    let problem: Value = serde_json::from_slice(&body_of(personal).await?)?;
    assert_eq!(problem["status"], 503);
    assert!(problem["title"].is_string(), "{problem}");
    assert!(!problem.to_string().contains("127.0.0.1"), "{problem}");
    assert_eq!(instance.status(), StatusCode::OK);
    assert_eq!(garbage.status(), StatusCode::UNAUTHORIZED);
    upstream_server.abort();
    Ok(())
}

fn captured_query_log(
    token: impl FnOnce(&str) -> String,
    material: &SigningMaterial,
    failing: bool,
) -> anyhow::Result<String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let mut outcome = Ok(());
    let output = insight_log_context::test_support::capture_output(|| {
        outcome = runtime.block_on(async {
            let (jwks, jwks_server) = spawn_jwks(material).await?;
            let (upstream, upstream_server) = spawn_upstream().await?;
            let upstream = if failing {
                "http://127.0.0.1:1".to_owned()
            } else {
                upstream
            };
            let app = app_with_jwks(&upstream, 1, &format!("{jwks}/.well-known/jwks.json"))?;
            let response = send(app, Some(&format!("Bearer {}", token(TOKEN))), QUERY)
                .await
                .map_err(|error| anyhow::anyhow!("{error}"))?;
            anyhow::ensure!(response.status() != StatusCode::UNAUTHORIZED);
            jwks_server.abort();
            upstream_server.abort();
            Ok::<_, anyhow::Error>(())
        });
    });
    outcome?;
    Ok(output)
}

#[test]
fn completed_and_failed_lines_name_the_person_for_personal_tokens_only() -> R {
    let material = signing_material()?;
    let jwt = sign(&material, &sql_claims())?;

    for failing in [false, true] {
        let personal = captured_query_log(|_| jwt.clone(), &material, failing)?;
        let instance = captured_query_log(str::to_owned, &material, failing)?;

        let message = if failing {
            "SQL explorer query failed"
        } else {
            "SQL explorer query completed"
        };
        assert!(personal.contains(message), "{personal}");
        assert!(
            personal.contains("11111111-1111-4111-8111-111111111111"),
            "{personal}"
        );
        assert!(personal.contains("\"person_id\""), "{personal}");
        assert!(personal.contains("synthetic-label"), "{personal}");
        assert!(
            personal.contains("33333333-3333-4333-8333-333333333333"),
            "{personal}"
        );
        assert!(!personal.contains(&jwt), "the jwt leaked: {personal}");

        assert!(instance.contains(message), "{instance}");
        for field in ["person_id", "token_label", "token_id"] {
            assert!(!instance.contains(field), "{field} in {instance}");
        }
        assert!(!instance.contains(TOKEN), "the token leaked: {instance}");
    }
    Ok(())
}
