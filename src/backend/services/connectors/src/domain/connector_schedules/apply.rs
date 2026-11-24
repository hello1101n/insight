use kube::api::DynamicObject;
use sea_orm::DatabaseConnection;

use super::dto::{InheritedSchedule, LiveSchedule, ScheduleResponse};
use super::{Error, Instance, Resources, repository, workflow};
use crate::infra::cluster::Cluster;

const UNREADABLE: &str = "the CronWorkflow could not be read back";
const MISMATCH: &str = "the sync job runs a different schedule";

#[derive(Debug, Default)]
pub(crate) struct Observation {
    pub(crate) live: Option<LiveSchedule>,
    pub(crate) inherited: Option<InheritedSchedule>,
    pub(crate) read_error: Option<String>,
    pub(crate) resources: Option<Resources>,
    pub(super) pod_patches: [Option<String>; 2],
    pub(crate) resource_defaults: Option<Resources>,
    pub(crate) resource_read_error: Option<String>,
}

pub(crate) fn observation(object: Option<&DynamicObject>) -> Result<Observation, Error> {
    let resources = object.map(workflow::live_resources).transpose();
    let resource_defaults = object.map(workflow::resource_defaults).transpose();
    let resource_read_error = resources
        .as_ref()
        .err()
        .or_else(|| resource_defaults.as_ref().err())
        .map(ToString::to_string);
    Ok(Observation {
        live: object.map(workflow::live).transpose()?,
        inherited: object.and_then(workflow::inherited),
        read_error: None,
        resources: resources.ok().flatten(),
        pod_patches: object.map_or_else(Default::default, workflow::live_pod_patches),
        resource_defaults: resource_defaults.ok().flatten(),
        resource_read_error,
    })
}

async fn read(cluster: &Cluster, instance: &Instance) -> Result<Option<DynamicObject>, Error> {
    if !cluster.enabled() {
        return Err(crate::infra::cluster::Error::Disabled.into());
    }
    let object = cluster
        .get(&instance.workflow_name(&cluster.tenant_id)?)
        .await?;
    if object.as_ref().is_some_and(|o| {
        !workflow::identity_matches(o, instance, &cluster.namespace, &cluster.tenant_id)
    }) {
        return Err(Error::ClusterIdentity);
    }
    Ok(object)
}

pub(super) async fn observe(cluster: &Cluster, instance: &Instance) -> Result<Observation, Error> {
    let result = async { observation(read(cluster, instance).await?.as_ref()) }.await;
    Ok(result.unwrap_or_else(|error: Error| Observation {
        read_error: Some(format!("the sync job cannot be read: {error}")),
        ..Observation::default()
    }))
}

pub(super) async fn require_reset_target(
    cluster: &Cluster,
    instance: &Instance,
) -> Result<(), Error> {
    let object = read(cluster, instance)
        .await
        .map_err(|error| Error::NotChanged(error.to_string()))?;
    if object
        .as_ref()
        .is_some_and(|object| workflow::inherited(object).is_none())
    {
        return Err(Error::ResetUnavailable);
    }
    Ok(())
}

pub(super) async fn stored(
    db: &DatabaseConnection,
    cluster: &Cluster,
    instance: &Instance,
    resources_only: bool,
) -> Result<ScheduleResponse, Error> {
    let row = repository::read(db, instance).await?;
    let revision = row.as_ref().map_or(0, |r| r.revision);
    let requested = row
        .as_ref()
        .map(|r| serde_json::from_value::<Vec<String>>(r.crons.clone()).map_err(Error::StoredCrons))
        .transpose()?
        .unwrap_or_default();
    let resources = Resources::stored(row.as_ref().and_then(|r| r.resources.as_ref()))?;
    let intent = if resources_only {
        Intent::Resources(&resources)
    } else {
        Intent::Schedule(&requested)
    };
    let (observed, failure) = attempt_change(cluster, instance, intent, revision).await;
    if let Some(reason) = failure {
        return Err(if resources_only {
            Error::ResourcesNotChanged(reason)
        } else {
            Error::NotChanged(reason)
        });
    }
    super::response(instance, row, observed)
}

#[derive(Debug, Clone, Copy)]
enum Intent<'a> {
    Schedule(&'a [String]),
    Resources(&'a Resources),
}

impl Intent<'_> {
    fn target(self, observed: &Observation) -> Option<Target> {
        match self {
            Self::Schedule(requested) => workflow::desired(
                requested,
                observed
                    .inherited
                    .as_ref()
                    .map(|schedule| InheritedSchedule {
                        crons: schedule.crons.clone(),
                        origin: schedule.origin,
                    }),
            )
            .map(Target::Schedule),
            Self::Resources(requested) => observed
                .resource_defaults
                .as_ref()
                .map(|defaults| Target::Resources(requested.resolve(defaults))),
        }
    }

    fn unchanged(self, live: &Observation, previous: &Observation) -> bool {
        match self {
            Self::Schedule(_) => {
                live.live
                    .as_ref()
                    .zip(previous.live.as_ref())
                    .is_some_and(|(live, previous)| {
                        live.crons == previous.crons
                            && live.timezone == previous.timezone
                            && live.origin == previous.origin
                    })
            }
            Self::Resources(_) => {
                live.resources == previous.resources && live.pod_patches == previous.pod_patches
            }
        }
    }
}

#[derive(Debug)]
enum Target {
    Schedule(InheritedSchedule),
    Resources(Resources),
}

impl Target {
    fn matches(&self, observed: &Observation) -> bool {
        match self {
            Self::Schedule(target) => observed
                .live
                .as_ref()
                .is_some_and(|live| workflow::matches(live, target)),
            Self::Resources(target) => {
                observed.resources.as_ref() == Some(target)
                    && observed.pod_patches == target.pod_patches().map(Some)
            }
        }
    }

    fn patch(&self, object: &DynamicObject) -> Result<serde_json::Value, Error> {
        match self {
            Self::Schedule(target) => workflow::patch(object, target),
            Self::Resources(target) => workflow::patch_resources(object, target),
        }
    }

    fn log_change(&self, revision: u64, instance: &Instance, previous: &Observation) {
        match self {
            Self::Schedule(target) => {
                log_change(revision, instance, previous.live.as_ref(), target);
            }
            Self::Resources(target) => tracing::info!(
                connector = instance.connector.as_str(), source_id = instance.source_id.as_str(),
                from_resources = ?previous.resources, to_resources = ?target, revision,
                "The sync job resource settings changed."
            ),
        }
    }
}

#[derive(Debug, Default)]
enum PatchOutcome {
    #[default]
    NotSent,
    Refused,
    Unconfirmed(Observation),
    Accepted(Observation),
}

#[cfg(test)]
async fn attempt(
    cluster: &Cluster,
    instance: &Instance,
    requested: &[String],
    revision: u64,
) -> (Observation, Option<String>) {
    attempt_change(cluster, instance, Intent::Schedule(requested), revision).await
}

async fn attempt_change(
    cluster: &Cluster,
    instance: &Instance,
    intent: Intent<'_>,
    revision: u64,
) -> (Observation, Option<String>) {
    let mut target = match intent {
        Intent::Schedule(_) => intent.target(&Observation::default()),
        Intent::Resources(_) => None,
    };
    let mut outcome = PatchOutcome::NotSent;
    let (observed, failure) = attempt_once(
        cluster,
        instance,
        intent,
        revision,
        &mut target,
        &mut outcome,
    )
    .await;
    if failure.is_none() {
        return (observed, None);
    }
    #[cfg(test)]
    super::save_hooks::checkpoint(instance, "confirm").await;
    let object = read(cluster, instance).await;
    let confirmed = match &object {
        Ok(object) => {
            observation(object.as_ref()).unwrap_or_else(|error| unreadable(&error.to_string()).0)
        }
        Err(error) => unreadable(&error.to_string()).0,
    };
    if target
        .as_ref()
        .is_some_and(|target| target.matches(&confirmed))
    {
        if let PatchOutcome::Unconfirmed(previous) = &outcome
            && let Some(target) = &target
        {
            target.log_change(revision, instance, previous);
        }
        return (confirmed, None);
    }
    let (PatchOutcome::Unconfirmed(previous) | PatchOutcome::Accepted(previous)) = &outcome else {
        return (observed, failure);
    };
    if confirmed.live.is_none() || !intent.unchanged(&confirmed, previous) {
        return (confirmed, None);
    }
    let Ok(Some(object)) = object else {
        return (confirmed, None);
    };
    if fence(cluster, &object).await.is_ok() {
        return (confirmed, failure);
    }
    let observed = observe(cluster, instance).await.unwrap_or_default();
    if let PatchOutcome::Unconfirmed(previous) = &outcome
        && let Some(target) = &target
        && target.matches(&observed)
    {
        target.log_change(revision, instance, previous);
    }
    (observed, None)
}

async fn fence(cluster: &Cluster, object: &DynamicObject) -> Result<(), Error> {
    let name = object
        .metadata
        .name
        .as_deref()
        .ok_or(Error::ClusterIdentity)?;
    let uid = object
        .metadata
        .uid
        .as_deref()
        .ok_or(Error::ClusterIdentity)?;
    let version = object
        .metadata
        .resource_version
        .as_deref()
        .ok_or(Error::ClusterIdentity)?;
    let patch = serde_json::json!({"metadata": {
        "uid": uid,
        "resourceVersion": version,
        "annotations": {"insight.cyberfabric.com/schedule-fence": uuid::Uuid::new_v4().to_string()}
    }});
    cluster.patch(name, &patch).await?;
    Ok(())
}

async fn attempt_once(
    cluster: &Cluster,
    instance: &Instance,
    intent: Intent<'_>,
    revision: u64,
    attempted_target: &mut Option<Target>,
    outcome: &mut PatchOutcome,
) -> (Observation, Option<String>) {
    for retry in [true, false] {
        let object = match read(cluster, instance).await {
            Ok(Some(object)) => object,
            Ok(None) => return (Observation::default(), None),
            Err(error) => return unreadable(&error.to_string()),
        };
        let observed = match observation(Some(&object)) {
            Ok(observed) => observed,
            Err(error) => return unreadable(&error.to_string()),
        };
        let Some(target) = intent.target(&observed) else {
            let message = match intent {
                Intent::Schedule(_) => {
                    "Reset requires the deployment schedule annotation; run reconcile before resetting"
                }
                Intent::Resources(_) => "the deployment resource settings are invalid",
            };
            return (observed, Some(message.to_owned()));
        };
        let target = attempted_target.insert(target);
        if target.matches(&observed) {
            return (observed, None);
        }
        let patch = match target.patch(&object) {
            Ok(patch) => patch,
            Err(error) => {
                return (
                    observed,
                    Some(format!("the cluster refused the change: {error}")),
                );
            }
        };
        let name = object.metadata.name.as_deref().unwrap_or_default();
        #[cfg(test)]
        super::save_hooks::checkpoint(instance, "patch").await;
        match cluster.patch(name, &patch).await {
            Err(error) if retry && error.conflict() => {
                *outcome = PatchOutcome::Refused;
                continue;
            }
            Err(error) => {
                tracing::error!(error = %error, "schedule patch failed");
                let message = if error.refused() {
                    *outcome = PatchOutcome::Refused;
                    format!("the cluster refused the change: {error}")
                } else if error.server_error() {
                    format!("the cluster returned an error: {error}")
                } else {
                    format!("the cluster did not answer in time or its answer was lost: {error}")
                };
                if !error.refused() {
                    *outcome = PatchOutcome::Unconfirmed(observed);
                }
                let observed = observation(Some(&object)).unwrap_or_default();
                return (observed, Some(message));
            }
            Ok(()) => {}
        }
        #[cfg(test)]
        super::save_hooks::checkpoint(instance, "readback").await;
        target.log_change(revision, instance, &observed);
        *outcome = PatchOutcome::Accepted(observed);
        return match read(cluster, instance).await {
            Ok(Some(readback)) if readback.metadata.uid == object.metadata.uid => {
                match observation(Some(&readback)) {
                    Ok(observation) => {
                        let matched = target.matches(&observation);
                        let mismatch = match target {
                            Target::Schedule(_) => MISMATCH,
                            Target::Resources(_) => "the sync job uses different resource settings",
                        };
                        (observation, (!matched).then(|| mismatch.to_owned()))
                    }
                    Err(error) => unreadable(&error.to_string()),
                }
            }
            Ok(_) => unreadable(UNREADABLE),
            Err(error) => unreadable(&error.to_string()),
        };
    }
    unreadable(UNREADABLE)
}

fn unreadable(message: &str) -> (Observation, Option<String>) {
    let message = format!("the sync job cannot be read: {message}");
    (
        Observation {
            read_error: Some(message.clone()),
            ..Observation::default()
        },
        Some(message),
    )
}

fn log_change(
    revision: u64,
    instance: &Instance,
    before: Option<&LiveSchedule>,
    target: &InheritedSchedule,
) {
    let Some(before) = before else {
        return;
    };
    tracing::info!(connector = instance.connector.as_str(), source_id = instance.source_id.as_str(), from_crons = ?before.crons, to_crons = ?target.crons, revision, "sync job schedule changed");
}

#[cfg(test)]
mod tests;
