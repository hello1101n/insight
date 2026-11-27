use std::time::Duration;

use async_trait::async_trait;
use uuid::Uuid;

use crate::config::GearConfig;
use crate::domain::sync_service::{
    LayoutChange, SyncError, SyncJournal, TenantReport, TenantResult, publish_layout, sync_tenants,
    tenants_to_sync,
};
use crate::infra::db::{self, ops_repo, persons_log_repo::MariaDbPersonsLogReader};
use crate::infra::identity_persons::ClickHouseIdentityPersonsWriter;
use crate::seed_runner::SYSTEM_AUTHOR;

const TENANT_TIMEOUT: Duration = Duration::from_mins(15);

const ZOMBIE_CUTOFF_HOURS: i64 = 1;

const LOCK_WAIT_SECS: u32 = 15;

#[derive(Debug)]
pub enum SyncRunError {
    LockBusy,
    Guard(String),
    Failed(anyhow::Error),
}

impl From<anyhow::Error> for SyncRunError {
    fn from(e: anyhow::Error) -> Self {
        Self::Failed(e)
    }
}

impl From<SyncError> for SyncRunError {
    fn from(e: SyncError) -> Self {
        match e {
            SyncError::EmptyLog(msg) => Self::Guard(msg),
            SyncError::Failed(e) => Self::Failed(e),
        }
    }
}

#[derive(Debug)]
pub struct RunReport {
    pub tenants: Vec<TenantReport>,
}

pub async fn run(config: &GearConfig, force: bool) -> Result<RunReport, SyncRunError> {
    let db = db::connect(&config.database_url).await?;
    db::assert_schema_compatible(&db).await?;

    let Some(lock) = db::SyncLockGuard::acquire(&config.database_url, LOCK_WAIT_SECS).await? else {
        return Err(SyncRunError::LockBusy);
    };

    let result = run_locked(&db, config, force).await;

    lock.release().await;
    result.and_then(verdict)
}

async fn run_locked(
    db: &sea_orm::DatabaseConnection,
    config: &GearConfig,
    force: bool,
) -> Result<RunReport, SyncRunError> {
    let cutoff = chrono::Utc::now().naive_utc() - chrono::Duration::hours(ZOMBIE_CUTOFF_HOURS);
    match ops_repo::sweep_zombies(db, cutoff).await {
        Ok(n) if n > 0 => tracing::warn!(swept = n, "persons-sync: reclaimed zombie operations"),
        Ok(_) => {}
        Err(e) => tracing::error!(error = %e, "persons-sync: zombie sweep failed"),
    }

    let reader = MariaDbPersonsLogReader::new(db);
    let writer = ClickHouseIdentityPersonsWriter::connect(
        &config.clickhouse_url,
        &config.clickhouse_user,
        &config.clickhouse_password,
        config.topology(),
    );
    let now = || chrono::Utc::now().naive_utc();

    let tenants = tenants_to_sync(&reader, force).await?;
    if tenants.is_empty() {
        tracing::warn!("persons-sync: the persons log is empty. The sync published nothing");
        return Ok(RunReport {
            tenants: Vec::new(),
        });
    }

    let layout_timeout = layout_timeout(tenants.len());
    ensure_layout(&reader, &writer, now(), layout_timeout).await?;

    let journal = OpsJournal {
        db,
        request_json: serde_json::json!({ "trigger": "cli", "force": force }).to_string(),
        force,
    };
    let tenants = sync_tenants(
        &reader,
        &writer,
        &journal,
        &tenants,
        now,
        force,
        TENANT_TIMEOUT,
    )
    .await;

    // INVARIANT: a replace can expose a stale quorum record; this check heals it.
    ensure_layout(&reader, &writer, now(), layout_timeout).await?;
    Ok(RunReport { tenants })
}

fn layout_timeout(tenants: usize) -> Duration {
    let tenants = u32::try_from(tenants).unwrap_or(u32::MAX);
    TENANT_TIMEOUT.saturating_mul(tenants.saturating_add(1))
}

async fn ensure_layout(
    reader: &MariaDbPersonsLogReader<'_>,
    writer: &ClickHouseIdentityPersonsWriter,
    now: chrono::NaiveDateTime,
    timeout: Duration,
) -> Result<(), SyncRunError> {
    let layout = tokio::time::timeout(timeout, publish_layout(reader, writer, now))
        .await
        .map_err(|_| {
            anyhow::anyhow!(
                "persons-sync: the layout publish timed out after {}s",
                timeout.as_secs()
            )
        })??;
    match layout {
        LayoutChange::Kept => {}
        LayoutChange::Republished { rows } => tracing::info!(
            rows,
            "persons-sync: published one full snapshot in the partitioned layout"
        ),
    }
    Ok(())
}

fn verdict(report: RunReport) -> Result<RunReport, SyncRunError> {
    let failed: Vec<String> = report
        .tenants
        .iter()
        .filter(|t| matches!(t.result, TenantResult::Failed(_)))
        .map(|t| t.tenant.to_string())
        .collect();
    if !failed.is_empty() {
        return Err(SyncRunError::Failed(anyhow::anyhow!(
            "persons-sync failed for {} of {} tenants: {}",
            failed.len(),
            report.tenants.len(),
            failed.join(", ")
        )));
    }

    let refused: Vec<String> = report
        .tenants
        .iter()
        .filter_map(|t| match &t.result {
            TenantResult::Refused(msg) => Some(format!("{}: {msg}", t.tenant)),
            TenantResult::Synced(_) | TenantResult::Failed(_) => None,
        })
        .collect();
    if !refused.is_empty() {
        return Err(SyncRunError::Guard(refused.join("; ")));
    }
    Ok(report)
}

struct OpsJournal<'a> {
    db: &'a sea_orm::DatabaseConnection,
    request_json: String,
    force: bool,
}

#[async_trait]
impl SyncJournal for OpsJournal<'_> {
    async fn open(&self, tenant: Uuid) -> anyhow::Result<Uuid> {
        let operation_id = Uuid::now_v7();
        ops_repo::enqueue(
            self.db,
            operation_id,
            ops_repo::PERSONS_SYNC_OP,
            tenant,
            SYSTEM_AUTHOR,
            Some(&self.request_json),
        )
        .await?;
        ops_repo::try_start(self.db, operation_id).await?;
        tracing::info!(%operation_id, %tenant, force = self.force, "persons-sync: tenant run started");
        Ok(operation_id)
    }

    async fn close(&self, operation_id: Uuid, tenant: Uuid, result: &TenantResult) {
        let recorded = match result {
            TenantResult::Synced(outcome) => {
                tracing::info!(%operation_id, %tenant, ?outcome, "persons-sync: tenant completed");
                let summary_json =
                    serde_json::to_string(outcome).unwrap_or_else(|_| "{}".to_owned());
                ops_repo::complete(self.db, operation_id, &summary_json).await
            }
            TenantResult::Refused(msg) => {
                tracing::warn!(%operation_id, %tenant, %msg, "persons-sync: guard refused the tenant");
                ops_repo::fail(self.db, operation_id, msg).await
            }
            TenantResult::Failed(e) => {
                tracing::error!(
                    %operation_id,
                    %tenant,
                    error = %format!("{e:#}"),
                    "persons-sync: tenant failed. The next run publishes the tenant again"
                );
                ops_repo::fail(self.db, operation_id, "persons-sync failed; see job logs").await
            }
        };
        if let Err(e) = recorded {
            tracing::error!(error = %e, %operation_id, "persons-sync: operation update failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::sync_service::SyncOutcome;

    #[tokio::test]
    async fn default_config_fails_cleanly() {
        let cfg = crate::config::GearConfig::default();
        let err = run(&cfg, false).await;
        assert!(matches!(err, Err(SyncRunError::Failed(_))));
    }

    fn report(results: Vec<TenantResult>) -> RunReport {
        RunReport {
            tenants: results
                .into_iter()
                .map(|result| TenantReport {
                    tenant: Uuid::now_v7(),
                    result,
                })
                .collect(),
        }
    }

    fn current() -> TenantResult {
        TenantResult::Synced(SyncOutcome::AlreadyCurrent { max_id: Some(1) })
    }

    #[test]
    fn one_failed_tenant_fails_the_run() {
        let run = report(vec![
            current(),
            TenantResult::Refused("empty".to_owned()),
            TenantResult::Failed(anyhow::anyhow!("clickhouse unreachable")),
        ]);

        let Err(SyncRunError::Failed(e)) = verdict(run) else {
            panic!("a failed tenant must fail the run");
        };
        assert!(e.to_string().contains("1 of 3 tenants"), "{e}");
    }

    #[test]
    fn a_refused_tenant_without_failures_is_a_guard_refusal() {
        let run = report(vec![current(), TenantResult::Refused("empty".to_owned())]);

        assert!(matches!(verdict(run), Err(SyncRunError::Guard(_))));
    }

    #[test]
    fn synced_tenants_make_a_successful_run() {
        assert!(verdict(report(vec![current(), current()])).is_ok());
    }
}
