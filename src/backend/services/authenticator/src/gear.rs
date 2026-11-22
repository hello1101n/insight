use std::path::Path;
use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use authenticator_sdk::AuthenticatorClientV1;
use sea_orm::DatabaseConnection;
use secrecy::ExposeSecret as _;
use tokio_util::sync::CancellationToken;
use toolkit::api::OpenApiRegistry;
use toolkit::{Gear, GearCtx, RestApiCapability, RunnableCapability};

use crate::api::{self, AppState};
use crate::config::{AuthenticatorConfig, extract_gear_config};
use crate::identity::{IdentityPersonResolver, PersonResolver};
use crate::issuers::IssuerSelector;
use crate::jwt::KeyStore;
use crate::local_client::LocalClient;
use crate::mcp_oauth::McpOAuthStore;
use crate::service_token::{self, ServiceRegistry};
use crate::session::SessionManager;

#[toolkit::gear(
    name = "authenticator",
    deps = [types_registry],
    capabilities = [rest, stateful]
)]
pub struct AuthenticatorGear {
    state: OnceLock<Arc<AppState>>,
}

impl Default for AuthenticatorGear {
    fn default() -> Self {
        Self {
            state: OnceLock::new(),
        }
    }
}

#[async_trait]
impl Gear for AuthenticatorGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: AuthenticatorConfig = ctx.config_or_default()?;
        cfg.validate()?;
        tracing::info!(
            gateway_issuer = %cfg.gateway_issuer,
            idp_issuer = %cfg.idp.issuer_url,
            idp_hosts = cfg.idp.hosts.len(),
            "starting authenticator gear"
        );

        let keystore = Arc::new(KeyStore::load(Path::new(&cfg.signing_keys_path))?);

        let sessions = SessionManager::connect(&cfg.redis_url).await?;
        sessions.ping().await?;
        let mcp_oauth = McpOAuthStore::connect(&cfg.redis_url).await?;

        let oidc = IssuerSelector::build(&cfg)?;
        let resolver: Arc<dyn PersonResolver> = Arc::new(IdentityPersonResolver::new(
            &cfg.identity_url,
            keystore.clone(),
            cfg.gateway_issuer.clone(),
            cfg.jwt_audience.clone(),
            cfg.idp.source_type.clone(),
        )?);

        let service_registry = ServiceRegistry::build(&cfg.service_tokens)?;
        tracing::info!(
            services = cfg.service_tokens.services.len(),
            token_bind = %cfg.service_tokens.token_bind_addr,
            "service-token registry loaded"
        );

        let authn_client: Arc<dyn AuthenticatorClientV1> =
            Arc::new(LocalClient::new(sessions.clone()));
        ctx.client_hub()
            .register::<dyn AuthenticatorClientV1>(authn_client.clone());

        let audit = crate::audit::AuditEmitter::new(
            &cfg.audit.brokers,
            &cfg.audit.topic,
            cfg.audit.retention_ms,
        )?;

        let sql_tokens_db = connect_sql_tokens_db(&cfg).await?;
        tracing::info!(enabled = sql_tokens_db.is_some(), "personal SQL tokens");

        let state = Arc::new(AppState {
            cfg,
            sessions,
            keystore,
            oidc,
            resolver,
            service_registry,
            authn_client,
            audit,
            mcp_oauth,
            sql_tokens_db,
        });
        self.state
            .set(state)
            .map_err(|_| anyhow::anyhow!("authenticator gear already initialized"))?;

        Ok(())
    }
}

impl RestApiCapability for AuthenticatorGear {
    fn register_rest(
        &self,
        _ctx: &GearCtx,
        router: axum::Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<axum::Router> {
        let state = self
            .state
            .get()
            .ok_or_else(|| anyhow::anyhow!("authenticator gear not initialized"))?
            .clone();
        Ok(api::register_routes(router, openapi, state))
    }
}

#[async_trait]
impl RunnableCapability for AuthenticatorGear {
    async fn start(&self, cancel: CancellationToken) -> anyhow::Result<()> {
        // `start` must return promptly — the host awaits it before starting the next gear.
        let state = self
            .state
            .get()
            .ok_or_else(|| anyhow::anyhow!("authenticator gear not initialized"))?
            .clone();
        service_token::spawn(state.clone(), cancel.clone()).await?;
        crate::refresher::spawn(state.clone(), cancel.clone());
        crate::janitor::spawn(state, cancel);
        tracing::info!(
            "authenticator runnable: service-token listener + idp refresher + janitor started"
        );
        Ok(())
    }

    async fn stop(&self, _deadline_token: CancellationToken) -> anyhow::Result<()> {
        Ok(())
    }
}

async fn connect_sql_tokens_db(
    cfg: &AuthenticatorConfig,
) -> anyhow::Result<Option<DatabaseConnection>> {
    match cfg.sql_tokens_database_url()? {
        Some(url) => Ok(Some(
            crate::sql_tokens::db::connect_lazy(url.expose_secret()).await?,
        )),
        None => Ok(None),
    }
}

pub(crate) async fn run_migrate(app: &toolkit::bootstrap::AppConfig) -> anyhow::Result<()> {
    let cfg = extract_gear_config(app)?;
    let Some(url) = cfg.sql_tokens_database_url()? else {
        tracing::info!("database_url is empty, personal SQL tokens are off, nothing to migrate");
        return Ok(());
    };

    insight_migration::with_migration_session(
        url.expose_secret(),
        crate::sql_tokens::db::MIGRATION_LOCK,
        crate::sql_tokens::db::MIGRATION_LOCK_TIMEOUT,
        |db| async move {
            use sea_orm_migration::MigratorTrait as _;
            crate::migration::Migrator::up(&db, None).await?;
            Ok(())
        },
    )
    .await?;
    tracing::info!("migrations complete");
    Ok(())
}

#[cfg(test)]
mod tests {
    use secrecy::SecretString;

    use super::*;

    #[tokio::test]
    async fn a_database_url_to_a_closed_port_still_yields_a_pool() -> anyhow::Result<()> {
        let cfg = AuthenticatorConfig {
            database_url: SecretString::from("mysql://u:p@127.0.0.1:1/authenticator"),
            ..AuthenticatorConfig::default()
        };

        let db = connect_sql_tokens_db(&cfg).await?;

        assert!(db.is_some());
        Ok(())
    }

    #[tokio::test]
    async fn migrating_with_an_empty_database_url_succeeds_without_connecting() -> anyhow::Result<()>
    {
        let mut app = toolkit::bootstrap::AppConfig::default();
        app.gears.insert(
            "authenticator".to_owned(),
            serde_json::json!({"config": {}}),
        );

        run_migrate(&app).await
    }

    #[tokio::test]
    async fn an_empty_database_url_leaves_sql_tokens_off() -> anyhow::Result<()> {
        let db = connect_sql_tokens_db(&AuthenticatorConfig::default()).await?;

        assert!(db.is_none());
        Ok(())
    }

    #[tokio::test]
    async fn the_pool_to_a_closed_port_fails_a_query_fast() -> anyhow::Result<()> {
        use sea_orm::ConnectionTrait as _;

        let cfg = AuthenticatorConfig {
            database_url: SecretString::from("mysql://u:p@127.0.0.1:1/authenticator"),
            ..AuthenticatorConfig::default()
        };
        let db = connect_sql_tokens_db(&cfg)
            .await?
            .ok_or_else(|| anyhow::anyhow!("pool missing"))?;

        let started = std::time::Instant::now();
        let outcome = db.execute_unprepared("SELECT 1").await;

        assert!(outcome.is_err());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        Ok(())
    }
}
