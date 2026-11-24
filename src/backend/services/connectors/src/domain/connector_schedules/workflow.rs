use kube::api::DynamicObject;
use serde_json::{Value, json};

use super::dto::{InheritedSchedule, LiveSchedule, ScheduleOrigin};
use super::{Error, Instance, Resources, resources, validation::Crons};

#[cfg(test)]
mod tests;

pub(super) const DEPLOYMENT: &str = "insight.cyberfabric.com/deployment-schedule";
pub(super) const ORIGIN: &str = "insight.cyberfabric.com/schedule-origin";

pub(crate) fn identity_matches(
    object: &DynamicObject,
    instance: &Instance,
    namespace: &str,
    tenant_id: &str,
) -> bool {
    let metadata = &object.metadata;
    let Some(labels) = &metadata.labels else {
        return false;
    };
    let parameters = object
        .data
        .pointer("/spec/workflowSpec/arguments/parameters")
        .and_then(Value::as_array);
    let Some(parameters) = parameters else {
        return false;
    };
    if parameters.iter().any(|p| !p.is_object()) {
        return false;
    }
    let sources: Vec<_> = parameters
        .iter()
        .filter(|p| p["name"] == "insight_source_id")
        .collect();
    metadata.name.as_deref() == instance.workflow_name(tenant_id).ok().as_deref()
        && metadata.namespace.as_deref() == Some(namespace)
        && labels
            .get("insight.cyberfabric.com/connector")
            .map(String::as_str)
            == Some(instance.connector.as_str())
        && labels
            .get("insight.cyberfabric.com/tenant")
            .map(String::as_str)
            == Some(tenant_id)
        && labels
            .get("app.kubernetes.io/component")
            .map(String::as_str)
            == Some("connector-sync")
        && sources.len() == 1
        && sources[0]["value"] == instance.source_id.as_str()
}

pub(super) fn live(object: &DynamicObject) -> Result<LiveSchedule, Error> {
    let spec = &object.data["spec"];
    let crons = serde_json::from_value(spec["schedules"].clone()).map_err(Error::StoredCrons)?;
    let timezone = spec
        .get("timezone")
        .map(|v| v.as_str().map(str::to_owned).ok_or(Error::ClusterIdentity))
        .transpose()?;
    let suspended = spec
        .get("suspend")
        .map(|v| v.as_bool().ok_or(Error::ClusterIdentity))
        .transpose()?
        .unwrap_or(false);
    let origin = object
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get(ORIGIN))
        .and_then(|s| serde_json::from_value(json!(s)).ok());
    Ok(LiveSchedule {
        crons,
        timezone,
        origin,
        suspended,
        observed_at: chrono::Utc::now(),
    })
}

pub(super) fn inherited(object: &DynamicObject) -> Option<InheritedSchedule> {
    let raw = object.metadata.annotations.as_ref()?.get(DEPLOYMENT)?;
    let schedule: InheritedSchedule = serde_json::from_str(raw).ok()?;
    if schedule.origin == ScheduleOrigin::Api || Crons::parse(&schedule.crons).is_err() {
        return None;
    }
    Some(schedule)
}

pub(super) fn desired(
    requested: &[String],
    inherited: Option<InheritedSchedule>,
) -> Option<InheritedSchedule> {
    if requested.is_empty() {
        return inherited;
    }
    Some(InheritedSchedule {
        crons: requested.to_vec(),
        origin: ScheduleOrigin::Api,
    })
}

pub(super) fn matches(live: &LiveSchedule, target: &InheritedSchedule) -> bool {
    live.crons == target.crons
        && live.timezone.as_deref() == Some("UTC")
        && live.origin == Some(target.origin)
}

pub(super) fn patch(object: &DynamicObject, target: &InheritedSchedule) -> Result<Value, Error> {
    let uid = object
        .metadata
        .uid
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or(Error::ClusterIdentity)?;
    let version = object
        .metadata
        .resource_version
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or(Error::ClusterIdentity)?;
    Ok(json!({
        "metadata": {"uid": uid, "resourceVersion": version, "annotations": {ORIGIN: target.origin}},
        "spec": {"schedules": target.crons, "timezone": "UTC"}
    }))
}

pub(super) fn live_resources(object: &DynamicObject) -> Result<Resources, Error> {
    let mut entries = parameters(object)?
        .iter()
        .filter(|p| p["name"] == resources::PARAMETER);
    let Some(entry) = entries.next() else {
        return Ok(Resources::default());
    };
    if entries.next().is_some() {
        return Err(Error::ClusterIdentity);
    }
    Resources::parse(entry["value"].as_str().ok_or(Error::ClusterIdentity)?)
}

pub(super) fn resource_defaults(object: &DynamicObject) -> Result<Resources, Error> {
    object
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get(resources::DEPLOYMENT))
        .map_or_else(|| Ok(Resources::default()), |raw| Resources::parse(raw))
}

pub(super) fn live_pod_patches(object: &DynamicObject) -> [Option<String>; 2] {
    let Ok(parameters) = parameters(object) else {
        return Default::default();
    };
    resources::POD_PATCH_PARAMETERS.map(|name| {
        let mut entries = parameters.iter().filter(|p| p["name"] == name);
        let Some(entry) = entries.next() else {
            return Some("{}".to_owned());
        };
        let value = entry["value"].as_str()?;
        entries.next().is_none().then(|| value.to_owned())
    })
}

fn parameters(object: &DynamicObject) -> Result<&Vec<Value>, Error> {
    object
        .data
        .pointer("/spec/workflowSpec/arguments/parameters")
        .and_then(Value::as_array)
        .ok_or(Error::ClusterIdentity)
}

pub(super) fn patch_resources(object: &DynamicObject, target: &Resources) -> Result<Value, Error> {
    let uid = object
        .metadata
        .uid
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or(Error::ClusterIdentity)?;
    let version = object
        .metadata
        .resource_version
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or(Error::ClusterIdentity)?;
    let mut parameters = parameters(object)?.clone();
    parameters.retain(|p| {
        p["name"] != resources::PARAMETER
            && !p["name"]
                .as_str()
                .is_some_and(|name| resources::POD_PATCH_PARAMETERS.contains(&name))
    });
    if !target.is_empty() {
        let value = serde_json::to_string(target).map_err(Error::StoredResources)?;
        parameters.push(json!({"name": resources::PARAMETER, "value": value}));
    }
    for (name, value) in resources::POD_PATCH_PARAMETERS
        .into_iter()
        .zip(target.pod_patches())
    {
        parameters.push(json!({"name": name, "value": value}));
    }
    let mut metadata = json!({"uid": uid, "resourceVersion": version});
    let has_airbyte = |resources: &Resources| {
        resources.airbyte_cpu_millis.is_some() || resources.airbyte_memory_bytes.is_some()
    };
    if has_airbyte(target) || live_resources(object).is_ok_and(|current| has_airbyte(&current)) {
        metadata["annotations"]["insight.cyberfabric.com/airbyte-resources-managed"] =
            json!("true");
    }
    Ok(json!({
        "metadata": metadata,
        "spec": {"workflowSpec": {"arguments": {"parameters": parameters}}}
    }))
}
