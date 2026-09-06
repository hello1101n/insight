use secrecy::{ExposeSecret as _, SecretString};
use serde::Deserialize;
use thiserror::Error;

const DEFAULT_CLICKHOUSE_DATABASE: &str = "insight";

#[derive(Debug, Deserialize)]
#[serde(default)]
pub(crate) struct GearConfig {
    pub(crate) clickhouse_url: String,
    pub(crate) clickhouse_database: String,
    pub(crate) clickhouse_user: Option<String>,
    pub(crate) clickhouse_password: Option<SecretString>,
    pub(crate) ingest_token: SecretString,
}

impl Default for GearConfig {
    fn default() -> Self {
        Self {
            clickhouse_url: String::new(),
            clickhouse_database: DEFAULT_CLICKHOUSE_DATABASE.to_owned(),
            clickhouse_user: None,
            clickhouse_password: None,
            ingest_token: SecretString::from(String::new()),
        }
    }
}

#[derive(Debug)]
pub(crate) struct ValidatedConfig {
    clickhouse_url: String,
    clickhouse_database: String,
    clickhouse_user: Option<String>,
    clickhouse_password: Option<SecretString>,
    ingest_token: SecretString,
}

impl ValidatedConfig {
    pub(crate) fn from_app_config(
        app: &toolkit::bootstrap::AppConfig,
    ) -> Result<Self, ConfigLoadError> {
        let raw = app
            .gears
            .get("insight-v3-core")
            .and_then(|gear| gear.get("config"))
            .ok_or(ConfigLoadError::MissingSection)?;
        let config = serde_json::from_value::<GearConfig>(raw.clone())?;

        config.validate().map_err(ConfigLoadError::Invalid)
    }

    pub(crate) fn clickhouse_client(&self) -> insight_clickhouse::Client {
        let mut config =
            insight_clickhouse::Config::new(&self.clickhouse_url, &self.clickhouse_database);
        if let (Some(user), Some(password)) = (
            self.clickhouse_user.as_deref(),
            self.clickhouse_password.as_ref(),
        ) {
            config = config.with_auth(user, password.expose_secret());
        }

        insight_clickhouse::Client::new(config)
    }

    pub(crate) fn ingest_token(&self) -> &SecretString {
        &self.ingest_token
    }
}

impl GearConfig {
    pub(crate) fn validate(self) -> Result<ValidatedConfig, ConfigError> {
        require_non_empty("clickhouse_url", &self.clickhouse_url)?;
        require_non_empty("clickhouse_database", &self.clickhouse_database)?;
        require_non_empty("ingest_token", self.ingest_token.expose_secret())?;
        validate_credentials(
            self.clickhouse_user.as_deref(),
            self.clickhouse_password.as_ref(),
        )?;

        Ok(ValidatedConfig {
            clickhouse_url: self.clickhouse_url,
            clickhouse_database: self.clickhouse_database,
            clickhouse_user: self.clickhouse_user,
            clickhouse_password: self.clickhouse_password,
            ingest_token: self.ingest_token,
        })
    }
}

fn require_non_empty(field: &'static str, value: &str) -> Result<(), ConfigError> {
    if value.trim().is_empty() {
        return Err(ConfigError::Empty(field));
    }

    Ok(())
}

fn validate_credentials(
    user: Option<&str>,
    password: Option<&SecretString>,
) -> Result<(), ConfigError> {
    match (user, password) {
        (None, None) => Ok(()),
        (Some(user), Some(password))
            if !user.trim().is_empty() && !password.expose_secret().is_empty() =>
        {
            Ok(())
        }
        (Some(_), Some(_)) => Err(ConfigError::EmptyCredentials),
        (Some(_), None) | (None, Some(_)) => Err(ConfigError::IncompleteCredentials),
    }
}

#[derive(Debug, Error)]
pub(crate) enum ConfigError {
    #[error("gears.insight-v3-core.config.{0} must not be empty")]
    Empty(&'static str),
    #[error("ClickHouse user and password must both be configured or both omitted")]
    IncompleteCredentials,
    #[error("ClickHouse credentials must not be empty")]
    EmptyCredentials,
}

#[derive(Debug, Error)]
pub(crate) enum ConfigLoadError {
    #[error("missing gears.insight-v3-core.config section")]
    MissingSection,
    #[error("invalid gears.insight-v3-core.config: {0}")]
    Decode(#[from] serde_json::Error),
    #[error("invalid gears.insight-v3-core.config: {0}")]
    Invalid(#[source] ConfigError),
}

#[cfg(test)]
mod tests {
    use secrecy::SecretString;

    use super::*;

    fn valid_config() -> GearConfig {
        GearConfig {
            clickhouse_url: "http://clickhouse.example.test:8123".to_owned(),
            clickhouse_database: "insight".to_owned(),
            clickhouse_user: None,
            clickhouse_password: None,
            ingest_token: SecretString::from("test-ingest-token"),
        }
    }

    #[test]
    fn required_values_must_not_be_empty() {
        for field in ["clickhouse_url", "clickhouse_database", "ingest_token"] {
            let mut config = valid_config();
            match field {
                "clickhouse_url" => config.clickhouse_url.clear(),
                "clickhouse_database" => config.clickhouse_database.clear(),
                "ingest_token" => config.ingest_token = SecretString::from(String::new()),
                _ => unreachable!(),
            }

            assert!(config.validate().is_err(), "empty {field} must be rejected");
        }
    }

    #[test]
    fn secrets_are_redacted_from_debug_output() {
        let mut config = valid_config();
        config.clickhouse_user = Some("writer".to_owned());
        config.clickhouse_password = Some(SecretString::from("database-secret"));

        let rendered = format!("{config:?}");

        assert!(!rendered.contains("test-ingest-token"));
        assert!(!rendered.contains("database-secret"));
    }

    #[test]
    fn credentials_must_be_complete() {
        let mut config = valid_config();
        config.clickhouse_user = Some("writer".to_owned());

        assert!(matches!(
            config.validate(),
            Err(ConfigError::IncompleteCredentials)
        ));
    }
}
