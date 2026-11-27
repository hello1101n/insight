use kube::api::DynamicObject;
use serde_json::Value;

use super::{StageSnapshot, invocation, nodes};
use crate::domain::connector_schedules::resources::{
    DBT_POD_PATCH, DBT_QUERY_MEMORY_ENV, IDENTITY_POD_PATCH, PARAMETER, Resources,
};

pub(super) fn observe_resources(workflow: &DynamicObject, stages: &mut [StageSnapshot]) {
    let Some((invocation, _)) = invocation(&workflow.data["spec"]) else {
        return;
    };
    let bronze = bronze_resources(invocation);
    let dbt_patch = pod_patch(invocation, DBT_POD_PATCH);
    let dbt = Resources {
        dbt_cpu_millis: cpu_millis(&dbt_patch),
        dbt_memory_bytes: memory_bytes(&dbt_patch),
        dbt_query_memory_bytes: query_memory_bytes(&dbt_patch),
        ..Resources::default()
    };
    let identity_patch = pod_patch(invocation, IDENTITY_POD_PATCH);
    let identity = Resources {
        identity_cpu_millis: cpu_millis(&identity_patch),
        identity_memory_bytes: memory_bytes(&identity_patch),
        ..Resources::default()
    };

    for stage in stages {
        let settings = match stage.stage {
            "bronze" => &bronze,
            "identity-seed" => &identity,
            _ => &dbt,
        };
        stage.resources = (!settings.is_empty()).then(|| settings.clone());
    }
}

fn bronze_resources(invocation: &Value) -> Resources {
    let Some(raw) = nodes::parameter(invocation, "arguments", PARAMETER) else {
        return Resources::default();
    };
    match Resources::parse(raw) {
        Ok(settings) => Resources {
            airbyte_cpu_millis: settings.airbyte_cpu_millis,
            airbyte_memory_bytes: settings.airbyte_memory_bytes,
            ..Resources::default()
        },
        Err(error) => {
            tracing::warn!(%error, "The Workflow resource settings are invalid.");
            Resources::default()
        }
    }
}

fn pod_patch(invocation: &Value, parameter: &str) -> Value {
    let Some(raw) = nodes::parameter(invocation, "arguments", parameter) else {
        return Value::Null;
    };
    let mut patch: Value = match serde_json::from_str(raw) {
        Ok(patch) => patch,
        Err(error) => {
            tracing::warn!(%error, parameter, "The Workflow pod patch is invalid.");
            return Value::Null;
        }
    };
    let Some(Value::Array(containers)) = patch.get_mut("containers").map(Value::take) else {
        return Value::Null;
    };
    containers
        .into_iter()
        .find(|container| container["name"] == "main")
        .unwrap_or(Value::Null)
}

fn cpu_millis(container: &Value) -> Option<u32> {
    container["resources"]["requests"]["cpu"]
        .as_str()?
        .strip_suffix('m')?
        .parse()
        .ok()
}

fn memory_bytes(container: &Value) -> Option<u64> {
    container["resources"]["requests"]["memory"]
        .as_str()?
        .parse()
        .ok()
}

fn query_memory_bytes(container: &Value) -> Option<u64> {
    let env = container["env"].as_array()?;
    let query_memory = env
        .iter()
        .find(|entry| entry["name"] == DBT_QUERY_MEMORY_ENV)?;
    query_memory["value"].as_str()?.parse().ok()
}
