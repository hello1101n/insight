mod nodes;
mod pods;

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use chrono::Utc;
use futures_util::StreamExt;
use kube::{
    Api,
    api::{
        ApiResource, DynamicObject, GroupVersionKind, ListParams, Patch, PatchParams, WatchParams,
    },
};
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::{Observation, StageRow, capacity, store};
use crate::api::AppState;

const PERIOD: Duration = Duration::from_secs(5);

fn workflows(state: &AppState) -> Result<Api<DynamicObject>> {
    let resource = ApiResource::from_gvk(&GroupVersionKind::gvk(
        "argoproj.io",
        "v1alpha1",
        "Workflow",
    ));
    Ok(Api::namespaced_with(
        state
            .cluster
            .client
            .clone()
            .context("missing Kubernetes client")?,
        &state.cluster.namespace,
        &resource,
    ))
}

async fn watch(api: &Api<DynamicObject>, notify: &Notify) -> Result<()> {
    let list = api.list_metadata(&ListParams::default().limit(1)).await?;
    let version = list
        .metadata
        .resource_version
        .context("missing Workflow list version")?;
    let events = api
        .watch(&WatchParams::default().timeout(60), &version)
        .await?;
    tokio::pin!(events);
    while let Some(event) = events.next().await {
        if let kube::api::WatchEvent::Error(_) = event? {
            break;
        }
        notify.notify_one();
    }
    Ok(())
}

pub(crate) async fn run(state: Arc<AppState>, cancel: CancellationToken) {
    let Ok(api) = workflows(&state) else { return };
    let Ok(http) = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return;
    };
    let notify = Arc::new(Notify::new());
    let watcher = tokio::spawn({
        let api = api.clone();
        let notify = notify.clone();
        let cancel = cancel.clone();
        async move {
            loop {
                tokio::select! {
                    () = cancel.cancelled() => return,
                    result = watch(&api, &notify) => {
                        if let Err(error) = result {
                            tracing::debug!(%error, "Workflow watch interrupted");
                        }
                    }
                }
                tokio::select! {
                    () = cancel.cancelled() => return,
                    () = tokio::time::sleep(PERIOD) => {}
                }
            }
        }
    });
    loop {
        tokio::select! {
            () = cancel.cancelled() => break,
            result = cycle(&state, &api, &http) => {
                if let Err(error) = result {
                    tracing::warn!(%error, "connector stage reconciliation unavailable");
                }
            }
        }
        tokio::select! {
            () = cancel.cancelled() => break,
            () = tokio::time::sleep(PERIOD) => {},
            () = notify.notified() => tokio::time::sleep(Duration::from_millis(300)).await,
        }
    }
    watcher.abort();
}

async fn cycle(state: &AppState, api: &Api<DynamicObject>, http: &reqwest::Client) -> Result<()> {
    let stand = &state.cluster.namespace;
    for row in store::unfinished(&state.db, stand).await? {
        if let Err(error) = reconcile(state, api, http, &row).await {
            tracing::warn!(stage=%row.stage,sync_id=%row.sync_id,%error,"could not reconcile connector stage");
        }
    }
    Ok(())
}

async fn argo(
    state: &AppState,
    http: &reqwest::Client,
    row: &StageRow,
    action: &str,
    node: &Value,
) -> Result<()> {
    let mut url = url::Url::parse(&state.cluster.argo_url)?;
    url.path_segments_mut()
        .map_err(|()| anyhow::anyhow!("invalid Argo server URL"))?
        .pop_if_empty()
        .extend([
            "api",
            "v1",
            "workflows",
            &state.cluster.namespace,
            &row.workflow_name,
            action,
        ]);
    let token =
        tokio::fs::read_to_string("/var/run/secrets/kubernetes.io/serviceaccount/token").await?;
    http.put(url)
        .bearer_auth(token.trim())
        .json(&json!({"nodeFieldSelector":nodes::selector(node,row)?}))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

async fn reconcile(
    state: &AppState,
    api: &Api<DynamicObject>,
    http: &reqwest::Client,
    row: &StageRow,
) -> Result<()> {
    let Some(wf) =
        tokio::time::timeout(Duration::from_secs(6), api.get_opt(&row.workflow_name)).await??
    else {
        return vanished(state, row).await;
    };
    if wf.metadata.uid.as_deref() != Some(&row.sync_id) {
        return vanished(state, row).await;
    }
    let status = &wf.data["status"];
    let phase = status["phase"].as_str().unwrap_or("");
    let terminal = matches!(phase, "Succeeded" | "Failed" | "Error");
    let gate = nodes::suspend(status, row);
    let mut o = Observation::default();
    if row.finished_at.is_none() {
        if let Some(node) = gate {
            ensure!(
                row.decision == "queued",
                "unexpected suspend for immediate grant"
            );
            if Utc::now() - row.queued_at > chrono::Duration::hours(6) {
                argo(state, http, row, "stop", node).await?;
                o.status = Some("wait_timeout".into());
                o.reason = Some("wait_timeout".into());
                o.finished_at = Some(Utc::now());
            } else if row.granted_at.is_some()
                || store::promote(
                    &state.db,
                    &state.cluster.namespace,
                    row,
                    capacity::sample(state).await?,
                )
                .await?
            {
                argo(state, http, row, "resume", node).await?;
            }
        } else if row.granted_at.is_none() {
            if terminal {
                o.status = Some("cancelled".into());
                o.finished_at = Some(Utc::now());
            }
        } else {
            o = observe_work(state, row, status, terminal).await?;
            if o.status.as_deref() == Some("stopping_pod_wait")
                && row.stage != "bronze"
                && wf.data["spec"]["shutdown"].is_null()
            {
                api.patch(&row.workflow_name, &PatchParams::default(), &Patch::Merge(json!({
                    "metadata":{"uid":row.sync_id, "resourceVersion":wf.metadata.resource_version},
                    "spec":{"shutdown":"Terminate"}
                }))).await?;
            }
        }
    }
    if terminal && (o.finished_at.is_some() || row.finished_at.is_some()) {
        o.run_status = Some(
            if row.status == "wait_timeout" || o.status.as_deref() == Some("wait_timeout") {
                "failed"
            } else if phase == "Succeeded" {
                "succeeded"
            } else if !wf.data["spec"]["shutdown"].is_null() {
                "cancelled"
            } else {
                "failed"
            }
            .into(),
        );
        o.run_finished_at = nodes::time(status, "finishedAt");
    }
    store::observe(&state.db, &state.cluster.namespace, row, o).await
}

async fn vanished(state: &AppState, row: &StageRow) -> Result<()> {
    let mut o = Observation::default();
    if row.granted_at.is_none()
        || row.finished_at.is_some()
        || (row.stage == "bronze" && !row.airbyte_claimed && row.airbyte_job_id.is_none())
    {
        o.status = Some("cancelled".into());
        o.finished_at = Some(Utc::now());
        o.run_status = Some("cancelled".into());
        o.run_finished_at = o.finished_at;
    } else {
        o.status = Some(
            if row.stage == "bronze" && row.airbyte_claimed && row.airbyte_job_id.is_none() {
                "checking_start"
            } else {
                "unknown"
            }
            .into(),
        );
        o.reason = Some("workflow_not_found".into());
    }
    store::observe(&state.db, &state.cluster.namespace, row, o).await
}

fn query_usage(o: &mut Observation, evidence: &capacity::QueryEvidence, bronze: bool) {
    if evidence.peak > 0 {
        o.peak_bytes = Some(evidence.peak);
    }
    if evidence.completed > 0 && evidence.cpu_millis > 0 {
        o.cpu_millis = Some(evidence.cpu_millis);
    }
    if !bronze && evidence.bytes > 0 {
        o.volume_bytes = Some(evidence.bytes);
    }
    if evidence.records != 0 {
        o.bronze_replay_safe = Some(false);
    }
}

fn finish_reason(
    row: &StageRow,
    e: &capacity::QueryEvidence,
    pod: &pods::Sample,
    status: Option<&str>,
) -> Option<String> {
    if row.status == "stopping_pod_wait" {
        return Some("wait_timeout".into());
    }
    if e.memory_errors > 0 {
        return Some(
            if e.global_memory_errors == e.memory_errors {
                "clickhouse_server_memory_pressure"
            } else {
                "clickhouse_memory_limit"
            }
            .into(),
        );
    }
    pod.oom
        .clone()
        .or_else(|| row.reason.clone())
        .or_else(|| (status == Some("failed")).then(|| "stage_failed".into()))
}

fn stage_end(node: Option<&Value>, row: &StageRow) -> chrono::DateTime<Utc> {
    let finished = node.and_then(|n| nodes::job_finished(n, row.airbyte_job_id.as_deref()?));
    finished
        .filter(|end| *end >= row.queued_at && row.started_at.is_none_or(|start| *end >= start))
        .or_else(|| node.and_then(|n| nodes::time(n, "finishedAt")))
        .unwrap_or_else(Utc::now)
}

fn waiting_for_node(sample: &pods::Sample) -> bool {
    sample.unscheduled && !sample.assigned && !sample.working && sample.started.is_none()
}

pub(super) async fn can_cancel_pending(state: &AppState, row: &StageRow) -> Result<bool> {
    Ok(row.status == "stopping_pod_wait"
        && row.stage == "bronze"
        && row.started_at.is_none()
        && waiting_for_node(&pods::observe(state, row).await?))
}

async fn observe_work(
    state: &AppState,
    row: &StageRow,
    status: &Value,
    terminal: bool,
) -> Result<Observation> {
    let bronze = row.stage == "bronze";
    let mut o = Observation::default();
    if bronze
        && row.airbyte_claimed
        && row.airbyte_job_id.is_none()
        && let Some(trigger) = nodes::trigger(status, row)
    {
        o.airbyte_job_id = pods::trigger_receipt(state, row, trigger).await;
    }
    let (node, job) = if bronze {
        nodes::bronze(status, row, &mut o)
    } else {
        (nodes::work(status, row), None)
    };
    let evidence = capacity::evidence(state, row).await?;
    query_usage(&mut o, &evidence, bronze);
    let pod = pods::observe(state, row).await?;
    o.pod_cpu_millis = pod.cpu;
    o.pod_peak_bytes = pod.memory;
    o.source_peak_bytes = pod.source_memory;
    o.source_cpu_millis = pod.source_cpu;
    o.source_oom_limit_bytes = pod.source_oom_limit;
    if pod.oom.is_some() {
        o.reason.clone_from(&pod.oom);
    }
    let node_phase = node.and_then(|n| n["phase"].as_str()).unwrap_or("");
    let completed = job.as_deref().map_or_else(
        || !bronze && matches!(node_phase, "Succeeded" | "Failed" | "Error"),
        |job| matches!(job, "succeeded" | "failed" | "cancelled"),
    );
    let unstarted = terminal && !row.airbyte_claimed && node.is_none() && !pod.present;
    if completed || unstarted {
        let log_pending = evidence.completed == 0
            && node
                .and_then(|n| nodes::time(n, "finishedAt"))
                .is_some_and(|end| (Utc::now() - end).num_seconds() < 10);
        if log_pending
            || evidence.running != 0
            || pod.working
            || (evidence.completed == 0 && !capacity::idle(state).await?)
        {
            o.status = Some("unknown".into());
            return Ok(o);
        }
        o.status = Some(
            if row.status == "stopping_pod_wait" {
                "wait_timeout"
            } else if unstarted {
                "cancelled"
            } else if matches!(job.as_deref(), Some("succeeded"))
                || !bronze && node_phase == "Succeeded"
            {
                "succeeded"
            } else {
                "failed"
            }
            .into(),
        );
        o.finished_at = Some(stage_end(node, row));
        o.reason = finish_reason(row, &evidence, &pod, o.status.as_deref());
    } else if bronze
        && row.airbyte_claimed
        && row.airbyte_job_id.is_none()
        && o.airbyte_job_id.is_none()
    {
        o.status = Some("checking_start".into());
    } else if (row.status == "stopping_pod_wait" && (!bronze || !pod.present))
        || (waiting_for_node(&pod)
            && row.started_at.is_none()
            && Utc::now() - row.queued_at > chrono::Duration::hours(6))
    {
        o.status = Some("stopping_pod_wait".into());
    } else if pod.pending {
        o.status = Some("waiting_pod".into());
    } else if pod.working || !bronze && node_phase == "Running" {
        o.status = Some(if bronze { "loading" } else { "transforming" }.into());
    } else if bronze && row.airbyte_job_id.is_some() && row.started_at.is_none() && !terminal {
        o.status = Some("starting".into());
    } else if terminal {
        o.status = Some("unknown".into());
    }
    if o.started_at.is_none()
        && (pod.working
            || completed
            || matches!(o.status.as_deref(), Some("loading" | "transforming")))
    {
        o.started_at = pod
            .started
            .or_else(|| node.and_then(|n| nodes::time(n, "startedAt")))
            .or(row.started_at)
            .or_else(|| (bronze && !pod.pending).then(Utc::now));
    }
    Ok(o)
}
