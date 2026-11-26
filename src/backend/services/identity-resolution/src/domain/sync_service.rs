use std::time::Duration;

use async_trait::async_trait;
use sea_orm::prelude::DateTime;
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct PersonsLogRow {
    pub id: u64,
    pub value_type: String,
    pub insight_source_type: String,
    pub insight_source_id: Uuid,
    pub insight_tenant_id: Uuid,
    pub value_id: Option<String>,
    pub value_full_text: Option<String>,
    pub value: Option<String>,
    pub value_effective: Option<String>,
    pub person_id: Uuid,
    pub author_person_id: Uuid,
    pub reason: Option<String>,
    pub created_at: DateTime,
}

#[async_trait]
pub trait PersonsLogReader: Send + Sync {
    async fn tenants(&self) -> anyhow::Result<Vec<Uuid>>;

    async fn read_all(&self) -> anyhow::Result<Vec<PersonsLogRow>>;

    async fn read_tenant(&self, tenant: Uuid) -> anyhow::Result<Vec<PersonsLogRow>>;

    async fn latest_id(&self, tenant: Uuid) -> anyhow::Result<Option<u64>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    Partitioned,
    Stale,
}

#[async_trait]
pub trait IdentityPersonsWriter: Send + Sync {
    async fn layout(&self) -> anyhow::Result<Layout>;

    async fn replace_all(&self, rows: &[PersonsLogRow], synced_at: DateTime) -> anyhow::Result<()>;

    async fn replace_tenant(
        &self,
        tenant: Uuid,
        rows: &[PersonsLogRow],
        synced_at: DateTime,
    ) -> anyhow::Result<()>;

    async fn published_max_id(&self, tenant: Uuid) -> anyhow::Result<Option<u64>>;
}

#[async_trait]
pub trait SyncJournal: Send + Sync {
    async fn open(&self, tenant: Uuid) -> anyhow::Result<Uuid>;

    async fn close(&self, operation: Uuid, tenant: Uuid, result: &TenantResult);
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum SyncOutcome {
    Published(SyncSummary),
    AlreadyCurrent { max_id: Option<u64> },
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct SyncSummary {
    pub rows: u64,
    pub max_id: Option<u64>,
    pub max_created_at: Option<String>,
    pub synced_at: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum LayoutChange {
    Kept,
    Republished { rows: u64 },
}

#[derive(Debug)]
pub enum TenantResult {
    Synced(SyncOutcome),
    Refused(String),
    Failed(anyhow::Error),
}

#[derive(Debug)]
pub struct TenantReport {
    pub tenant: Uuid,
    pub result: TenantResult,
}

pub enum SyncError {
    EmptyLog(String),
    Failed(anyhow::Error),
}

impl From<anyhow::Error> for SyncError {
    fn from(e: anyhow::Error) -> Self {
        Self::Failed(e)
    }
}

const EMPTY_LOG: &str = "empty-log guard: the persons log has 0 rows. The sync keeps every \
     published partition. Examine database_url. Re-run with --force to accept the empty log; \
     the sync then publishes nothing";

const EMPTY_TENANT_LOG: &str = "empty-log guard: the persons log has 0 rows for this tenant. \
     The sync keeps the published partition of the tenant. Re-run with --force to empty that \
     partition";

pub async fn tenants_to_sync(
    reader: &dyn PersonsLogReader,
    force: bool,
) -> Result<Vec<Uuid>, SyncError> {
    let tenants = reader.tenants().await?;
    if tenants.is_empty() && !force {
        return Err(SyncError::EmptyLog(EMPTY_LOG.to_owned()));
    }
    Ok(tenants)
}

pub async fn publish_layout(
    reader: &dyn PersonsLogReader,
    writer: &dyn IdentityPersonsWriter,
    now: DateTime,
) -> Result<LayoutChange, SyncError> {
    match writer.layout().await? {
        Layout::Partitioned => Ok(LayoutChange::Kept),
        Layout::Stale => {
            let rows = reader.read_all().await?;
            writer.replace_all(&rows, now).await?;
            Ok(LayoutChange::Republished {
                rows: rows.len() as u64,
            })
        }
    }
}

pub async fn sync_tenants(
    reader: &dyn PersonsLogReader,
    writer: &dyn IdentityPersonsWriter,
    journal: &dyn SyncJournal,
    tenants: &[Uuid],
    mut now: impl FnMut() -> DateTime + Send,
    force: bool,
    tenant_timeout: Duration,
) -> Vec<TenantReport> {
    let mut reports = Vec::with_capacity(tenants.len());
    for &tenant in tenants {
        let operation = match journal.open(tenant).await {
            Ok(operation) => operation,
            Err(e) => {
                let result = TenantResult::Failed(e.context("opening the operation record"));
                reports.push(TenantReport { tenant, result });
                continue;
            }
        };

        let sync = run_sync_until_quiescent(reader, writer, tenant, &mut now, force);
        let result = match tokio::time::timeout(tenant_timeout, sync).await {
            Ok(Ok(outcome)) => TenantResult::Synced(outcome),
            Ok(Err(SyncError::EmptyLog(msg))) => TenantResult::Refused(msg),
            Ok(Err(SyncError::Failed(e))) => TenantResult::Failed(e),
            Err(_) => TenantResult::Failed(anyhow::anyhow!(
                "persons-sync of the tenant timed out after {}s",
                tenant_timeout.as_secs()
            )),
        };

        journal.close(operation, tenant, &result).await;
        reports.push(TenantReport { tenant, result });
    }
    reports
}

fn empty_log_guard(log_rows: usize, force: bool) -> Result<(), String> {
    if force || log_rows > 0 {
        return Ok(());
    }
    Err(EMPTY_TENANT_LOG.to_owned())
}

pub async fn run_sync(
    reader: &dyn PersonsLogReader,
    writer: &dyn IdentityPersonsWriter,
    tenant: Uuid,
    now: DateTime,
    force: bool,
) -> Result<SyncSummary, SyncError> {
    let rows = reader.read_tenant(tenant).await?;

    if let Err(msg) = empty_log_guard(rows.len(), force) {
        return Err(SyncError::EmptyLog(msg));
    }

    writer.replace_tenant(tenant, &rows, now).await?;

    Ok(SyncSummary {
        rows: rows.len() as u64,
        max_id: rows.iter().map(|r| r.id).max(),
        max_created_at: rows.iter().map(|r| r.created_at).max().map(fmt_iso),
        synced_at: fmt_iso(now),
    })
}

pub const MAX_QUIESCENCE_PASSES: u32 = 2;

pub async fn run_sync_until_quiescent(
    reader: &dyn PersonsLogReader,
    writer: &dyn IdentityPersonsWriter,
    tenant: Uuid,
    mut now: impl FnMut() -> DateTime + Send,
    force: bool,
) -> Result<SyncOutcome, SyncError> {
    if !force {
        let latest = reader.latest_id(tenant).await.map_err(SyncError::Failed)?;
        if latest.is_some()
            && latest
                == writer
                    .published_max_id(tenant)
                    .await
                    .map_err(SyncError::Failed)?
        {
            return Ok(SyncOutcome::AlreadyCurrent { max_id: latest });
        }
    }
    let mut summary = run_sync(reader, writer, tenant, now(), force).await?;
    for _ in 0..MAX_QUIESCENCE_PASSES {
        let latest = reader.latest_id(tenant).await.map_err(SyncError::Failed)?;
        if latest <= summary.max_id {
            return Ok(SyncOutcome::Published(summary));
        }
        summary = run_sync(reader, writer, tenant, now(), force).await?;
    }
    if reader.latest_id(tenant).await.map_err(SyncError::Failed)? > summary.max_id {
        tracing::warn!(
            %tenant,
            passes = 1 + MAX_QUIESCENCE_PASSES,
            "persons-sync: the log of the tenant still moves after the pass cap. The next \
             publish carries the remainder"
        );
    }
    Ok(SyncOutcome::Published(summary))
}

fn fmt_iso(dt: DateTime) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
}

#[cfg(test)]
mod tests;
