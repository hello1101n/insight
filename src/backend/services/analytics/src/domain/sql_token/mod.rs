use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use secrecy::SecretString;
use toolkit_security::crypto::{CryptoError, hash::Sha256, rng};
use uuid::Uuid;

use crate::migration::sql_token_schema;

pub(crate) mod store;

#[cfg(test)]
mod live_tests;
#[cfg(test)]
mod tests;

const TOKEN_PREFIX: &str = "isql_";
const TOKEN_ENTROPY_BYTES: usize = 32;
const TOKEN_BODY_CHARS: usize = 43;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TokenHash([u8; 32]);

impl TokenHash {
    pub(crate) fn of(token: &str) -> Self {
        Self(Sha256::digest(token.as_bytes()))
    }

    pub(crate) fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

#[derive(Debug)]
pub(crate) struct MintedToken {
    pub(crate) token: SecretString,
    pub(crate) hash: TokenHash,
}

pub(crate) fn mint() -> Result<MintedToken, CryptoError> {
    let mut entropy = [0_u8; TOKEN_ENTROPY_BYTES];
    rng::fill(&mut entropy)?;

    let token = format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(entropy));
    let hash = TokenHash::of(&token);

    Ok(MintedToken {
        token: SecretString::from(token),
        hash,
    })
}

pub(crate) fn looks_minted(token: &str) -> bool {
    let Some(body) = token.strip_prefix(TOKEN_PREFIX) else {
        return false;
    };
    body.len() == TOKEN_BODY_CHARS
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TokenLabel(String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum LabelRejected {
    #[error("label must not be empty")]
    Empty,
    #[error("label must be at most {} characters", sql_token_schema::LABEL_CHARS)]
    TooLong,
    #[error("label must not contain control characters")]
    ControlCharacter,
}

impl TokenLabel {
    pub(crate) fn parse(raw: &str) -> Result<Self, LabelRejected> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(LabelRejected::Empty);
        }
        if trimmed.chars().count() > sql_token_schema::LABEL_CHARS {
            return Err(LabelRejected::TooLong);
        }
        if trimmed.chars().any(char::is_control) {
            return Err(LabelRejected::ControlCharacter);
        }
        Ok(Self(trimmed.to_owned()))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TokenHolder {
    pub(crate) person_id: Uuid,
    pub(crate) label: TokenLabel,
}
