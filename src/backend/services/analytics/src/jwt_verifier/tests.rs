use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Json;
use axum::routing::get;
use serde_json::{Value, json};

use super::test_keys::{sign, signing_material, spawn_jwks};
use super::{JwksVerifier, VerifyFailure, decode_failure, resolve_jwks_url};

#[test]
fn jwks_url_prefers_the_configured_value_then_the_public_origin() {
    assert_eq!(
        resolve_jwks_url("http://gateway/keys", "https://insight.example"),
        "http://gateway/keys"
    );
    assert_eq!(
        resolve_jwks_url("  ", "https://insight.example/"),
        "https://insight.example/.well-known/jwks.json"
    );
    assert_eq!(resolve_jwks_url("", ""), "");
}

#[tokio::test]
async fn an_empty_jwks_url_is_unavailable_not_unauthorized() -> anyhow::Result<()> {
    let material = signing_material()?;
    let verifier = JwksVerifier::new("https://issuer.example", "aud", "")?;
    let token = sign(
        &material,
        &json!({"sub": "s", "iss": "https://issuer.example", "aud": "aud", "exp": 4_102_444_800_u64}),
    )?;

    assert!(matches!(
        verifier.verify::<Value>(&token).await,
        Err(VerifyFailure::Unavailable)
    ));
    assert!(matches!(
        verifier.verify::<Value>("garbage").await,
        Err(VerifyFailure::Unauthorized)
    ));
    Ok(())
}

#[tokio::test]
async fn a_valid_token_yields_its_claims() -> anyhow::Result<()> {
    let material = signing_material()?;
    let (origin, server) = spawn_jwks(&material).await?;
    let verifier = JwksVerifier::new(
        "https://issuer.example",
        "aud",
        &format!("{origin}/.well-known/jwks.json"),
    )?;
    let token = sign(
        &material,
        &json!({"sub": "s", "iss": "https://issuer.example", "aud": "aud", "exp": 4_102_444_800_u64}),
    )?;

    let claims: Value = verifier
        .verify(&token)
        .await
        .map_err(|error| anyhow::anyhow!("{error:?}"))?;

    assert_eq!(claims["sub"], "s");
    server.abort();
    Ok(())
}

#[tokio::test]
async fn concurrent_jwks_misses_share_one_refresh() -> anyhow::Result<()> {
    let requests = Arc::new(AtomicUsize::new(0));
    let app = axum::Router::new().route(
        "/.well-known/jwks.json",
        get({
            let requests = requests.clone();
            move || {
                let requests = requests.clone();
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    Json(serde_json::json!({ "keys": [] }))
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let verifier = JwksVerifier::new(
        &format!("http://{address}"),
        "aud",
        &format!("http://{address}/.well-known/jwks.json"),
    )?;

    let (first, second) = tokio::join!(verifier.cached_jwks(), verifier.cached_jwks());

    assert!(first.is_ok());
    assert!(second.is_ok());
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert!(verifier.refresh_jwks(Some("missing-key")).await.is_ok());
    assert!(verifier.refresh_jwks(Some("missing-key")).await.is_ok());
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    server.abort();
    Ok(())
}

#[test]
fn decode_errors_split_backend_outage_from_bad_tokens() {
    use jsonwebtoken::errors::{Error, ErrorKind};
    let outage = Error::from(ErrorKind::Provider("backend down".to_owned()));
    assert!(matches!(
        decode_failure(&outage),
        VerifyFailure::Unavailable
    ));
    for kind in [
        ErrorKind::InvalidSignature,
        ErrorKind::ExpiredSignature,
        ErrorKind::InvalidAlgorithm,
    ] {
        assert!(matches!(
            decode_failure(&Error::from(kind)),
            VerifyFailure::Unauthorized
        ));
    }
}
