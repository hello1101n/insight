use std::collections::HashMap;

use chrono::{DateTime, Utc};
use kube::api::DynamicObject;
use serde::Deserialize;
use serde_json::Value;

use super::{airbyte, nodes, pods::PodState};
use crate::domain::run_history::{StageSnapshot, WaitKind};

const LAUNCH_ANNOTATION: &str = "insight.cyberfabric.com/airbyte-launch";

#[derive(Debug, Deserialize)]
struct LaunchReceipt {
    workflow_uid: uuid::Uuid,
    workflow_started_at: DateTime<Utc>,
    attempt: u32,
    connection: uuid::Uuid,
    outcome: LaunchOutcome,
    job_id: Option<u64>,
    outcome_at: Option<DateTime<Utc>>,
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

fn latest_node<'a>(status: &'a Value, template: &str) -> Option<&'a Value> {
    nodes::nodes(status)
        .filter(|node| nodes::template(node) == Some(template) && node["type"] == "Pod")
        .max_by_key(|node| nodes::time(node, "startedAt"))
}

pub(super) fn observation(
    wf: &DynamicObject,
    queued_at: DateTime<Utc>,
    pods: &HashMap<String, PodState>,
    workflow_end: Option<DateTime<Utc>>,
) -> (StageSnapshot, bool) {
    let status = &wf.data["status"];
    let launch = receipt(wf);
    let trigger = latest_node(status, "trigger-sync");
    let resolve = latest_node(status, "resolve-connection-by-name");
    let poll = latest_node(status, "poll-job");
    let evidence = poll
        .and_then(|node| nodes::parameter(node, "outputs", "airbyte-evidence"))
        .and_then(|body| serde_json::from_str::<airbyte::PollEvidence>(body).ok());

    let attempt = launch.as_ref().map_or(1, |receipt| receipt.attempt);
    let mut stage = StageSnapshot::new(
        "bronze",
        attempt,
        if attempt == 1 {
            queued_at
        } else {
            launch
                .as_ref()
                .map_or(queued_at, |receipt| receipt.workflow_started_at)
        },
    );
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
        stage.job = legacy_job(trigger, poll);
        apply_argo_phase(&mut stage, trigger, poll, workflow_end);
    }

    if let Some(receipt) = &launch {
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
            return (stage, false);
        }
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

    if workflow_end.is_none()
        && let Some(at) = nodes::bronze_slot_wait(status)
    {
        stage.wait = Some(nodes::wait(WaitKind::SyncSlot, at, None));
        stage.status = "queued";
    } else if stage.job.is_none()
        && workflow_end.is_none()
        && let Some(node) = trigger.or(resolve)
        && let Some(at) = nodes::placement(node, node["id"].as_str().and_then(|id| pods.get(id)))
    {
        stage.wait = Some(nodes::wait(WaitKind::Placement, at, None));
        stage.status = "queued";
    }

    (stage, lookup)
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
        (Some("Failed" | "Error"), _) => ("failed", Some("airbyte_job_failed")),
        (_, Some("Failed" | "Error")) => ("failed", Some("stage_failed")),
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

fn receipt(wf: &DynamicObject) -> Option<LaunchReceipt> {
    let uid = wf.metadata.uid.as_deref()?.parse::<uuid::Uuid>().ok()?;
    let annotation = wf
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get(LAUNCH_ANNOTATION))
        .map(String::as_str);
    let outputs = nodes::nodes(&wf.data["status"])
        .filter(|node| nodes::template(node) == Some("trigger-sync"))
        .filter_map(|node| nodes::parameter(node, "outputs", "airbyte-launch-evidence"));
    annotation
        .into_iter()
        .chain(outputs)
        .filter_map(|value| serde_json::from_str::<LaunchReceipt>(value).ok())
        .filter(|receipt| receipt.workflow_uid == uid && receipt.attempt > 0)
        .max_by_key(|receipt| {
            (
                receipt.attempt,
                receipt.workflow_started_at,
                receipt.outcome != LaunchOutcome::Pending,
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
