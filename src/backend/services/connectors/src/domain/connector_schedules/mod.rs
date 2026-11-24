pub(crate) mod apply;
pub(crate) mod dto;
mod instance;
pub(crate) mod lock;
mod membership;
mod repository;
pub(crate) mod resources;
mod timing;
pub(crate) mod validation;
pub(crate) mod workflow;

use std::sync::Arc;

use sea_orm::DatabaseConnection;
use tracing::Instrument;
use uuid::Uuid;

use crate::infra::cluster::Cluster;
use crate::infra::db::entities::connector_schedules::Model;
use dto::{RequestedSchedule, ScheduleResponse};
pub(crate) use instance::Instance;
use resources::{ResourcePatch, ResourceState, Resources};
use validation::Crons;

#[derive(Debug, thiserror::Error)]
pub(crate) enum Error {
    #[error(
        "No connector instance {connector}/{source_id} is configured on this install. Connector health lists the configured instances by connector and source id."
    )]
    NotFound {
        connector: String,
        source_id: String,
    },
    #[error("If-Match is required")]
    MissingMatch,
    #[error("If-Match must be a single quoted decimal ETag")]
    InvalidMatch,
    #[error("schedule revision does not match If-Match")]
    Stale(u64),
    #[error("schedule revision is exhausted")]
    RevisionExhausted,
    #[error("{0}")]
    Invalid(#[from] validation::Violation),
    #[error("schedule database read or write failed")]
    Database(#[from] sea_orm::DbErr),
    #[error("schedule lock failed")]
    Lock(#[from] sea_orm::sqlx::Error),
    #[error("schedule lock is busy")]
    LockBusy,
    #[error("sync history read failed")]
    SyncHistory(#[from] clickhouse::error::Error),
    #[error("stored schedule is invalid")]
    StoredCrons(serde_json::Error),
    #[error("stored resource settings are invalid")]
    StoredResources(serde_json::Error),
    #[error("The resources were not changed: {0}")]
    ResourcesNotChanged(String),
    #[error(
        "The request is saved but not applied: {0}. The previous resource settings could not be restored."
    )]
    ResourceRestoreFailed(String),
    #[error("cluster read failed: {0}")]
    Cluster(#[from] crate::infra::cluster::Error),
    #[error("The schedule was not changed: {0}")]
    NotChanged(String),
    #[error("The request is saved but not applied: {0}; restoring the previous schedule failed")]
    RestoreFailed(String),
    #[error("Reset requires the deployment schedule annotation; run reconcile before resetting")]
    ResetUnavailable,
    #[error("schedule save task failed")]
    Task(#[from] tokio::task::JoinError),
    #[error("sync job name requires a tenant prefix and must be at most 52 characters")]
    WorkflowName,
    #[error("CronWorkflow identity does not match")]
    ClusterIdentity,
}

impl Error {
    fn before_write(self) -> Self {
        if matches!(
            self,
            Self::Database(sea_orm::DbErr::ConnectionAcquire(
                sea_orm::ConnAcquireErr::Timeout
            )) | Self::Lock(sea_orm::sqlx::Error::PoolTimedOut)
        ) {
            Self::LockBusy
        } else {
            self
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Revision(u64);

impl Revision {
    pub(crate) fn parse(raw: Option<&str>) -> Result<Self, Error> {
        let raw = raw.ok_or(Error::MissingMatch)?;
        let digits = raw
            .strip_prefix('"')
            .and_then(|s| s.strip_suffix('"'))
            .ok_or(Error::InvalidMatch)?;
        if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
            return Err(Error::InvalidMatch);
        }
        digits.parse().map(Self).map_err(|_| Error::InvalidMatch)
    }
}

#[derive(Debug)]
pub(crate) enum Change {
    Put(Crons),
    Resources(ResourcePatch),
    Delete,
}

pub(crate) async fn get(
    db: &DatabaseConnection,
    ch: &insight_clickhouse::Client,
    cluster: &Cluster,
    instance: &Instance,
) -> Result<ScheduleResponse, Error> {
    require_readable(db, ch, instance).await?;
    let row = repository::read(db, instance).await?;
    let observed = apply::observe(cluster, instance).await?;
    let mut response = response(instance, row, observed)?;
    timing::enrich(&mut response, cluster).await;
    Ok(response)
}

async fn require_readable(
    db: &DatabaseConnection,
    ch: &insight_clickhouse::Client,
    instance: &Instance,
) -> Result<(), Error> {
    match membership::require(ch, instance).await {
        Ok(()) => Ok(()),
        Err(Error::NotFound { .. }) if repository::read(db, instance).await?.is_some() => Ok(()),
        Err(error) => Err(error),
    }
}

pub(crate) async fn save(
    state: &Arc<crate::api::AppState>,
    instance: &Instance,
    revision: Revision,
    change: Change,
    caller: Uuid,
) -> Result<ScheduleResponse, Error> {
    let clears = match &change {
        Change::Put(_) => false,
        Change::Delete => true,
        Change::Resources(patch) => patch.only_clears(),
    };
    if clears {
        require_readable(&state.db, &state.ch, instance)
            .await
            .map_err(Error::before_write)?;
    } else {
        membership::require(&state.ch, instance).await?;
    }
    let state = Arc::clone(state);
    let instance = instance.clone();
    tokio::spawn(
        async move { save_locked(&state, &instance, revision, change, caller).await }
            .in_current_span(),
    )
    .await?
}

async fn save_locked(
    state: &crate::api::AppState,
    instance: &Instance,
    revision: Revision,
    change: Change,
    caller: Uuid,
) -> Result<ScheduleResponse, Error> {
    // INVARIANT: keep the slot and instance lock through apply and rollback.
    let _permit = slot(&state.schedule_slots).await?;
    #[cfg(test)]
    save_hooks::checkpoint(instance, "slot").await;

    let guard = lock::acquire(&state.db, instance)
        .await
        .map_err(Error::before_write)?;
    #[cfg(test)]
    save_hooks::checkpoint(instance, "lock").await;

    let cluster = state.cluster.for_save();
    let previous = repository::read(&state.db, instance)
        .await
        .map_err(Error::before_write)?;
    let current_revision = previous.as_ref().map_or(0, |row| row.revision);
    if current_revision != revision.0 {
        return Err(Error::Stale(current_revision));
    }
    #[cfg(test)]
    save_hooks::checkpoint(instance, "revision").await;
    if matches!(change, Change::Delete) {
        apply::require_reset_target(&cluster, instance).await?;
    }
    let resources_only = matches!(change, Change::Resources(_));
    let written = repository::write(&state.db, instance, revision, change, caller)
        .await
        .map_err(Error::before_write)?;
    #[cfg(test)]
    save_hooks::checkpoint(instance, "write").await;
    let response = apply::stored(&state.db, &cluster, instance, resources_only).await;
    #[cfg(test)]
    save_hooks::checkpoint(instance, "apply").await;
    let response = match response {
        Ok(response) => Ok(response),
        Err(error) if written == previous => Err(error),
        Err(error) => {
            #[cfg(test)]
            save_hooks::checkpoint(instance, "rollback").await;
            if let Err(restore) = repository::restore(&state.db, instance, previous).await {
                tracing::error!(error = %error, restore = %restore, "schedule rollback failed");
                let reason = match error {
                    Error::NotChanged(reason) | Error::ResourcesNotChanged(reason) => reason,
                    error => error.to_string(),
                };
                Err(if resources_only {
                    Error::ResourceRestoreFailed(reason)
                } else {
                    Error::RestoreFailed(reason)
                })
            } else {
                Err(error)
            }
        }
    };
    #[cfg(test)]
    save_hooks::checkpoint(instance, "release").await;
    release(guard.release().await);
    #[cfg(test)]
    save_hooks::checkpoint(instance, "finished").await;
    let mut response = response?;
    timing::enrich(&mut response, &cluster).await;
    Ok(response)
}

fn release(result: Result<(), Error>) {
    if let Err(error) = result {
        tracing::error!(error = %error, "schedule lock release failed");
    }
}

pub(crate) async fn slot(
    slots: &tokio::sync::Semaphore,
) -> Result<tokio::sync::SemaphorePermit<'_>, Error> {
    tokio::time::timeout(std::time::Duration::from_secs(5), slots.acquire())
        .await
        .map_err(|_| Error::LockBusy)?
        .map_err(|_| Error::LockBusy)
}

fn response(
    instance: &Instance,
    row: Option<Model>,
    observed: apply::Observation,
) -> Result<ScheduleResponse, Error> {
    let revision = row.as_ref().map_or(0, |row| row.revision);
    let resources = resource_state(row.as_ref(), &observed)?;
    let requested = row
        .filter(|row| row.has_schedule_revision)
        .map(|row| {
            Ok::<_, Error>(RequestedSchedule {
                crons: serde_json::from_value(row.crons).map_err(Error::StoredCrons)?,
                updated_by: row.updated_by,
                updated_at: row.updated_at,
            })
        })
        .transpose()?;
    let crons = requested.as_ref().map_or(&[][..], |r| r.crons.as_slice());
    let (status, pending_reason) =
        dto::status(crons, observed.live.as_ref(), observed.inherited.as_ref());
    let readable = observed.read_error.is_none();
    Ok(ScheduleResponse {
        connector: instance.connector.as_str().to_owned(),
        source_id: instance.source_id.as_str().to_owned(),
        revision,
        resources,
        requested,
        live: observed.live,
        inherited: observed.inherited,
        status: readable.then_some(status),
        read_error: observed.read_error,
        pending_reason: readable.then_some(pending_reason).flatten(),
        next_reconcile_at: None,
        reconcile_interval_secs: None,
    })
}

fn resource_state(
    row: Option<&Model>,
    observed: &apply::Observation,
) -> Result<ResourceState, Error> {
    use dto::ScheduleStatus::{Applied, Inherited, Paused, Pending};

    let requested = Resources::stored(row.and_then(|r| r.resources.as_ref()))?;
    let defaults = observed.resource_defaults.as_ref();
    let live = observed.resources.as_ref();
    let target = requested.resolve(&defaults.cloned().unwrap_or_default());
    let status = if observed.live.as_ref().is_some_and(|live| live.suspended) {
        Paused
    } else if !observed.matches_resources(&target) {
        Pending
    } else if requested.is_empty() {
        Inherited
    } else {
        Applied
    };
    let read_error = observed
        .read_error
        .as_ref()
        .or(observed.resource_read_error.as_ref())
        .cloned();
    Ok(ResourceState {
        requested,
        live: live.cloned(),
        inherited: defaults.cloned(),
        status: read_error.is_none().then_some(status),
        read_error,
    })
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod live_tests;

#[cfg(test)]
pub(crate) mod save_hooks;
