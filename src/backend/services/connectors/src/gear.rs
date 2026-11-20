use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use secrecy::ExposeSecret;
use toolkit::api::OpenApiRegistry;
use toolkit::{Gear, GearCtx, RestApiCapability, RunnableCapability};

use crate::config::{GearConfig, extract_gear_config};
use crate::{api, infra};

#[derive(Debug, Default)]
#[toolkit::gear(name = "connectors", capabilities = [rest, stateful])]
pub(crate) struct ConnectorsGear {
    state: OnceLock<Arc<api::AppState>>,
}

#[async_trait]
impl Gear for ConnectorsGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let config: GearConfig = ctx.config()?;
        config.validate()?;
        let database_url = config.database_url()?;
        let db = infra::db::connect(database_url.expose_secret()).await?;
        infra::db::assert_schema_compatible(&db).await?;

        let mut ch_config =
            insight_clickhouse::Config::new(&config.clickhouse_url, &config.clickhouse_database)
                .with_query_max_threads(4)
                .with_query_max_memory_bytes(1_610_612_736);
        if !config.clickhouse_user.is_empty() {
            ch_config = ch_config.with_auth(
                &config.clickhouse_user,
                config.clickhouse_password.expose_secret(),
            );
        }
        let mut cluster = if config.cluster.enabled {
            crate::infra::cluster::Cluster::new(
                kube::Client::try_default().await?,
                &config.namespace,
                &config.tenant_id,
            )
        } else {
            crate::infra::cluster::Cluster::disabled()
        }
        .with_reconcile_workflow(config.reconcile_workflow_name);
        cluster.admission_enabled = config.admission_enabled;
        cluster.airbyte_namespace = config.airbyte_namespace;
        cluster.airbyte_reader = config.airbyte_reader;
        cluster.argo_url = config.argo_url;
        cluster.workflow_sa = config.workflow_sa;
        cluster.clickhouse_cluster = config.clickhouse_cluster;
        let state = api::AppState {
            cluster,
            schedule_slots: tokio::sync::Semaphore::new(4),
            db,
            ch: insight_clickhouse::Client::new(ch_config),
            identity: infra::identity::IdentityClient::new(&config.identity_url)?,
        };
        self.state
            .set(Arc::new(state))
            .map_err(|_| anyhow::anyhow!("connectors gear already initialized"))?;
        tracing::info!("starting connectors gear");
        Ok(())
    }
}

impl RestApiCapability for ConnectorsGear {
    fn register_rest(
        &self,
        _ctx: &GearCtx,
        router: axum::Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<axum::Router> {
        let state = self
            .state
            .get()
            .ok_or_else(|| anyhow::anyhow!("connectors gear not initialized"))?;
        Ok(api::register_routes(router, openapi, Arc::clone(state)))
    }
}

#[async_trait]
impl RunnableCapability for ConnectorsGear {
    async fn start(&self, cancel: tokio_util::sync::CancellationToken) -> anyhow::Result<()> {
        let state = self
            .state
            .get()
            .ok_or_else(|| anyhow::anyhow!("connectors has not initialized"))?
            .clone();
        if state.cluster.admission_enabled {
            let listener = tokio::net::TcpListener::bind("0.0.0.0:8089").await?;
            let router = crate::domain::admission::workload::router(state.clone());
            let stop = cancel.clone();
            tokio::spawn(async move {
                if let Err(error) = axum::serve(listener, router)
                    .with_graceful_shutdown(stop.cancelled_owned())
                    .await
                {
                    tracing::error!(%error,"ingestion API stopped");
                }
            });
            tokio::spawn(crate::domain::admission::reconcile::run(state, cancel));
        }
        Ok(())
    }
    async fn stop(
        &self,
        _deadline_token: tokio_util::sync::CancellationToken,
    ) -> anyhow::Result<()> {
        Ok(())
    }
}

pub(crate) async fn run_migrate(app: &toolkit::bootstrap::AppConfig) -> anyhow::Result<()> {
    let config = extract_gear_config(app)?;
    let database_url = config.database_url()?;
    insight_migration::with_migration_session(
        database_url.expose_secret(),
        infra::db::MIGRATION_LOCK,
        infra::db::MIGRATION_LOCK_TIMEOUT,
        |db| async move {
            use sea_orm_migration::MigratorTrait;
            crate::migration::Migrator::up(&db, None).await?;
            Ok(())
        },
    )
    .await?;
    tracing::info!("migrations complete");
    Ok(())
}

pub(crate) fn check_config(app: &toolkit::bootstrap::AppConfig) -> anyhow::Result<()> {
    extract_gear_config(app)?.validate()
}
