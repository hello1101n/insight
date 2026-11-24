use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde_json::Value;

use super::pods::PodState;
use crate::domain::run_history::{StageSnapshot, StageWait, WaitKind};

pub(super) fn time(value: &Value, field: &str) -> Option<DateTime<Utc>> {
    value[field]
        .as_str()?
        .parse::<DateTime<Utc>>()
        .ok()
        .filter(|value| *value >= DateTime::UNIX_EPOCH)
}

pub(super) fn nodes(status: &Value) -> impl Iterator<Item = &Value> {
    status["nodes"]
        .as_object()
        .into_iter()
        .flat_map(|map| map.values())
}

pub(super) fn parameter<'a>(object: &'a Value, field: &str, name: &str) -> Option<&'a str> {
    object[field]["parameters"]
        .as_array()?
        .iter()
        .find(|param| param["name"] == name)?["value"]
        .as_str()
}

pub(super) fn template(node: &Value) -> Option<&str> {
    node["templateName"]
        .as_str()
        .or_else(|| node["templateRef"]["template"].as_str())
}

pub(super) fn phase(node: &Value) -> Option<&str> {
    node["phase"].as_str()
}

fn stage_name(node: &Value) -> Option<&'static str> {
    let name = node["displayName"].as_str()?.split('(').next()?;
    match name {
        "transform-staging" => Some("transform-staging"),
        "transform-jira-staging" => Some("transform-jira-staging"),
        "transform-legacy" => Some("transform-legacy"),
        "transform-jira-silver" => Some("transform-jira-silver"),
        "identity-seed" => Some("identity-seed"),
        "connector-checks" => Some("connector-checks"),
        _ => None,
    }
}

pub(super) fn waiting_lock(node: &Value) -> Option<&str> {
    if phase(node) != Some("Pending") {
        return None;
    }
    node["synchronizationStatus"]["waiting"]
        .as_str()
        .filter(|lock| !lock.is_empty())
}

pub(super) fn bronze_slot_wait(status: &Value) -> Option<DateTime<Utc>> {
    nodes(status).find_map(|node| {
        let lock = waiting_lock(node)?;
        if lock.ends_with("/insight-sync-limits/bronze") {
            return time(node, "startedAt");
        }
        if template(node) == Some("pipeline") && lock.ends_with("/insight-sync-limits/syncs") {
            return time(status, "startedAt").or_else(|| time(node, "startedAt"));
        }
        None
    })
}

fn mutex_holder(status: &Value, lock: &str) -> Option<String> {
    let entry = status["synchronization"]["mutex"]["waiting"]
        .as_array()?
        .iter()
        .find(|entry| entry["mutex"] == lock)?;
    let key = entry["holder"]
        .as_str()
        .or_else(|| entry["holders"].as_array()?.first()?.as_str())?;
    key.split('/')
        .nth(1)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

pub(super) fn wait(kind: WaitKind, started_at: DateTime<Utc>, holder: Option<String>) -> StageWait {
    StageWait {
        kind,
        started_at,
        ended_at: None,
        holder,
    }
}

pub(super) fn placement(node: &Value, pod: Option<&PodState>) -> Option<DateTime<Utc>> {
    if phase(node) != Some("Pending") {
        return None;
    }
    if let Some(pod) = pod {
        return pod.unscheduled_at;
    }
    let message = node["message"].as_str()?;
    if message.contains("exceeded quota:") || message.contains("Unschedulable") {
        return time(node, "startedAt");
    }
    None
}

fn attempt(
    status: &Value,
    node: &Value,
    stage: &'static str,
    ordinal: u32,
    pod: Option<&PodState>,
    workflow_end: Option<DateTime<Utc>>,
) -> Option<StageSnapshot> {
    let mut result = StageSnapshot::new(stage, ordinal, time(node, "startedAt")?);
    result.started_at = pod.and_then(|v| v.started_at);
    result.query_pod = pod.and_then(|v| v.uid).or_else(|| {
        let name = if stage == "identity-seed" {
            "query-pod-uid"
        } else {
            "dbt-pod-uid"
        };
        parameter(node, "outputs", name)?.parse().ok()
    });
    result.finished_at = time(node, "finishedAt").or(workflow_end);
    let check_failed = stage == "connector-checks"
        && parameter(node, "outputs", "dbt-exit-code")
            .and_then(|code| code.parse::<u8>().ok())
            .is_some_and(|code| code != 0);
    result.status = match phase(node) {
        Some("Succeeded") if check_failed => "failed",
        Some("Succeeded") => "succeeded",
        Some("Failed" | "Error") => "failed",
        _ if workflow_end.is_some() => "cancelled",
        Some("Running") => "transforming",
        _ => "starting",
    };
    if result.status == "failed" {
        result.reason = if pod.is_some_and(|pod| pod.oom)
            || node["message"]
                .as_str()
                .is_some_and(|message| message.contains("OOMKilled"))
        {
            Some("pod_oom".to_owned())
        } else if check_failed {
            Some("connector_checks_failed".to_owned())
        } else {
            node["message"]
                .as_str()
                .filter(|v| !v.is_empty())
                .map(|v| v.chars().take(255).collect())
        };
    }
    if result.finished_at.is_none() {
        result.wait = if let Some(lock) = waiting_lock(node) {
            if stage == "connector-checks" && lock.ends_with("/insight-sync-limits/checks") {
                Some(wait(WaitKind::CheckSlot, result.queued_at, None))
            } else {
                Some(wait(
                    WaitKind::Lock,
                    result.queued_at,
                    mutex_holder(status, lock),
                ))
            }
        } else {
            placement(node, pod).map(|at| wait(WaitKind::Placement, at, None))
        };
        if result.wait.is_some() {
            result.status = "queued";
        }
    }
    Some(result)
}

pub(super) fn transforms(
    status: &Value,
    pods: &HashMap<String, PodState>,
    workflow_end: Option<DateTime<Utc>>,
) -> Vec<StageSnapshot> {
    let mut attempts = Vec::new();
    let indices: HashMap<&str, (u32, DateTime<Utc>)> = nodes(status)
        .filter(|node| node["type"] == "Retry")
        .flat_map(|parent| {
            parent["children"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
                .filter_map(move |(index, child)| {
                    let id = child.as_str()?;
                    let ordinal = u32::try_from(index).ok()?.checked_add(1)?;
                    Some((id, (ordinal, time(parent, "startedAt")?)))
                })
        })
        .collect();
    for node in nodes(status) {
        let Some(stage) = stage_name(node) else {
            continue;
        };
        let Some(id) = node["id"].as_str() else {
            continue;
        };
        let pod = pods.get(id);
        let ordinal = match node["type"].as_str() {
            Some("Pod") => indices.get(id).map_or(1, |(ordinal, _)| *ordinal),
            Some("Retry") if node["children"].as_array().is_none_or(Vec::is_empty) => 1,
            _ => continue,
        };
        if let Some(mut attempt) = attempt(status, node, stage, ordinal, pod, workflow_end) {
            if let Some((1, queued)) = indices.get(id) {
                attempt.queued_at = attempt.queued_at.min(*queued);
            }
            attempts.push(attempt);
        }
    }
    attempts
}
