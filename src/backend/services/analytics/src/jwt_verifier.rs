use std::sync::Arc;
use std::time::{Duration, Instant};

use jsonwebtoken::errors::ErrorKind;
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode_header};
use serde::de::DeserializeOwned;
use tokio::sync::{Mutex, RwLock};

const MAX_JWKS_BYTES: usize = 1024 * 1024;
const JWKS_REFRESH_COOLDOWN: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub(crate) struct JwksVerifier {
    inner: Arc<JwksVerifierInner>,
}

struct JwksVerifierInner {
    issuer: String,
    audience: String,
    jwks_url: String,
    client: reqwest::Client,
    jwks: RwLock<Option<JwkSet>>,
    jwks_refresh: Mutex<JwksRefresh>,
}

#[derive(Default)]
struct JwksRefresh {
    last_attempt: Option<Instant>,
}

#[derive(Debug)]
pub(crate) enum VerifyFailure {
    Unauthorized,
    Unavailable,
}

pub(crate) fn resolve_jwks_url(jwks_url: &str, public_url: &str) -> String {
    match (jwks_url.trim(), public_url.trim_end_matches('/')) {
        ("", "") => String::new(),
        ("", origin) => format!("{origin}/.well-known/jwks.json"),
        (configured, _) => configured.to_owned(),
    }
}

impl JwksVerifier {
    pub(crate) fn new(issuer: &str, audience: &str, jwks_url: &str) -> anyhow::Result<Self> {
        let client = insight_http_client::client_builder()?
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(5))
            .build()?;
        Ok(Self {
            inner: Arc::new(JwksVerifierInner {
                issuer: issuer.to_owned(),
                audience: audience.to_owned(),
                jwks_url: jwks_url.to_owned(),
                client,
                jwks: RwLock::new(None),
                jwks_refresh: Mutex::new(JwksRefresh::default()),
            }),
        })
    }

    pub(crate) async fn verify<C: DeserializeOwned>(
        &self,
        token: &str,
    ) -> Result<C, VerifyFailure> {
        let header = decode_header(token).map_err(|_| VerifyFailure::Unauthorized)?;
        if header.alg != Algorithm::ES256 {
            return Err(VerifyFailure::Unauthorized);
        }
        let kid = header.kid.ok_or(VerifyFailure::Unauthorized)?;
        let mut jwks = self.cached_jwks().await?;
        if jwks.find(&kid).is_none() {
            jwks = self.refresh_jwks(Some(&kid)).await?;
        }
        let jwk = jwks.find(&kid).ok_or(VerifyFailure::Unauthorized)?;
        let key = DecodingKey::from_jwk(jwk).map_err(|_| VerifyFailure::Unauthorized)?;

        let mut validation = Validation::new(Algorithm::ES256);
        validation.set_issuer(&[self.inner.issuer.as_str()]);
        validation.set_audience(&[self.inner.audience.as_str()]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        toolkit_security::jwt::decode::<C>(token, &key, &validation)
            .map(|data| data.claims)
            .map_err(|error| decode_failure(&error))
    }

    pub(crate) async fn cached_jwks(&self) -> Result<JwkSet, VerifyFailure> {
        if let Some(jwks) = self.inner.jwks.read().await.clone() {
            return Ok(jwks);
        }
        self.refresh_jwks(None).await
    }

    pub(crate) async fn refresh_jwks(
        &self,
        expected_kid: Option<&str>,
    ) -> Result<JwkSet, VerifyFailure> {
        let mut refresh = self.inner.jwks_refresh.lock().await;
        let cached = self.inner.jwks.read().await.clone();
        let cache_satisfies = match expected_kid {
            Some(kid) => cached.as_ref().is_some_and(|jwks| jwks.find(kid).is_some()),
            None => cached.is_some(),
        };
        if cache_satisfies {
            return cached.ok_or(VerifyFailure::Unavailable);
        }
        if refresh
            .last_attempt
            .is_some_and(|attempt| attempt.elapsed() < JWKS_REFRESH_COOLDOWN)
        {
            return cached.ok_or(VerifyFailure::Unavailable);
        }

        refresh.last_attempt = Some(Instant::now());
        // INVARIANT: holding the gate across fetch permits only one JWKS refresh.
        self.fetch_jwks().await
    }

    async fn fetch_jwks(&self) -> Result<JwkSet, VerifyFailure> {
        let response = self
            .inner
            .client
            .get(&self.inner.jwks_url)
            .send()
            .await
            .map_err(|error| {
                tracing::warn!(%error, "could not fetch JWKS");
                VerifyFailure::Unavailable
            })?
            .error_for_status()
            .map_err(|error| {
                tracing::warn!(%error, "JWKS endpoint returned an error");
                VerifyFailure::Unavailable
            })?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_JWKS_BYTES as u64)
        {
            return Err(VerifyFailure::Unavailable);
        }
        let bytes = response.bytes().await.map_err(|error| {
            tracing::warn!(%error, "could not read JWKS response");
            VerifyFailure::Unavailable
        })?;
        if bytes.len() > MAX_JWKS_BYTES {
            return Err(VerifyFailure::Unavailable);
        }
        let jwks = serde_json::from_slice::<JwkSet>(&bytes).map_err(|error| {
            tracing::warn!(%error, "could not parse JWKS response");
            VerifyFailure::Unavailable
        })?;
        *self.inner.jwks.write().await = Some(jwks.clone());
        Ok(jwks)
    }
}

/// A backend outage is not a bad token: `Provider` means the crypto facade
/// could not run, so the caller gets 503, not 401.
fn decode_failure(error: &jsonwebtoken::errors::Error) -> VerifyFailure {
    if matches!(error.kind(), ErrorKind::Provider(_)) {
        tracing::error!(error = %error, "crypto backend unavailable for bearer token");
        VerifyFailure::Unavailable
    } else {
        VerifyFailure::Unauthorized
    }
}

#[cfg(test)]
pub(crate) mod test_keys;

#[cfg(test)]
mod tests;
