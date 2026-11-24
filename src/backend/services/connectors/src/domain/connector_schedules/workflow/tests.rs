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

#[test]
fn a_missing_pod_patch_reads_as_the_template_default() -> R {
    let names = ResourceParameterFixture::load()?.parameters;
    let workflow = |parameters: Value| -> Result<DynamicObject, serde_json::Error> {
        serde_json::from_value(json!({
            "metadata": {"uid": "example-uid", "resourceVersion": "1"},
            "spec": {"workflowSpec": {"arguments": {"parameters": parameters}}}
        }))
    };

    let legacy = workflow(json!([{"name": "insight_source_id", "value": "main"}]))?;
    assert_eq!(
        live_pod_patches(&legacy),
        [Some("{}".to_owned()), Some("{}".to_owned())]
    );

    let duplicated = workflow(json!([
        {"name": names.dbt, "value": "{}"},
        {"name": names.dbt, "value": "{}"},
        {"name": names.identity, "value": 1}
    ]))?;
    assert_eq!(live_pod_patches(&duplicated), [None, None]);
    Ok(())
}
