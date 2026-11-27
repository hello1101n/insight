use std::collections::HashMap;
use std::time::Duration;

use chrono::{DateTime, Utc};
use k8s_openapi::api::core::v1::Pod;
use kube::{Api, Client, api::ListParams};

const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Default)]
pub(super) struct PodState {
    pub(super) uid: Option<uuid::Uuid>,
    pub(super) started_at: Option<DateTime<Utc>>,
    pub(super) unscheduled_at: Option<DateTime<Utc>>,
    pub(super) oom: bool,
}

fn state(pod: &Pod, container_name: &str) -> PodState {
    let Some(status) = &pod.status else {
        return PodState::default();
    };
    let unscheduled_at = status
        .conditions
        .as_deref()
        .unwrap_or_default()
        .iter()
        .find(|condition| {
            status.phase.as_deref() == Some("Pending")
                && condition.type_ == "PodScheduled"
                && condition.status == "False"
                && condition.reason.as_deref() == Some("Unschedulable")
        })
        .and_then(|condition| {
            condition
                .last_transition_time
                .as_ref()
                .and_then(super::kubernetes_time)
        });
    let container = status
        .container_statuses
        .as_deref()
        .unwrap_or_default()
        .iter()
        .find(|container| container.name == container_name);
    let current = container.and_then(|c| c.state.as_ref());
    let running = current.and_then(|v| v.running.as_ref());
    let terminated = current.and_then(|v| v.terminated.as_ref());
    let started_at = running
        .and_then(|v| v.started_at.as_ref())
        .or_else(|| terminated.and_then(|v| v.started_at.as_ref()))
        .and_then(super::kubernetes_time);

    PodState {
        uid: pod.metadata.uid.as_deref().and_then(|v| v.parse().ok()),
        started_at,
        unscheduled_at,
        oom: terminated
            .or_else(|| container?.last_state.as_ref()?.terminated.as_ref())
            .is_some_and(|v| v.reason.as_deref() == Some("OOMKilled")),
    }
}

pub(super) async fn workflow(
    client: Client,
    namespace: &str,
    name: &str,
    uid: &str,
) -> anyhow::Result<HashMap<String, PodState>> {
    let api = Api::<Pod>::namespaced(client, namespace);
    let params = ListParams::default().labels(&format!("workflows.argoproj.io/workflow={name}"));
    let list = tokio::time::timeout(TIMEOUT, api.list(&params)).await??;

    Ok(list
        .items
        .into_iter()
        .filter(|pod| {
            pod.metadata
                .owner_references
                .as_ref()
                .is_some_and(|owners| owners.iter().any(|o| o.uid == uid && o.kind == "Workflow"))
        })
        .filter_map(|pod| {
            let id = pod
                .metadata
                .annotations
                .as_ref()?
                .get("workflows.argoproj.io/node-id")?;
            Some((id.clone(), state(&pod, "main")))
        })
        .collect())
}

pub(super) async fn airbyte(
    client: Client,
    namespace: &str,
    connection: uuid::Uuid,
    job: u64,
) -> anyhow::Result<PodState> {
    let api = Api::<Pod>::namespaced(client, namespace);
    let labels =
        format!("job_id={job},connection_id={connection},job_type=sync,sync_step=replication");
    let params = ListParams::default().labels(&labels);
    let list = tokio::time::timeout(TIMEOUT, api.list(&params)).await?;

    let mut result = PodState::default();
    for pod in list?.items {
        let sample = state(&pod, "source");
        result.started_at = earlier(result.started_at, sample.started_at);
        result.unscheduled_at = earlier(result.unscheduled_at, sample.unscheduled_at);
        result.oom |= sample.oom;
    }
    Ok(result)
}

fn earlier<T: Ord>(a: Option<T>, b: Option<T>) -> Option<T> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}
