use std::collections::BTreeMap;

use super::*;
use crate::test_support::ResourceParameterFixture;

type R = Result<(), Box<dyn std::error::Error>>;

#[test]
fn cron_workflow_uses_the_shared_resource_parameter_contract() -> R {
    let ResourceParameterFixture {
        parameters: names,
        cases,
    } = ResourceParameterFixture::load()?;
    for case in cases {
        let workflow = serde_json::from_value(json!({
            "metadata": {"uid": "example-uid", "resourceVersion": "1"},
            "spec": {"workflowSpec": {"arguments": {"parameters": [
                {"name": "insight_source_id", "value": "main"},
                {"name": names.sync, "value": "{}"},
                {"name": names.dbt, "value": "{}"},
                {"name": names.identity, "value": "{}"}
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
            (names.dbt.as_str(), case.dbt_pod_patch.as_str()),
            (names.identity.as_str(), case.identity_pod_patch.as_str()),
        ]);
        if case.sync_resources != "{}" {
            expected.insert(&names.sync, &case.sync_resources);
        }

        assert_eq!(actual, expected, "{}", case.name);
        assert_eq!(entries.len(), expected.len(), "{}", case.name);
    }
    Ok(())
}
