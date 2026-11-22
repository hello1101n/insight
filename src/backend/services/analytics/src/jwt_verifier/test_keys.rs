use axum::Json;
use axum::routing::get;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use p256::SecretKey;
use p256::elliptic_curve::Generate as _;
use p256::elliptic_curve::sec1::ToSec1Point as _;
use p256::pkcs8::{EncodePrivateKey as _, LineEnding};
use serde_json::{Value, json};
use tokio::task::JoinHandle;

pub(crate) struct SigningMaterial {
    pub(crate) key: EncodingKey,
    pub(crate) jwks: Value,
}

pub(crate) fn signing_material() -> anyhow::Result<SigningMaterial> {
    let secret = SecretKey::generate();
    let pem = secret.to_pkcs8_pem(LineEnding::LF)?;
    let key = EncodingKey::from_ec_pem(pem.as_bytes())?;
    let point = secret.public_key().to_sec1_point(false);
    let x = point
        .x()
        .ok_or_else(|| anyhow::anyhow!("public key has no x coordinate"))?;
    let y = point
        .y()
        .ok_or_else(|| anyhow::anyhow!("public key has no y coordinate"))?;

    Ok(SigningMaterial {
        key,
        jwks: json!({
            "keys": [{
                "kty": "EC",
                "crv": "P-256",
                "use": "sig",
                "alg": "ES256",
                "kid": "test-key",
                "x": B64.encode(x),
                "y": B64.encode(y),
            }]
        }),
    })
}

pub(crate) fn sign(material: &SigningMaterial, claims: &Value) -> anyhow::Result<String> {
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some("test-key".to_owned());

    Ok(encode(&header, claims, &material.key)?)
}

pub(crate) async fn spawn_app(app: axum::Router) -> anyhow::Result<(String, JoinHandle<()>)> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    Ok((format!("http://{address}"), server))
}

pub(crate) async fn spawn_jwks(
    material: &SigningMaterial,
) -> anyhow::Result<(String, JoinHandle<()>)> {
    let jwks = material.jwks.clone();
    spawn_app(axum::Router::new().route(
        "/.well-known/jwks.json",
        get(move || {
            let jwks = jwks.clone();
            async move { Json(jwks) }
        }),
    ))
    .await
}
