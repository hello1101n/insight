use std::collections::BTreeMap;

use serde::Deserialize;

use super::*;

type R = Result<(), Box<dyn std::error::Error>>;

#[test]
fn cron_workflow_uses_the_shared_resource_parameter_contract() -> R {
    #[derive(Debug, Deserialize)]
    struct Case {
        name: String,
        requested: Resources,
        defaults: Resources,
        sync_resources: String,
        dbt_pod_patch: String,
        identity_pod_patch: String,
    }

    let cases: Vec<Case> = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../tests/fixtures/connector-resource-parameters.json"
    )))?;
    for case in cases {
        let workflow = serde_json::from_value(json!({
            "metadata": {"uid": "example-uid", "resourceVersion": "1"},
            "spec": {"workflowSpec": {"arguments": {"parameters": [
                {"name": "insight_source_id", "value": "main"},
                {"name": "sync_resources", "value": "{}"},
                {"name": "dbt_pod_patch", "value": "{}"},
                {"name": "identity_pod_patch", "value": "{}"}
            ]}}}
        }))?;
        let effective = case
            .requested
            .validate()?
            .resolve(&case.defaults.validate()?);
        let patch = patch_resources(&workflow, &effective)?;
        let patched = serde_json::from_value(patch)?;
        let entries = parameters(&patched)?;
        let actual: BTreeMap<_, _> = entries
            .iter()
            .filter_map(|p| Some((p["name"].as_str()?, p["value"].as_str()?)))
            .collect();

        let mut expected = BTreeMap::from([
            ("insight_source_id", "main"),
            ("dbt_pod_patch", case.dbt_pod_patch.as_str()),
            ("identity_pod_patch", case.identity_pod_patch.as_str()),
        ]);
        if case.sync_resources != "{}" {
            expected.insert("sync_resources", &case.sync_resources);
        }

        assert_eq!(actual, expected, "{}", case.name);
        assert_eq!(entries.len(), expected.len(), "{}", case.name);
    }
    Ok(())
}
