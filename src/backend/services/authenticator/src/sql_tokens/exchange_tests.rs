use std::sync::LazyLock;

use axum::body::to_bytes;
use axum::http::StatusCode;
use axum::http::header::CACHE_CONTROL;
use axum::response::Response;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Duration, TimeZone as _, Utc};
use p256::elliptic_curve::Generate as _;
use p256::pkcs8::{EncodePrivateKey as _, LineEnding};
use sea_orm::{DatabaseBackend, DbErr, MockDatabase};
use secrecy::ExposeSecret as _;
use serde_json::Value;
use tokio::sync::Semaphore;
use uuid::Uuid;

use super::entity::sql_api_tokens;
use super::exchange::{ExchangeEnv, respond};
use super::mint;
use crate::config::AuthenticatorConfig;
use crate::jwt::KeyStore;

type R = Result<(), Box<dyn std::error::Error>>;

const TENANT: Uuid = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0010);
const PERSON: Uuid = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0011);
const TOKEN_ID: Uuid = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0012);
const ISSUER: &str = "https://gw.example";

static NOW: LazyLock<DateTime<Utc>> =
    LazyLock::new(|| Utc.timestamp_opt(Utc::now().timestamp(), 0).unwrap());

fn now() -> DateTime<Utc> {
    *NOW
}

fn config() -> AuthenticatorConfig {
    AuthenticatorConfig {
        gateway_issuer: ISSUER.to_owned(),
        ..AuthenticatorConfig::default()
    }
}

fn keystore() -> Result<KeyStore, Box<dyn std::error::Error>> {
    let pem = p256::SecretKey::generate().to_pkcs8_pem(LineEnding::LF)?;
    Ok(KeyStore::from_pem_for_test(&pem)?)
}

fn row(expires_at: DateTime<Utc>) -> sql_api_tokens::Model {
    sql_api_tokens::Model {
        id: TOKEN_ID,
        insight_tenant_id: TENANT,
        token_hash: vec![0; 32],
        person_id: PERSON,
        label: "laptop".to_owned(),
        created_by: Uuid::nil(),
        created_at: now() - Duration::days(1),
        expires_at,
    }
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

fn minted_token() -> Result<String, Box<dyn std::error::Error>> {
    Ok(mint()?.token.expose_secret().to_owned())
}

async fn answer(
    db: Option<&sea_orm::DatabaseConnection>,
    slots: &Semaphore,
    cfg: &AuthenticatorConfig,
    keystore: &KeyStore,
    authorization: Option<&str>,
) -> Response {
    respond(
        &ExchangeEnv {
            db,
            slots,
            keystore,
            cfg,
        },
        authorization,
        now(),
    )
    .await
}

fn cache_control(response: &Response) -> &str {
    response
        .headers()
        .get(CACHE_CONTROL)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
}

fn jwt_of(response: &Response) -> Result<String, Box<dyn std::error::Error>> {
    let header = response
        .headers()
        .get("x-gateway-jwt")
        .ok_or("no X-Gateway-Jwt header")?
        .to_str()?;
    Ok(header
        .strip_prefix("Bearer ")
        .ok_or("X-Gateway-Jwt is not a Bearer value")?
        .to_owned())
}

fn payload(jwt: &str) -> Result<Value, Box<dyn std::error::Error>> {
    let segment = jwt.split('.').nth(1).ok_or("not a JWT")?;
    Ok(serde_json::from_slice(&URL_SAFE_NO_PAD.decode(segment)?)?)
}

#[tokio::test]
async fn a_known_token_is_exchanged_for_a_sql_api_jwt_with_the_decided_claims() -> R {
    let db = MockDatabase::new(DatabaseBackend::MySql)
        .append_query_results([[row(now() + Duration::days(30))]])
        .into_connection();
    let slots = Semaphore::new(8);
    let keystore = keystore()?;
    let cfg = config();
    let token = minted_token()?;

    let response = answer(Some(&db), &slots, &cfg, &keystore, Some(&bearer(&token))).await;

    assert_eq!(response.status(), StatusCode::OK);
    let jwt = jwt_of(&response)?;
    keystore.verify(&jwt, "sql-api")?;
    let claims = payload(&jwt)?;
    let iat = u64::try_from(now().timestamp())?;
    assert_eq!(claims["sub"], PERSON.to_string());
    assert_eq!(claims["tenant_id"], TENANT.to_string());
    assert_eq!(claims["roles"], "sql_api");
    assert_eq!(claims["sub_type"], "sql_token");
    assert_eq!(claims["sid"], TOKEN_ID.to_string());
    assert_eq!(claims["token_label"], "laptop");
    assert_eq!(claims["iss"], ISSUER);
    assert_eq!(claims["aud"], "sql-api");
    assert_eq!(claims["iat"], iat);
    assert_eq!(claims["exp"], iat + cfg.jwt_ttl_seconds);
    assert!(Uuid::parse_str(claims["jti"].as_str().unwrap_or_default()).is_ok());
    assert!(!jwt.contains(&token));
    let body = to_bytes(response.into_body(), 1024).await?;
    assert!(body.is_empty());
    Ok(())
}

#[tokio::test]
async fn the_audience_comes_from_config() -> R {
    let db = MockDatabase::new(DatabaseBackend::MySql)
        .append_query_results([[row(now() + Duration::days(30))]])
        .into_connection();
    let cfg = AuthenticatorConfig {
        sql_api_audience: "custom-sql".to_owned(),
        ..config()
    };
    let keystore = keystore()?;

    let response = answer(
        Some(&db),
        &Semaphore::new(8),
        &cfg,
        &keystore,
        Some(&bearer(&minted_token()?)),
    )
    .await;

    keystore.verify(&jwt_of(&response)?, "custom-sql")?;
    Ok(())
}

#[tokio::test]
async fn the_jwt_never_outlives_the_token() -> R {
    let expires_in = Duration::seconds(100);
    let db = MockDatabase::new(DatabaseBackend::MySql)
        .append_query_results([[row(now() + expires_in)]])
        .into_connection();
    let keystore = keystore()?;
    let cfg = config();

    let response = answer(
        Some(&db),
        &Semaphore::new(8),
        &cfg,
        &keystore,
        Some(&bearer(&minted_token()?)),
    )
    .await;

    let claims = payload(&jwt_of(&response)?)?;
    assert_eq!(
        claims["exp"],
        u64::try_from((now() + expires_in).timestamp())?
    );
    Ok(())
}

#[tokio::test]
async fn cache_control_is_max_age_for_a_long_lived_token_and_no_store_near_expiry() -> R {
    let keystore = keystore()?;
    let cfg = config();

    for (expires_in, expected) in [
        (Duration::days(30), "max-age=30"),
        (Duration::seconds(59), "no-store"),
        (Duration::seconds(60), "no-store"),
        (Duration::seconds(75), "max-age=15"),
    ] {
        let db = MockDatabase::new(DatabaseBackend::MySql)
            .append_query_results([[row(now() + expires_in)]])
            .into_connection();

        let response = answer(
            Some(&db),
            &Semaphore::new(8),
            &cfg,
            &keystore,
            Some(&bearer(&minted_token()?)),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK, "expires in {expires_in}");
        assert_eq!(
            cache_control(&response),
            expected,
            "expires in {expires_in}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_missing_malformed_unknown_or_expired_token_is_a_401_with_no_store() -> R {
    let keystore = keystore()?;
    let cfg = config();
    let slots = Semaphore::new(8);
    let unknown = MockDatabase::new(DatabaseBackend::MySql)
        .append_query_results([Vec::<sql_api_tokens::Model>::new()])
        .into_connection();
    let expired = MockDatabase::new(DatabaseBackend::MySql)
        .append_query_results([[row(now())]])
        .into_connection();
    let untouched = MockDatabase::new(DatabaseBackend::MySql).into_connection();
    let minted = minted_token()?;
    let session_cookie_like = bearer("0123456789abcdef");
    let wrong_scheme = format!("Basic {minted}");
    let bare = minted.clone();
    let truncated = bearer(&minted[..minted.len() - 1]);

    let cases: Vec<(&str, Option<String>, &sea_orm::DatabaseConnection)> = vec![
        ("missing header", None, &untouched),
        ("not a bearer", Some(wrong_scheme), &untouched),
        ("no scheme", Some(bare), &untouched),
        ("wrong prefix", Some(session_cookie_like), &untouched),
        ("truncated", Some(truncated), &untouched),
        ("empty", Some("Bearer ".to_owned()), &untouched),
        ("unknown", Some(bearer(&minted)), &unknown),
        ("expired", Some(bearer(&minted)), &expired),
    ];

    for (name, authorization, db) in cases {
        let response = answer(Some(db), &slots, &cfg, &keystore, authorization.as_deref()).await;

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{name}");
        assert_eq!(cache_control(&response), "no-store", "{name}");
        assert!(response.headers().get("x-gateway-jwt").is_none(), "{name}");
    }
    Ok(())
}

#[tokio::test]
async fn a_malformed_token_never_reaches_the_database() -> R {
    let db = MockDatabase::new(DatabaseBackend::MySql).into_connection();

    let response = answer(
        Some(&db),
        &Semaphore::new(8),
        &config(),
        &keystore()?,
        Some("Bearer isql_short"),
    )
    .await;

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(db.into_transaction_log().is_empty());
    Ok(())
}

#[tokio::test]
async fn the_lookup_is_by_the_hash_of_the_token() -> R {
    let db = MockDatabase::new(DatabaseBackend::MySql)
        .append_query_results([[row(now() + Duration::days(1))]])
        .into_connection();
    let token = minted_token()?;

    answer(
        Some(&db),
        &Semaphore::new(8),
        &config(),
        &keystore()?,
        Some(&bearer(&token)),
    )
    .await;

    let log = format!("{:?}", db.into_transaction_log());
    assert!(!log.contains(&token), "the plain token reached the query");
    Ok(())
}

#[tokio::test]
async fn tokens_off_answers_503() -> R {
    let response = answer(
        None,
        &Semaphore::new(8),
        &config(),
        &keystore()?,
        Some(&bearer(&minted_token()?)),
    )
    .await;

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(response.headers().get("x-gateway-jwt").is_none());
    Ok(())
}

#[tokio::test]
async fn a_failing_database_answers_503_not_401() -> R {
    let db = MockDatabase::new(DatabaseBackend::MySql)
        .append_query_errors([DbErr::Custom("boom".to_owned())])
        .into_connection();

    let response = answer(
        Some(&db),
        &Semaphore::new(8),
        &config(),
        &keystore()?,
        Some(&bearer(&minted_token()?)),
    )
    .await;

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn no_free_lookup_slot_within_two_seconds_answers_503() -> R {
    let db = MockDatabase::new(DatabaseBackend::MySql).into_connection();
    let slots = Semaphore::new(0);
    let started = tokio::time::Instant::now();

    let response = answer(
        Some(&db),
        &slots,
        &config(),
        &keystore()?,
        Some(&bearer(&minted_token()?)),
    )
    .await;

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(started.elapsed(), std::time::Duration::from_secs(2));
    assert!(db.into_transaction_log().is_empty());
    Ok(())
}

#[tokio::test]
async fn a_lookup_returns_its_slot() -> R {
    let db = MockDatabase::new(DatabaseBackend::MySql)
        .append_query_results([[row(now() + Duration::days(1))]])
        .into_connection();
    let slots = Semaphore::new(1);

    answer(
        Some(&db),
        &slots,
        &config(),
        &keystore()?,
        Some(&bearer(&minted_token()?)),
    )
    .await;

    assert_eq!(slots.available_permits(), 1);
    Ok(())
}

pub(crate) const SEEDED_LABEL: &str = "seeded-label-3192";

pub(crate) async fn exchange_outcomes() -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let keystore = keystore()?;
    let cfg = config();
    let slots = Semaphore::new(8);
    let mut tokens = Vec::new();

    let mut labelled = row(now() + Duration::days(1));
    labelled.label = SEEDED_LABEL.to_owned();
    let succeeding = MockDatabase::new(DatabaseBackend::MySql)
        .append_query_results([[labelled]])
        .into_connection();
    let unknown = MockDatabase::new(DatabaseBackend::MySql)
        .append_query_results([Vec::<sql_api_tokens::Model>::new()])
        .into_connection();
    let failing = MockDatabase::new(DatabaseBackend::MySql)
        .append_query_errors([DbErr::Custom("connection reset".to_owned())])
        .into_connection();

    for db in [&succeeding, &unknown, &failing] {
        let token = minted_token()?;
        answer(Some(db), &slots, &cfg, &keystore, Some(&bearer(&token))).await;
        tokens.push(token);
    }
    Ok(tokens)
}
