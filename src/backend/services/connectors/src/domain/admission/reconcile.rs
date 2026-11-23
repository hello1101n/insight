pub(super) mod airbyte;
mod nodes;
pub(super) use nodes::bronze_volume;
pub(super) mod placement;
mod pods;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
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
    let list =
        tokio::time::timeout(PERIOD, api.list_metadata(&ListParams::default().limit(1))).await??;
    let version = list
        .metadata
        .resource_version
        .context("missing Workflow list version")?;
    let events = tokio::time::timeout(
        PERIOD,
        api.watch(&WatchParams::default().timeout(60), &version),
    )
    .await??;
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
    let mut runs = HashMap::<String, Vec<StageRow>>::new();
    for row in store::unfinished(&state.db, stand).await? {
        runs.entry(row.workflow_name.clone()).or_default().push(row);
    }
    let mut checks = futures_util::stream::iter(runs)
        .map(|(name, rows)| check_workflow(state, api, http, name, rows))
        .buffer_unordered(8);
    let mut ready = HashSet::new();
    while let Some(result) = checks.next().await {
        match result {
            Ok(ids) => ready.extend(ids),
            Err(error) => tracing::warn!(%error,"could not read ingestion Workflow"),
        }
    }
    if !ready.is_empty() {
        let available = capacity::sample(state).await?;
        store::promote_ready(&state.db, stand, &ready, available).await?;
    }
    Ok(())
}

async fn check_workflow(
    state: &AppState,
    api: &Api<DynamicObject>,
    http: &reqwest::Client,
    name: String,
    rows: Vec<StageRow>,
) -> Result<Vec<u64>> {
    let workflow = tokio::time::timeout(Duration::from_secs(6), api.get_opt(&name)).await??;
    let mut ready = Vec::new();
    for row in rows {
        let wf = workflow
            .as_ref()
            .filter(|wf| wf.metadata.uid.as_deref() == Some(&row.sync_id));
        let result = if let Some(wf) = wf {
            let status = &wf.data["status"];
            if row.granted_at.is_none()
                && row.status == "queued"
                && wf.metadata.deletion_timestamp.is_none()
                && wf.data["spec"]["shutdown"]
                    .as_str()
                    .unwrap_or_default()
                    .is_empty()
                && status["phase"] == "Running"
                && Utc::now() - row.queued_at <= chrono::Duration::hours(6)
                && nodes::suspend(status, &row).is_some_and(|n| nodes::selector(n, &row).is_ok())
            {
                ready.push(row.id);
                continue;
            }
            reconcile(state, api, http, &row, wf).await
        } else {
            vanished(state, http, &row).await
        };
        if let Err(error) = result {
            tracing::warn!(stage=%row.stage,sync_id=%row.sync_id,%error,"could not reconcile connector stage");
        }
    }
    Ok(ready)
}

async fn upgrade_legacy_gate(
    api: &Api<DynamicObject>,
    wf: &DynamicObject,
    row: &StageRow,
    node: &Value,
) -> Result<bool> {
    let Some(inputs) = nodes::legacy_uid_inputs(node, row) else {
        return Ok(false);
    };
    let id = node["id"].as_str().context("missing suspended node ID")?;
    ensure!(
        wf.data["status"]["nodes"][id] == *node,
        "suspended node key mismatch"
    );
    let version = wf
        .metadata
        .resource_version
        .as_deref()
        .context("missing Workflow version")?;
    let patch = Patch::Merge(json!({
        "metadata":{"uid":row.sync_id,"resourceVersion":version},
        "status":{"nodes":{(id):{"inputs":{"parameters":inputs}}}}
    }));
    tokio::time::timeout(
        PERIOD,
        api.patch(&row.workflow_name, &PatchParams::default(), &patch),
    )
    .await??;
    Ok(true)
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
    let mut body = json!({"nodeFieldSelector":nodes::selector(node,row)?});
    if action == "stop" {
        body["message"] = json!(nodes::WAIT_TIMEOUT_MESSAGE);
    }
    let result = http
        .put(url)
        .bearer_auth(token.trim())
        .json(&body)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status);
    if let Err(error) = result {
        let api = workflows(state)?;
        let current = tokio::time::timeout(PERIOD, api.get_opt(&row.workflow_name)).await??;
        if !current.is_some_and(|wf| {
            wf.metadata.uid.as_deref() == Some(&row.sync_id)
                && nodes::confirmed_action(&wf.data["status"], node, row, action)
        }) {
            return Err(error.into());
        }
    }
    Ok(())
}

async fn reconcile(
    state: &AppState,
    api: &Api<DynamicObject>,
    http: &reqwest::Client,
    row: &StageRow,
    wf: &DynamicObject,
) -> Result<()> {
    let status = &wf.data["status"];
    let phase = status["phase"].as_str().unwrap_or("");
    let terminal = matches!(phase, "Succeeded" | "Failed" | "Error");
    let gate = nodes::suspend(status, row);
    let mut o = Observation::default();
    if row.finished_at.is_none() {
        if let Some(node) = gate {
            if upgrade_legacy_gate(api, wf, row, node).await? {
                return Ok(());
            }
            ensure!(
                row.decision == "queued",
                "unexpected suspend for immediate grant"
            );
            if Utc::now() - row.queued_at > chrono::Duration::hours(6) {
                argo(state, http, row, "stop", node).await?;
                o.status = Some("wait_timeout".into());
                o.reason = Some("wait_timeout".into());
                o.finished_at = Some(Utc::now());
            } else if row.granted_at.is_some() {
                argo(state, http, row, "resume", node).await?;
            }
        } else if let Some(stopped) = nodes::stopped_gate(status, row) {
            o.status = Some("wait_timeout".into());
            o.reason = Some("wait_timeout".into());
            o.finished_at = nodes::time(stopped, "finishedAt").or_else(|| Some(Utc::now()));
        } else if row.granted_at.is_none() {
            if terminal {
                o.status = Some("cancelled".into());
                o.finished_at = Some(Utc::now());
            }
        } else {
            o = placement::observe(state, api, http, row, wf, terminal).await?;
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
    if o.status.is_none()
        && o.run_status.is_none()
        && (row.granted_at.is_none() || row.finished_at.is_some() || gate.is_some())
    {
        return Ok(());
    }
    store::observe(&state.db, &state.cluster.namespace, row, o).await
}

async fn vanished(state: &AppState, http: &reqwest::Client, row: &StageRow) -> Result<()> {
    let mut o = Observation::default();
    if row.granted_at.is_none()
        || row.finished_at.is_some()
        || (row.stage == "bronze" && !row.airbyte_claimed && row.airbyte_job_id.is_none())
    {
        o.status = Some("cancelled".into());
        o.finished_at = Some(Utc::now());
        o.run_status = Some("cancelled".into());
        o.run_finished_at = o.finished_at;
    } else if row.stage != "bronze" || row.airbyte_job_id.is_some() {
        o = observe_work(state, http, row, &Value::Null, true).await?;
        if o.finished_at.is_some() {
            o.run_status = Some("cancelled".into());
            o.run_finished_at = o.finished_at;
        }
    } else {
        o.airbyte_job_id = recover_launch(state, http, row).await?;
        o.status = Some("checking_start".into());
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
    if row.status == "stopping_pod_wait" && status == Some("wait_timeout") {
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

async fn recover_launch(
    state: &AppState,
    http: &reqwest::Client,
    row: &StageRow,
) -> Result<Option<String>> {
    let (Some(previous), Some(connection)) =
        (row.airbyte_previous_job, row.connection_id.as_deref())
    else {
        return Ok(None);
    };
    let job = airbyte::recent_jobs(state, http, connection)
        .await?
        .new_job(previous);
    Ok(job.map(|id| id.to_string()))
}

async fn observed_node<'a>(
    state: &AppState,
    http: &reqwest::Client,
    row: &StageRow,
    status: &'a Value,
    terminal: bool,
    o: &mut Observation,
) -> Result<(Option<&'a Value>, Option<airbyte::Completion>)> {
    let bronze = row.stage == "bronze";
    if bronze
        && row.airbyte_claimed
        && row.airbyte_job_id.is_none()
        && let Some(trigger) = nodes::trigger(status, row)
    {
        o.airbyte_job_id = tokio::time::timeout(PERIOD, pods::trigger_receipt(state, row, trigger))
            .await
            .ok()
            .flatten();
    }
    let (node, mut job) = if bronze {
        nodes::bronze(status, row, o)
    } else {
        (nodes::work(status, row), None)
    };
    if bronze
        && row.airbyte_claimed
        && row.airbyte_job_id.is_none()
        && o.airbyte_job_id.is_none()
        && row.status == "checking_start"
    {
        o.airbyte_job_id = recover_launch(state, http, row).await?;
    }
    if bronze
        && job.is_none()
        && row.airbyte_job_id.is_some()
        && (terminal
            || node.is_some_and(|n| matches!(n["phase"].as_str(), Some("Failed" | "Error"))))
    {
        job = airbyte::terminal_job(state, http, row).await?;
    }
    if let Some(r) = &job {
        o.records_reported = r.records;
        o.volume_bytes = r.bytes;
    }
    Ok((node, job))
}

fn record_pod_usage(o: &mut Observation, pod: &pods::Sample) {
    o.pod_cpu_millis = pod.cpu;
    o.pod_peak_bytes = pod.memory;
    o.source_peak_bytes = pod.source_memory;
    o.source_cpu_millis = pod.source_cpu;
    o.source_oom_limit_bytes = pod.source_oom_limit;
    if pod.oom.is_some() {
        o.reason.clone_from(&pod.oom);
    }
}

async fn observe_work(
    state: &AppState,
    http: &reqwest::Client,
    row: &StageRow,
    status: &Value,
    terminal: bool,
) -> Result<Observation> {
    let bronze = row.stage == "bronze";
    let mut o = Observation::default();
    let (node, receipt) = observed_node(state, http, row, status, terminal, &mut o).await?;
    let job = receipt.as_ref().map(|r| r.status.as_str());
    // A terminating pod can submit its last query until it stops.
    let pod = pods::observe(state, row).await?;
    let placement_blocked =
        pod.placement_blocked || (!bronze && !pod.present && nodes::quota_wait(node));
    o.placement_blocked = Some(placement_blocked && row.started_at.is_none());
    let evidence = capacity::evidence(state, row).await?;
    query_usage(&mut o, &evidence, bronze);
    record_pod_usage(&mut o, &pod);
    let node_phase = node.and_then(|n| n["phase"].as_str()).unwrap_or("");
    let completed = job.map_or_else(
        || !bronze && matches!(node_phase, "Succeeded" | "Failed" | "Error"),
        |job| matches!(job, "succeeded" | "failed" | "cancelled"),
    );
    let orphaned = terminal && !row.airbyte_claimed && node.is_none() && !pod.may_work();
    let unstarted = orphaned && row.started_at.is_none() && pod.started.is_none();
    if completed || orphaned {
        // An early QueryFinish can be visible while the last batch is still buffered.
        let last_work = node
            .and_then(|n| nodes::time(n, "finishedAt"))
            .max(receipt.as_ref().and_then(|r| r.end));
        let log_pending = !unstarted
            && last_work.is_some_and(|end| Utc::now() - end < chrono::Duration::seconds(10));
        let end = receipt
            .as_ref()
            .and_then(|r| r.end)
            .unwrap_or_else(|| stage_end(node, row));
        let drained =
            unstarted || evidence.completed > 0 || receipt.as_ref().is_some_and(|r| r.committed);
        if log_pending
            || evidence.running != 0
            || pod.may_work()
            || (!drained && !capacity::idle_before(state, end).await?)
        {
            if row.status != "stopping_pod_wait" {
                o.status = Some("unknown".into());
            }
            return Ok(o);
        }
        o.status = Some(
            if row.status == "stopping_pod_wait" && (!bronze || job == Some("cancelled")) {
                "wait_timeout"
            } else if orphaned {
                "cancelled"
            } else if matches!(job, Some("succeeded")) || !bronze && node_phase == "Succeeded" {
                "succeeded"
            } else {
                "failed"
            }
            .into(),
        );
        o.finished_at = Some(end);
        o.reason = finish_reason(row, &evidence, &pod, o.status.as_deref());
    } else if bronze
        && row.airbyte_claimed
        && row.airbyte_job_id.is_none()
        && o.airbyte_job_id.is_none()
    {
        o.status = Some("checking_start".into());
    } else if (!bronze && row.status == "stopping_pod_wait")
        || ((waiting_for_node(&pod) || (!bronze && !pod.present && nodes::quota_wait(node)))
            && row.started_at.is_none()
            && Utc::now() - row.queued_at > chrono::Duration::hours(6))
    {
        o.status = Some(
            if bronze {
                "placement_overdue"
            } else {
                "stopping_pod_wait"
            }
            .into(),
        );
    } else if bronze
        && !pod.present
        && matches!(
            row.status.as_str(),
            "placement_overdue" | "stopping_pod_wait"
        )
    {
        o.status = Some("placement_overdue".into());
    } else if placement_blocked {
        o.status = Some("waiting_pod".into());
    } else if pod.pending || row.status == "waiting_pod" && !pod.working && node_phase != "Running"
    {
        o.status = Some("starting".into());
    } else if pod.working || !bronze && node_phase == "Running" {
        o.status = Some(if bronze { "loading" } else { "transforming" }.into());
    } else if bronze && row.airbyte_job_id.is_some() && row.started_at.is_none() && !terminal {
        o.status = Some("starting".into());
    } else if terminal {
        o.status = Some("unknown".into());
    }
    o.started_at = pod.started.or(row.started_at);
    Ok(o)
}
