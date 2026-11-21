use super::{AppState, Observation, PERIOD, StageRow, nodes, observe_work};
use anyhow::{Context, Result};
use kube::{
    Api,
    api::{DynamicObject, Patch, PatchParams},
};
use serde_json::json;

pub(crate) fn key(stage: &str, attempt: u32) -> String {
    format!("insight.cyberfabric.com/start-{stage}-{attempt}")
}

pub(crate) async fn decide(
    api: &Api<DynamicObject>,
    wf: &DynamicObject,
    key: &str,
    expire: bool,
) -> Result<()> {
    let uid = wf.metadata.uid.as_deref().context("missing Workflow UID")?;
    let version = wf
        .metadata
        .resource_version
        .as_deref()
        .context("missing Workflow version")?;
    let mut patch = json!({"metadata":{"uid":uid,"resourceVersion":version,
        "annotations":{(key):if expire {"wait_timeout"} else {uid}}}});
    if expire {
        patch["spec"] = json!({"shutdown":"Terminate"});
    }
    let name = wf
        .metadata
        .name
        .as_deref()
        .context("missing Workflow name")?;
    tokio::time::timeout(
        PERIOD,
        api.patch(name, &PatchParams::default(), &Patch::Merge(patch)),
    )
    .await??;
    Ok(())
}

pub(super) async fn observe(
    state: &AppState,
    api: &Api<DynamicObject>,
    http: &reqwest::Client,
    row: &StageRow,
    wf: &DynamicObject,
    terminal: bool,
) -> Result<Observation> {
    let status = &wf.data["status"];
    let key = key(&row.stage, row.attempt);
    let marker = wf
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get(&key))
        .map(String::as_str);
    let mut effective = row.clone();
    if marker == Some("wait_timeout") {
        effective.status = "stopping_pod_wait".into();
    }
    let mut o = observe_work(state, http, &effective, status, terminal).await?;
    if o.status.as_deref() == Some("stopping_pod_wait")
        && row.stage != "bronze"
        && marker != Some("wait_timeout")
    {
        if marker.is_none()
            && nodes::work(status, row).is_some_and(nodes::guarded)
            && wf.data["spec"]["shutdown"]
                .as_str()
                .unwrap_or_default()
                .is_empty()
        {
            decide(api, wf, &key, true).await?;
        } else {
            o.status = Some("placement_overdue".into());
        }
    }
    Ok(o)
}
