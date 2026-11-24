use std::time::Duration;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use kube::{
    Api,
    api::{DynamicObject, Patch, PatchParams},
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::domain::run_history::{RunSnapshot, StageSnapshot, WaitKind};

pub(super) const ANNOTATION: &str = "insight.cyberfabric.com/wait-timeout";
const WAIT_LIMIT: chrono::Duration = chrono::Duration::hours(6);

#[derive(Debug, Serialize, Deserialize)]
struct Marker {
    uid: String,
    execution: DateTime<Utc>,
    stage: String,
    attempt: u32,
}

pub(super) fn apply(workflow: &DynamicObject, run: &mut RunSnapshot) {
    let marker = workflow
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get(ANNOTATION))
        .and_then(|value| serde_json::from_str::<Marker>(value).ok());
    let Some(marker) = marker.filter(|m| m.uid == run.uid && m.execution == run.execution) else {
        return;
    };
    if let Some(stage) = run
        .stages
        .iter_mut()
        .find(|s| s.stage == marker.stage && s.attempt == marker.attempt)
    {
        stage.status = "wait_timeout";
        stage.reason = Some("wait_timeout".into());
        stage.wait = None;
        stage.finished_at = stage.finished_at.or(run.finished_at);
        if run.finished_at.is_some() {
            run.status = Some("wait_timeout");
        }
    }
}

pub(super) fn expired(run: &RunSnapshot, now: DateTime<Utc>) -> Option<&StageSnapshot> {
    if run.finished_at.is_some() {
        return None;
    }
    run.stages.iter().find(|stage| {
        stage.status == "queued"
            && stage.started_at.is_none()
            && stage.wait.as_ref().is_some_and(|wait| {
                matches!(wait.kind, WaitKind::Lock | WaitKind::SyncSlot)
                    && now - wait.started_at > WAIT_LIMIT
            })
    })
}

pub(super) async fn stop(
    api: &Api<DynamicObject>,
    wf: &DynamicObject,
    run: &RunSnapshot,
    now: DateTime<Utc>,
) -> Result<()> {
    let Some(stage) = expired(run, now) else {
        return Ok(());
    };
    if wf.data["spec"]["shutdown"]
        .as_str()
        .is_some_and(|v| !v.is_empty())
    {
        return Ok(());
    }
    let uid = wf.metadata.uid.as_deref().context("missing Workflow UID")?;
    let version = wf
        .metadata
        .resource_version
        .as_deref()
        .context("missing Workflow version")?;
    let name = wf
        .metadata
        .name
        .as_deref()
        .context("missing Workflow name")?;
    let marker = serde_json::to_string(&Marker {
        uid: uid.to_owned(),
        execution: run.execution,
        stage: stage.stage.to_owned(),
        attempt: stage.attempt,
    })?;
    let patch = json!({
        "metadata": {
            "uid": uid,
            "resourceVersion": version,
            "annotations": {(ANNOTATION): marker},
        },
        "spec": {"shutdown": "Terminate", "activeDeadlineSeconds": 0},
    });
    tokio::time::timeout(
        Duration::from_secs(5),
        api.patch(name, &PatchParams::default(), &Patch::Merge(patch)),
    )
    .await??;
    Ok(())
}
