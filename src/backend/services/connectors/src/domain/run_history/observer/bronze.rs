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

pub(super) fn snapshot(
    wf: &DynamicObject,
    queued_at: DateTime<Utc>,
    pods: &HashMap<String, PodState>,
    workflow_end: Option<DateTime<Utc>>,
) -> StageSnapshot {
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
                .and_then(|node| nodes::parameter(node, "inputs", "connection_id"))
                .map(str::to_owned)
        });
    stage.job = launch.as_ref().and_then(|receipt| receipt.job_id);

    let receipt_reason = launch.as_ref().and_then(|launch| match launch.outcome {
        LaunchOutcome::Rejected => Some("airbyte_launch_rejected"),
        LaunchOutcome::Unconfirmed => Some("airbyte_launch_unconfirmed"),
        LaunchOutcome::Unreadable => Some("airbyte_launch_unreadable"),
        LaunchOutcome::Pending => {
            stage.status = "checking_start";
            None
        }
        LaunchOutcome::Accepted => None,
    });
    let execution = nodes::time(status, "startedAt").unwrap_or(queued_at);
    let exited = trigger
        .into_iter()
        .chain(poll)
        .filter(|node| nodes::time(node, "startedAt").is_some_and(|at| at >= execution));
    let failure = exited
        .filter_map(|node| {
            let reason = match node["outputs"]["exitCode"].as_str()? {
                "42" => "airbyte_launch_rejected",
                "43" => "airbyte_launch_unconfirmed",
                "44" => "airbyte_launch_unreadable",
                _ => return None,
            };
            Some((reason, nodes::time(node, "finishedAt")))
        })
        .max_by_key(|(_, finish)| *finish);
    let (reason, finished_at) = failure.unwrap_or_else(|| {
        (
            receipt_reason.unwrap_or_default(),
            receipt_finish(launch.as_ref(), trigger, poll).or(workflow_end),
        )
    });
    if !reason.is_empty() {
        stage.status = "not_started";
        stage.reason = Some(reason.into());
        stage.finished_at = finished_at;
        return stage;
    }

    if let Some(evidence) = evidence.filter(|v| Some(v.job_id) == stage.job) {
        evidence.apply(
            &mut stage,
            poll.and_then(|node| nodes::time(node, "finishedAt")),
        );
    } else if stage.job.is_none() && workflow_end.is_some() {
        let pending = stage.status == "checking_start";
        stage.status = if pending { "unknown" } else { "not_started" };
        stage.reason = (!pending).then(|| "stage_failed".to_owned());
        stage.finished_at = workflow_end;
    } else if stage.job.is_some() {
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

    stage
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
    receipt: Option<&LaunchReceipt>,
    trigger: Option<&Value>,
    poll: Option<&Value>,
) -> Option<DateTime<Utc>> {
    let receipt = receipt?;
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
