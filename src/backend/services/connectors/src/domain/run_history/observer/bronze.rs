use std::collections::HashMap;

use chrono::{DateTime, Utc};
use kube::api::DynamicObject;
use serde::Deserialize;
use serde_json::Value;

use super::{airbyte, nodes, pods::PodState};
use crate::domain::{
    connector_schedules::resources::Resources,
    run_history::{StageSnapshot, StageWait, WaitKind},
};

const LAUNCH_ANNOTATION: &str = "insight.cyberfabric.com/airbyte-launch";
const CAPACITY_ANNOTATION: &str = "insight.cyberfabric.com/airbyte-capacity-wait";

#[derive(Debug, Deserialize)]
struct LaunchReceipt {
    workflow_uid: uuid::Uuid,
    workflow_started_at: DateTime<Utc>,
    attempt: u32,
    connection: uuid::Uuid,
    outcome: LaunchOutcome,
    job_id: Option<u64>,
    outcome_at: Option<DateTime<Utc>>,
    pod_request: Option<PodRequest>,
}

#[derive(Debug, Deserialize)]
struct PodRequest {
    cpu_millis: u32,
    memory_bytes: u64,
}

#[derive(Debug, Deserialize)]
struct CapacityWait {
    workflow_uid: uuid::Uuid,
    workflow_started_at: DateTime<Utc>,
    attempt: u32,
    started_at: DateTime<Utc>,
    ended_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum LaunchOutcome {
    Pending,
    Accepted,
    Rejected,
    Unconfirmed,
    Unreadable,
}

fn latest_node<'a>(
    status: &'a Value,
    template: &str,
    execution: Option<DateTime<Utc>>,
) -> Option<&'a Value> {
    nodes::nodes(status)
        .filter(|node| nodes::template(node) == Some(template) && node["type"] == "Pod")
        .filter(|node| {
            execution.is_none_or(|execution| {
                nodes::time(node, "startedAt").is_none_or(|started| started >= execution)
            })
        })
        .max_by_key(|node| nodes::time(node, "startedAt"))
}

pub(super) fn current_observation(
    wf: &DynamicObject,
    queued_at: DateTime<Utc>,
    pods: &HashMap<String, PodState>,
    workflow_end: Option<DateTime<Utc>>,
) -> Option<(StageSnapshot, bool)> {
    let (stage, lookup) = observation(wf, queued_at, pods, workflow_end);
    let retained = stage.bronze_is_provisional
        && stage.bronze_execution.is_some_and(|execution| {
            nodes::nodes(&wf.data["status"]).any(|node| {
                node["type"] == "Pod"
                    && matches!(nodes::template(node), Some("trigger-sync" | "poll-job"))
                    && nodes::time(node, "startedAt").is_some_and(|started| started < execution)
            })
        });
    (!retained).then_some((stage, lookup))
}

pub(super) fn observation(
    wf: &DynamicObject,
    queued_at: DateTime<Utc>,
    pods: &HashMap<String, PodState>,
    workflow_end: Option<DateTime<Utc>>,
) -> (StageSnapshot, bool) {
    let status = &wf.data["status"];
    let execution = nodes::time(status, "startedAt");
    let capacity = capacity_wait(wf);
    let marked = has_launch_marks(wf);
    let launch = receipt(launch_marks(wf), execution, capacity.as_ref());
    let trigger = latest_node(status, "trigger-sync", execution);
    let resolve = latest_node(status, "resolve-connection-by-name", execution);
    let poll = latest_node(status, "poll-job", execution);
    let evidence = poll
        .and_then(|node| nodes::parameter(node, "outputs", "airbyte-evidence"))
        .and_then(|body| serde_json::from_str::<airbyte::PollEvidence>(body).ok());

    let attempt = launch.as_ref().map_or_else(
        || capacity.as_ref().map_or(1, |wait| wait.attempt),
        |receipt| receipt.attempt,
    );
    let mut stage = StageSnapshot::new(
        "bronze",
        attempt,
        if attempt == 1 {
            queued_at
        } else {
            launch.as_ref().map_or_else(
                || {
                    capacity
                        .as_ref()
                        .map_or(queued_at, |wait| wait.workflow_started_at)
                },
                |receipt| receipt.workflow_started_at,
            )
        },
    );
    stage.bronze_execution = execution;
    stage.bronze_is_provisional =
        execution.is_none() || (trigger.is_none() && poll.is_none() && capacity.is_none());
    stage.connection = launch
        .as_ref()
        .map(|receipt| receipt.connection.to_string())
        .or_else(|| {
            trigger
                .into_iter()
                .chain(poll)
                .find_map(|node| nodes::parameter(node, "inputs", "connection_id"))
                .or_else(|| {
                    resolve.and_then(|node| nodes::parameter(node, "outputs", "connection_id"))
                })
                .map(str::to_owned)
        });
    stage.job = launch.as_ref().and_then(|receipt| receipt.job_id);
    if launch.is_none() {
        if capacity.is_none() && !marked {
            stage.job = legacy_job(trigger, poll);
        }
        apply_argo_phase(&mut stage, trigger, poll, workflow_end);
    }
    if let Some(capacity) = capacity.as_ref().filter(|wait| wait.attempt == attempt) {
        if capacity.ended_at.is_none()
            && workflow_end.is_some()
            && nodes::phase(status).is_some_and(|phase| matches!(phase, "Failed" | "Error"))
            && stage.status != "failed"
        {
            stage.status = "failed";
            stage.reason = Some("stage_failed".into());
        }
        apply_capacity_wait(&mut stage, capacity, workflow_end);
    }

    if let Some(receipt) = &launch
        && !apply_receipt(&mut stage, receipt, trigger, poll, workflow_end)
    {
        return (stage, false);
    }

    let evidence = evidence.filter(|v| Some(v.job_id) == stage.job);
    let lookup = evidence.is_none() && stage.job.is_some();
    if let Some(evidence) = evidence {
        evidence.apply(
            &mut stage,
            poll.and_then(|node| nodes::time(node, "finishedAt")),
        );
    } else if launch.is_some() && stage.job.is_some() {
        stage.status = "loading";
    }

    if stage.wait.is_some() {
        return (stage, lookup);
    }
    if stage.job.is_none()
        && workflow_end.is_none()
        && let Some(node) = trigger.or(resolve)
        && let Some(at) = nodes::placement(node, node["id"].as_str().and_then(|id| pods.get(id)))
    {
        stage.wait = Some(nodes::wait(WaitKind::Placement, at, None));
        stage.status = "queued";
    }

    (stage, lookup)
}

fn apply_receipt(
    stage: &mut StageSnapshot,
    receipt: &LaunchReceipt,
    trigger: Option<&Value>,
    poll: Option<&Value>,
    workflow_end: Option<DateTime<Utc>>,
) -> bool {
    stage.actual_resources = receipt.pod_request.as_ref().map(|request| Resources {
        airbyte_cpu_millis: Some(request.cpu_millis),
        airbyte_memory_bytes: Some(request.memory_bytes),
        ..Resources::default()
    });
    let reason = match receipt.outcome {
        LaunchOutcome::Rejected => Some("airbyte_launch_rejected"),
        LaunchOutcome::Unconfirmed => Some("airbyte_launch_unconfirmed"),
        LaunchOutcome::Unreadable => Some("airbyte_launch_unreadable"),
        LaunchOutcome::Pending => {
            stage.status = if workflow_end.is_some() {
                "unknown"
            } else {
                "checking_start"
            };
            stage.finished_at = workflow_end;
            None
        }
        LaunchOutcome::Accepted => None,
    };
    if let Some(reason) = reason {
        stage.status = "not_started";
        stage.reason = Some(reason.into());
        stage.finished_at = receipt_finish(receipt, trigger, poll).or(workflow_end);
        return false;
    }
    true
}

fn capacity_wait(wf: &DynamicObject) -> Option<CapacityWait> {
    let uid = wf.metadata.uid.as_deref()?.parse::<uuid::Uuid>().ok()?;
    let execution = nodes::time(&wf.data["status"], "startedAt")?;
    let raw = wf.metadata.annotations.as_ref()?.get(CAPACITY_ANNOTATION)?;
    let wait = serde_json::from_str::<CapacityWait>(raw).ok()?;
    (wait.workflow_uid == uid
        && wait.workflow_started_at == execution
        && wait.attempt > 0
        && wait.started_at >= execution
        && wait.ended_at.is_none_or(|end| end >= wait.started_at))
    .then_some(wait)
}

fn apply_capacity_wait(
    stage: &mut StageSnapshot,
    capacity: &CapacityWait,
    workflow_end: Option<DateTime<Utc>>,
) {
    let ended_at = capacity
        .ended_at
        .or_else(|| workflow_end.map(|end| end.max(capacity.started_at)));
    let wait = StageWait {
        kind: WaitKind::Placement,
        started_at: capacity.started_at,
        ended_at,
        holder: None,
    };
    if wait.ended_at.is_none() && stage.job.is_none() {
        stage.started_at = None;
        stage.finished_at = None;
        stage.reason = None;
        stage.status = "queued";
        stage.wait = Some(wait.clone());
    }
    stage.capacity_wait = Some(wait);
}

#[cfg(test)]
pub(super) fn snapshot(
    workflow: &DynamicObject,
    queued_at: DateTime<Utc>,
    pods: &HashMap<String, PodState>,
    workflow_end: Option<DateTime<Utc>>,
) -> StageSnapshot {
    observation(workflow, queued_at, pods, workflow_end).0
}

fn legacy_job(trigger: Option<&Value>, poll: Option<&Value>) -> Option<u64> {
    let parsed = |value: &str| value.trim().parse::<u64>().ok().filter(|id| *id > 0);
    poll.and_then(|node| {
        nodes::parameter(node, "outputs", "job_id")
            .or_else(|| nodes::parameter(node, "inputs", "job_id"))
            .and_then(parsed)
    })
    .or_else(|| {
        let node = trigger.filter(|node| nodes::phase(node) == Some("Succeeded"))?;
        parsed(node["outputs"]["result"].as_str()?)
    })
}

fn apply_argo_phase(
    stage: &mut StageSnapshot,
    trigger: Option<&Value>,
    poll: Option<&Value>,
    workflow_end: Option<DateTime<Utc>>,
) {
    let (status, reason) = match (poll.and_then(nodes::phase), trigger.and_then(nodes::phase)) {
        (Some("Succeeded"), _) => ("succeeded", None),
        (Some("Failed" | "Error"), _) if stage.job.is_some() => {
            ("failed", Some("airbyte_job_failed"))
        }
        (Some("Failed" | "Error"), _) | (_, Some("Failed" | "Error")) => {
            ("failed", Some("stage_failed"))
        }
        _ if workflow_end.is_some() => ("unknown", Some("stage_failed")),
        _ if stage.job.is_some() => ("loading", None),
        _ => ("starting", None),
    };
    stage.status = status;
    stage.reason = reason.map(str::to_owned);
    if matches!(status, "succeeded" | "failed" | "unknown") {
        stage.finished_at = poll
            .or(trigger)
            .and_then(|node| nodes::time(node, "finishedAt"))
            .or(workflow_end);
    }
}

fn has_launch_marks(wf: &DynamicObject) -> bool {
    wf.metadata
        .annotations
        .as_ref()
        .is_some_and(|a| a.contains_key(LAUNCH_ANNOTATION))
        || nodes::nodes(&wf.data["status"])
            .filter(|node| matches!(nodes::template(node), Some("trigger-sync" | "poll-job")))
            .any(|node| nodes::parameter(node, "outputs", "airbyte-launch-evidence").is_some())
}

fn launch_marks(wf: &DynamicObject) -> Vec<LaunchReceipt> {
    let Some(uid) = wf
        .metadata
        .uid
        .as_deref()
        .and_then(|uid| uid.parse::<uuid::Uuid>().ok())
    else {
        return Vec::new();
    };
    let annotation = wf
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get(LAUNCH_ANNOTATION))
        .map(String::as_str);
    let outputs = nodes::nodes(&wf.data["status"])
        .filter(|node| matches!(nodes::template(node), Some("trigger-sync" | "poll-job")))
        .filter_map(|node| nodes::parameter(node, "outputs", "airbyte-launch-evidence"));
    annotation
        .into_iter()
        .chain(outputs)
        .filter_map(|value| serde_json::from_str::<LaunchReceipt>(value).ok())
        .filter(|receipt| receipt.workflow_uid == uid && receipt.attempt > 0)
        .collect()
}

fn receipt(
    marks: Vec<LaunchReceipt>,
    execution: Option<DateTime<Utc>>,
    capacity: Option<&CapacityWait>,
) -> Option<LaunchReceipt> {
    marks
        .into_iter()
        .filter(|receipt| {
            execution.is_none_or(|execution| receipt.workflow_started_at == execution)
                && capacity.is_none_or(|wait| {
                    receipt.workflow_started_at == wait.workflow_started_at
                        && receipt.attempt >= wait.attempt
                })
        })
        .max_by_key(|receipt| {
            (
                receipt.attempt,
                receipt.workflow_started_at,
                receipt.outcome != LaunchOutcome::Pending,
                receipt.pod_request.is_some(),
            )
        })
}

fn receipt_finish(
    receipt: &LaunchReceipt,
    trigger: Option<&Value>,
    poll: Option<&Value>,
) -> Option<DateTime<Utc>> {
    trigger
        .into_iter()
        .chain(poll)
        .filter(|node| {
            nodes::time(node, "startedAt").is_some_and(|at| at >= receipt.workflow_started_at)
        })
        .filter_map(|node| nodes::time(node, "finishedAt"))
        .max()
        .or(receipt.outcome_at)
}
