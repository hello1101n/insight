mod airbyte;
mod bronze;
mod nodes;
mod pods;
mod query_failures;
mod timeout;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use kube::{
    Api,
    api::{ApiResource, DynamicObject, GroupVersionKind, ListParams, WatchEvent, WatchParams},
};
use tokio_util::sync::CancellationToken;

use super::{RunSnapshot, StageSnapshot, WaitKind, store};
use crate::api::AppState;
use crate::domain::connector_health::{ConnectorName, SourceId, TenantId};

const PERIOD: Duration = Duration::from_secs(5);
const RELIST_SECONDS: u32 = 30;

pub(crate) async fn run(state: Arc<AppState>, cancel: CancellationToken) {
    tokio::join!(
        watch_workflows(&state, &cancel),
        query_failures::run(&state, &cancel)
    );
}

async fn watch_workflows(state: &AppState, cancel: &CancellationToken) {
    let Some(client) = state.cluster.client.clone() else {
        return;
    };
    let resource = ApiResource::from_gvk(&GroupVersionKind::gvk(
        "argoproj.io",
        "v1alpha1",
        "Workflow",
    ));
    let api = Api::<DynamicObject>::namespaced_with(client, &state.cluster.namespace, &resource);
    let Some(http) = insight_http_client::client_builder()
        .and_then(|builder| {
            Ok(builder
                .timeout(PERIOD)
                .redirect(reqwest::redirect::Policy::none())
                .build()?)
        })
        .map_err(|error| tracing::warn!(%error, "Workflow observer HTTP client did not start."))
        .ok()
    else {
        return;
    };

    let mut completed = HashMap::new();
    loop {
        tokio::select! {
            () = cancel.cancelled() => return,
            result = observe_window(state, &api, &http, &mut completed) => {
                if let Err(error) = result {
                    tracing::warn!(%error, "Workflow history watch stopped.");
                    tokio::select! {
                        () = cancel.cancelled() => return,
                        () = tokio::time::sleep(PERIOD) => {}
                    }
                }
            }
        }
    }
}

async fn observe_window(
    state: &AppState,
    api: &Api<DynamicObject>,
    http: &reqwest::Client,
    completed: &mut HashMap<String, String>,
) -> Result<()> {
    let mut params = ListParams::default().limit(100);
    let mut retained = HashMap::new();
    let mut present = HashSet::new();
    let version = loop {
        let list = tokio::time::timeout(PERIOD, api.list(&params)).await??;
        for workflow in list.items {
            if let Some(uid) = &workflow.metadata.uid {
                present.insert(uid.clone());
            }
            if let (Some(uid), Some(version)) =
                (&workflow.metadata.uid, &workflow.metadata.resource_version)
                && completed.get(uid) == Some(version)
            {
                retained.insert(uid.clone(), version.clone());
            } else {
                record(state, api, http, &workflow, false, &mut retained).await;
            }
        }
        let Some(next) = list.metadata.continue_.filter(|v| !v.is_empty()) else {
            break list
                .metadata
                .resource_version
                .context("missing Workflow list version")?;
        };
        params = params.continue_token(&next);
    };
    *completed = retained;
    record_missing(state, http, &present).await?;

    let watch = tokio::time::timeout(
        PERIOD,
        api.watch(&WatchParams::default().timeout(RELIST_SECONDS), &version),
    )
    .await??;
    tokio::pin!(watch);
    let deadline = tokio::time::sleep(Duration::from_secs(u64::from(RELIST_SECONDS)));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            () = &mut deadline => return Ok(()),
            next = watch.next() => match next.transpose()? {
                Some(WatchEvent::Added(wf) | WatchEvent::Modified(wf)) => {
                    record(state, api, http, &wf, false, completed).await;
                }
                Some(WatchEvent::Deleted(wf)) => {
                    record(state, api, http, &wf, true, completed).await;
                    if let Some(uid) = wf.metadata.uid {
                        completed.remove(&uid);
                    }
                }
                Some(WatchEvent::Bookmark(_)) => {}
                Some(WatchEvent::Error(error)) => anyhow::bail!("Workflow watch ended with status {}", error.code),
                None => return Ok(()),
            }
        }
    }
}

async fn record(
    state: &AppState,
    api: &Api<DynamicObject>,
    http: &reqwest::Client,
    workflow: &DynamicObject,
    deleted: bool,
    completed: &mut HashMap<String, String>,
) {
    let now = Utc::now();
    let Some((mut run, has_bronze)) = identity(workflow, now, deleted) else {
        return;
    };
    if let Some(version) = workflow.metadata.resource_version.as_ref()
        && completed.get(&run.uid) == Some(version)
    {
        return;
    }
    let Some(client) = state.cluster.client.clone() else {
        return;
    };
    let status = &workflow.data["status"];
    let namespace = &state.cluster.namespace;
    let observed_pods = if nodes::nodes(status).any(|node| node["type"] == "Pod") {
        match pods::workflow(client, namespace, &run.name, &run.uid).await {
            Ok(pods) => pods,
            Err(error) => {
                tracing::warn!(%error, "Workflow pod observation failed.");
                return;
            }
        }
    } else {
        HashMap::new()
    };

    run.stages = nodes::transforms(status, &observed_pods, run.finished_at);
    if has_bronze {
        let mut load = bronze::snapshot(workflow, run.created_at, &observed_pods, run.finished_at);
        observe_bronze(state, http, &mut load).await;
        run.stages.push(load);
    }
    timeout::apply(workflow, &mut run);
    if let Err(error) = store::save(&state.db, namespace, &run, now).await {
        tracing::warn!(%error, "Workflow history write failed.");
        return;
    }
    if run.finished_at.is_some() && run.stages.iter().all(|stage| stage.finished_at.is_some()) {
        if let Some(version) = &workflow.metadata.resource_version {
            completed.insert(run.uid, version.clone());
        }
    } else if let Err(error) = timeout::stop(api, workflow, &run, now).await {
        tracing::warn!(%error, "Workflow timeout patch failed.");
    }
}

async fn record_missing(
    state: &AppState,
    http: &reqwest::Client,
    present: &HashSet<String>,
) -> Result<()> {
    let namespace = &state.cluster.namespace;
    let now = Utc::now();

    for entry in store::unsettled(&state.db, namespace).await? {
        if present.contains(&entry.sync_id) {
            continue;
        }
        let load = if let (Some(job), Some(queued_at)) = (entry.job(), entry.queued_at) {
            let mut load = StageSnapshot::new("bronze", entry.attempt.unwrap_or(1), queued_at);
            load.connection = entry.connection_id;
            load.job = Some(job);
            load.status = "loading";
            observe_bronze(state, http, &mut load).await;
            Some(load)
        } else {
            None
        };

        store::close_missing(&state.db, &entry.sync_id, now, load).await?;
    }
    Ok(())
}

fn kubernetes_time(
    time: &k8s_openapi::apimachinery::pkg::apis::meta::v1::Time,
) -> Option<DateTime<Utc>> {
    DateTime::from_timestamp_millis(time.0.as_millisecond())
}

fn invocation(spec: &serde_json::Value) -> Option<(&serde_json::Value, bool)> {
    if spec["workflowTemplateRef"]["name"] == "ingestion-pipeline" {
        return Some((spec, spec["entrypoint"] != "transform"));
    }

    let root = spec["templates"]
        .as_array()?
        .iter()
        .find(|template| template["name"] == spec["entrypoint"])?;
    let step = root["steps"]
        .as_array()?
        .iter()
        .filter_map(serde_json::Value::as_array)
        .flatten()
        .find(|step| step["templateRef"]["name"] == "ingestion-pipeline")?;
    Some((step, step["templateRef"]["template"] != "transform"))
}

fn identity(wf: &DynamicObject, now: DateTime<Utc>, deleted: bool) -> Option<(RunSnapshot, bool)> {
    let (spec, has_bronze) = invocation(&wf.data["spec"])?;
    let connector = ConnectorName::parse(nodes::parameter(spec, "arguments", "data_source")?)?;
    let source = SourceId::parse(nodes::parameter(spec, "arguments", "insight_source_id")?)?;
    let prefix = format!("{}-{}-", connector.as_str(), source.as_str());
    let tenant = nodes::parameter(spec, "arguments", "connection_name")
        .and_then(|name| name.strip_prefix(&prefix)?.strip_suffix("-conn"))
        .or_else(|| {
            wf.metadata
                .labels
                .as_ref()?
                .get("tenant")
                .map(String::as_str)
        })
        .or_else(|| {
            wf.metadata
                .labels
                .as_ref()?
                .get("insight.cyberfabric.com/tenant")
                .map(String::as_str)
        })?;
    let tenant = TenantId::parse(tenant)?;
    let status = &wf.data["status"];
    let phase = match nodes::phase(status) {
        Some("Succeeded") => Some("succeeded"),
        Some("Failed" | "Error") => Some("failed"),
        _ if deleted => Some("cancelled"),
        _ => None,
    };
    let finished_at =
        phase.and_then(|_| nodes::time(status, "finishedAt").or(deleted.then_some(now)));

    let created_at = kubernetes_time(wf.metadata.creation_timestamp.as_ref()?)?;
    Some((
        RunSnapshot {
            uid: wf
                .metadata
                .uid
                .as_deref()?
                .parse::<uuid::Uuid>()
                .ok()?
                .to_string(),
            name: wf.metadata.name.clone()?,
            connector: connector.into_string(),
            source: source.into_string(),
            tenant: tenant.into_string(),
            created_at,
            execution: nodes::time(status, "startedAt").unwrap_or(created_at),
            finished_at,
            status: phase.filter(|_| finished_at.is_some()),
            stages: Vec::new(),
        },
        has_bronze,
    ))
}

async fn observe_bronze(state: &AppState, http: &reqwest::Client, load: &mut StageSnapshot) {
    let (Some(job), Some(connection), Some(client)) = (
        load.job,
        load.connection.as_deref().and_then(|v| v.parse().ok()),
        state.cluster.client.clone(),
    ) else {
        return;
    };
    let placement = pods::airbyte(client, &state.cluster.airbyte_namespace, connection, job);
    let placement = if load.finished_at.is_some() {
        placement.await
    } else {
        let (native, placement) =
            tokio::join!(airbyte::job(state, http, job, connection), placement);
        if let Ok(evidence) = native {
            evidence.apply(load, None);
        }
        placement
    };

    if let Ok(pod) = placement {
        load.started_at = load.started_at.or(pod.started_at);
        if load.status == "failed" && pod.oom {
            load.reason = Some("source_pod_oom".into());
        }
        if load.finished_at.is_none()
            && let Some(at) = pod.unscheduled_at
        {
            load.wait = Some(nodes::wait(WaitKind::Placement, at, None));
            load.status = "queued";
        }
    }
}

#[cfg(test)]
mod tests;
