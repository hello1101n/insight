use crate::{api::AppState, domain::admission::StageRow};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use k8s_openapi::api::core::v1::Pod;
use kube::{
    Api, Client,
    api::{ApiResource, DynamicObject, GroupVersionKind, ListParams},
};

#[derive(Default)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "Several observed pods can have different phases simultaneously"
)]
pub(super) struct Sample {
    pub present: bool,
    pub pending: bool,
    pub placement_blocked: bool,
    indeterminate: bool,
    pub unscheduled: bool,
    pub assigned: bool,
    pub working: bool,
    pub oom: Option<String>,
    pub source_memory: Option<u64>,
    pub source_oom_limit: Option<u64>,
    pub source_cpu: Option<u64>,
    pub started: Option<DateTime<Utc>>,
    pub memory: Option<u64>,
    pub cpu: Option<u64>,
}

impl Sample {
    pub(super) fn may_work(&self) -> bool {
        self.working || self.pending || self.indeterminate
    }
}

fn units(value: &str, cpu: bool) -> Option<u64> {
    let (suffix, factor) = if cpu {
        [("n", 0.000_001), ("u", 0.001), ("m", 1.0), ("", 1000.0)]
            .into_iter()
            .find(|(s, _)| value.ends_with(s))?
    } else {
        [
            ("Ki", 1024.0),
            ("Mi", 1_048_576.0),
            ("Gi", 1_073_741_824.0),
            ("K", 1000.0),
            ("M", 1_000_000.0),
            ("G", 1_000_000_000.0),
            ("", 1.0),
        ]
        .into_iter()
        .find(|(s, _)| value.ends_with(s))?
    };
    let n = value.strip_suffix(suffix)?.parse::<f64>().ok()? * factor;
    if !n.is_finite() || n < 0.0 {
        return None;
    }
    format!("{:.0}", n.ceil()).parse().ok()
}

#[derive(Default)]
struct ContainerMetrics {
    memory: u64,
    cpu: u64,
    source: Option<(u64, u64)>,
}

async fn metrics(client: Client, namespace: &str, name: &str) -> Option<ContainerMetrics> {
    let gvk = GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", "PodMetrics");
    let mut resource = ApiResource::from_gvk(&gvk);
    resource.plural = "pods".into();
    let metric = Api::<DynamicObject>::namespaced_with(client, namespace, &resource)
        .get(name)
        .await
        .ok()?;
    let timestamp = metric.data["timestamp"]
        .as_str()?
        .parse::<DateTime<Utc>>()
        .ok()?;
    if (Utc::now() - timestamp).num_seconds().unsigned_abs() > 90 {
        return None;
    }
    let mut result = ContainerMetrics::default();
    for c in metric.data["containers"].as_array()? {
        let memory = units(c["usage"]["memory"].as_str()?, false)?;
        let cpu = units(c["usage"]["cpu"].as_str()?, true)?;
        result.memory = result.memory.checked_add(memory)?;
        result.cpu = result.cpu.checked_add(cpu)?;
        if c["name"] == "source" {
            result.source = Some((memory, cpu));
        }
    }
    Some(result)
}

fn containers(s: &mut Sample, status: &k8s_openapi::api::core::v1::PodStatus, bronze: bool) {
    if let Some(containers) = &status.container_statuses {
        for container in containers {
            if container.name == "wait" {
                continue;
            }
            for st in [container.state.as_ref(), container.last_state.as_ref()]
                .into_iter()
                .flatten()
            {
                if st.terminated.as_ref().and_then(|t| t.reason.as_deref()) == Some("OOMKilled") {
                    s.oom = Some(
                        if bronze
                            && container.name == "source"
                            && s.oom.as_deref() != Some("pod_oom")
                        {
                            "source_pod_oom"
                        } else {
                            "pod_oom"
                        }
                        .into(),
                    );
                }
            }
            if let Some(st) = container.state.as_ref() {
                let time = st
                    .running
                    .as_ref()
                    .and_then(|t| t.started_at.as_ref())
                    .or_else(|| st.terminated.as_ref().and_then(|t| t.started_at.as_ref()));
                if let Some(t) = time.and_then(|t| t.0.to_string().parse::<DateTime<Utc>>().ok()) {
                    s.started = Some(s.started.map_or(t, |a| a.min(t)));
                }
            }
        }
    }
}

fn source_limit_after_oom(
    metadata: &kube::api::ObjectMeta,
    spec: Option<&k8s_openapi::api::core::v1::PodSpec>,
    status: &k8s_openapi::api::core::v1::PodStatus,
) -> Option<u64> {
    metadata.uid.as_deref()?;
    metadata
        .labels
        .as_ref()?
        .get("attempt_id")?
        .parse::<u32>()
        .ok()?;
    let source = status
        .container_statuses
        .as_ref()?
        .iter()
        .find(|c| c.name == "source")?;
    if ![&source.state, &source.last_state]
        .into_iter()
        .filter_map(Option::as_ref)
        .any(|s| s.terminated.as_ref().and_then(|x| x.reason.as_deref()) == Some("OOMKilled"))
    {
        return None;
    }
    let quantity = spec?
        .containers
        .iter()
        .find(|c| c.name == "source")?
        .resources
        .as_ref()?
        .limits
        .as_ref()?
        .get("memory")?;
    units(&quantity.0, false)
}

pub(super) async fn observe(state: &AppState, row: &StageRow) -> Result<Sample> {
    let client = state
        .cluster
        .client
        .clone()
        .context("missing Kubernetes client")?;
    let bronze = row.stage == "bronze";
    let (namespace, selector) = if bronze {
        let (Some(id), Some(conn)) = (&row.airbyte_job_id, &row.connection_id) else {
            return Ok(Sample::default());
        };
        (
            &state.cluster.airbyte_namespace,
            format!("job_id={id},connection_id={conn},job_type=sync,sync_step=replication"),
        )
    } else {
        (
            &state.cluster.namespace,
            format!(
                "workflows.argoproj.io/workflow={},insight.cyberfabric.com/stage={},insight.cyberfabric.com/attempt={}",
                row.workflow_name, row.stage, row.attempt
            ),
        )
    };
    let api = Api::<Pod>::namespaced(client.clone(), namespace);
    let params = ListParams::default().labels(&selector);
    let pods = tokio::time::timeout(super::PERIOD, api.list(&params)).await??;
    let mut s = Sample::default();
    for pod in pods.items {
        if !bronze
            && !pod
                .metadata
                .owner_references
                .as_ref()
                .is_some_and(|owners| {
                    owners
                        .iter()
                        .any(|o| o.uid == row.sync_id && o.kind == "Workflow")
                })
        {
            continue;
        }
        s.present = true;
        let Some(status) = pod.status else {
            s.indeterminate = true;
            continue;
        };
        s.indeterminate |= !matches!(
            status.phase.as_deref(),
            Some("Pending" | "Running" | "Succeeded" | "Failed")
        );
        s.assigned |= pod.spec.as_ref().is_some_and(|p| p.node_name.is_some());
        s.unscheduled |= status.phase.as_deref() == Some("Pending")
            && pod.spec.as_ref().is_some_and(|p| p.node_name.is_none());
        s.placement_blocked |= status.phase.as_deref() == Some("Pending")
            && pod.spec.as_ref().is_some_and(|p| p.node_name.is_none())
            && status
                .conditions
                .as_deref()
                .unwrap_or_default()
                .iter()
                .any(|c| {
                    c.type_ == "PodScheduled"
                        && c.status == "False"
                        && c.reason.as_deref() == Some("Unschedulable")
                });
        let running = status.phase.as_deref() == Some("Running");
        s.working |= running;
        s.pending |= status.phase.as_deref() == Some("Pending");
        containers(&mut s, &status, bronze);
        if bronze
            && s.oom.as_deref() == Some("source_pod_oom")
            && let Some(limit) = source_limit_after_oom(&pod.metadata, pod.spec.as_ref(), &status)
        {
            s.source_oom_limit = Some(s.source_oom_limit.unwrap_or(0).max(limit));
        }
        if running
            && let Some(name) = &pod.metadata.name
            && let Ok(Some(usage)) = tokio::time::timeout(
                std::time::Duration::from_secs(1),
                metrics(client.clone(), namespace, name),
            )
            .await
        {
            s.memory = Some(s.memory.unwrap_or_default().saturating_add(usage.memory));
            s.cpu = Some(s.cpu.unwrap_or_default().saturating_add(usage.cpu));
            if let Some((mem, cpu)) = usage.source {
                s.source_memory = Some(mem);
                s.source_cpu = Some(cpu);
            }
        }
    }
    Ok(s)
}

pub(super) async fn trigger_receipt(
    state: &AppState,
    row: &StageRow,
    node: &serde_json::Value,
) -> Option<String> {
    let id = node["id"].as_str()?;
    let pods = Api::<Pod>::namespaced(state.cluster.client.clone()?, &state.cluster.namespace);
    let list = pods
        .list(&ListParams::default().labels(&format!(
            "workflows.argoproj.io/workflow={}",
            row.workflow_name
        )))
        .await
        .ok()?;
    let pod = list.items.iter().find(|p| {
        p.metadata
            .annotations
            .as_ref()
            .and_then(|a| a.get("workflows.argoproj.io/node-id"))
            .is_some_and(|node_id| node_id == id)
            && p.metadata.owner_references.as_ref().is_some_and(|owners| {
                owners
                    .iter()
                    .any(|o| o.uid == row.sync_id && o.kind == "Workflow")
            })
    })?;
    let logs = pods
        .logs(
            pod.metadata.name.as_deref()?,
            &kube::api::LogParams {
                container: Some("main".into()),
                tail_lines: Some(100),
                limit_bytes: Some(65536),
                ..Default::default()
            },
        )
        .await
        .ok()?;
    receipt(&logs, row.connection_id.as_deref()?)
}

fn receipt(logs: &str, connection: &str) -> Option<String> {
    let mut receipts = logs.lines().filter_map(|line| {
        let record = serde_json::from_str::<serde_json::Value>(line).ok()?;
        let fields = &record["fields"];
        if record["target"] != "airbyte-sync"
            || fields["event"] != "sync.triggered"
            || fields["connection_id"] != connection
        {
            return None;
        }
        fields["job_id"].as_u64()
    });
    let first = receipts.next()?;
    receipts
        .all(|next| next == first)
        .then(|| first.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pending_or_unobserved_worker_still_blocks_completion() {
        let mut pod = Sample {
            pending: true,
            ..Sample::default()
        };
        assert!(pod.may_work());
        assert!(pod.started.is_none());
        pod.pending = false;
        pod.indeterminate = true;
        assert!(pod.may_work());
        pod.indeterminate = false;
        assert!(!pod.may_work());
    }

    #[test]
    fn only_uniquely_attributed_trigger_log_is_a_receipt() {
        let log = |connection: &str, id: u64| {
            serde_json::json!({"target":"airbyte-sync","fields":{"event":"sync.triggered","connection_id":connection,"job_id":id}}).to_string()
        };
        let lines = [log("a", 2), log("b", 3)].join("\n");
        assert_eq!(receipt(&lines, "b").as_deref(), Some("3"));
        assert_eq!(receipt(&format!("{lines}\n{}", log("b", 5)), "b"), None);
        assert_eq!(receipt("connection=b job_id=3", "b"), None);
    }
}
