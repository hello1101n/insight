use super::*;
use crate::infra::cluster_stub::Scenario;
use crate::test_support::{
    ResourceParameterCase, ResourceParameterFixture, ResourceParameterNames,
};

async fn patch(
    h: &Harness,
    history: &Mock,
    uri: &str,
    revision: &str,
    patch: &Value,
) -> Result<axum::response::Response, Box<dyn std::error::Error>> {
    history.add(handlers::provide([configured_instance_record()]));
    let revision = format!("\"{revision}\"");
    let request = request("PATCH", uri, Some(&revision), patch)?;
    Ok(h.app.clone().oneshot(request).await?)
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn refusing_resource_settings_restores_the_row_and_keeps_the_live_schedule() -> R {
    let Some(db) = connect_or_skip().await? else {
        return Ok(());
    };
    let fixture = ResourceParameterFixture::load()?;
    let case = fixture
        .cases
        .iter()
        .find(|case| case.name == "query cap and pod defaults")
        .ok_or("missing resource case")?;
    let (connector, uri) = identity();
    let history = Mock::new();
    let h = harness_for_cluster(
        db.clone(),
        history.url(),
        context("user", &[])?,
        true,
        Scenario::Accept,
        &connector,
    )
    .await?;
    let (status, schedule) =
        send((&h, &history), "PUT", &uri, Some("\"0\""), &["0 6 * * *"]).await?;
    assert_eq!(status, StatusCode::OK);
    let mut workflow = h.workflow.object().await;
    workflow["metadata"]["annotations"]["insight.cyberfabric.com/deployment-resources"] =
        json!(serde_json::to_string(&case.defaults)?);
    h.workflow.replace(workflow, Scenario::Accept).await;

    let saved = patch(
        &h,
        &history,
        &uri,
        "1",
        &json!({"dbt_cpu_millis": 1200,"dbt_query_memory_bytes": 5_368_709_120_u64}),
    )
    .await?;
    assert_eq!(saved.status(), StatusCode::OK);
    assert_eq!(saved.headers()["etag"], "\"2\"");
    let saved = body(saved).await?;
    assert_eq!(saved["requested"], schedule["requested"]);
    assert_eq!(saved["resources"]["status"], "applied");
    let mut expected_live: Value = serde_json::from_str(&case.sync_resources)?;
    expected_live["dbt_cpu_millis"] = json!(1200);
    assert_eq!(saved["resources"]["live"], expected_live);
    let before = Entity::find_by_id((connector.clone(), "main".to_owned()))
        .one(&db)
        .await?;
    let workflow = h.workflow.object().await;
    h.workflow
        .replace(workflow.clone(), Scenario::Refuse(403))
        .await;

    let refused = patch(&h, &history, &uri, "2", &json!({"dbt_cpu_millis": 975})).await?;
    assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(
        body(refused).await?["detail"]
            .as_str()
            .is_some_and(|v| v.contains("resources were not changed"))
    );
    let after = Entity::find_by_id((connector.clone(), "main".to_owned()))
        .one(&db)
        .await?;
    assert_eq!(after, before);
    assert_eq!(h.workflow.object().await, workflow);

    h.workflow.replace(workflow, Scenario::Accept).await;
    let partial = patch(&h, &history, &uri, "2", &json!({"dbt_cpu_millis": null})).await?;
    assert_eq!(partial.status(), StatusCode::OK);
    assert_eq!(partial.headers()["etag"], "\"3\"");
    let partial = body(partial).await?;
    assert_eq!(partial["resources"]["requested"], json!(case.requested));
    assert_eq!(partial["resources"]["live"]["dbt_cpu_millis"], 750);

    assert_repeat_save_fills_in_pod_patches(&h, &history, &uri, &fixture.parameters, case).await?;

    let reset = patch(
        &h,
        &history,
        &uri,
        "3",
        &json!({"dbt_query_memory_bytes": null}),
    )
    .await?;
    assert_eq!(reset.status(), StatusCode::OK);
    let reset = body(reset).await?;
    assert_eq!(reset["requested"], schedule["requested"]);
    assert_eq!(reset["resources"]["status"], "inherited");
    assert_eq!(reset["resources"]["live"], saved["resources"]["inherited"]);
    clear(&db, &connector).await
}

async fn assert_repeat_save_fills_in_pod_patches(
    h: &Harness,
    history: &Mock,
    uri: &str,
    names: &ResourceParameterNames,
    case: &ResourceParameterCase,
) -> R {
    let current = h.workflow.object().await;
    let expected = [
        (names.sync.as_str(), case.sync_resources.as_str()),
        (names.dbt.as_str(), case.dbt_pod_patch.as_str()),
        (names.identity.as_str(), case.identity_pod_patch.as_str()),
    ];
    for (name, replacement) in [
        (names.dbt.as_str(), None),
        (names.identity.as_str(), Some("{}")),
    ] {
        let mut stale = current.clone();
        let parameters = stale["spec"]["workflowSpec"]["arguments"]["parameters"]
            .as_array_mut()
            .ok_or("missing Workflow arguments")?;
        parameters.retain(|p| p["name"] != name);
        if let Some(value) = replacement {
            parameters.push(json!({"name": name, "value": value}));
        }
        h.workflow.replace(stale, Scenario::Accept).await;

        let (status, schedule) = send((h, history), "GET", uri, None, &[]).await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(schedule["resources"]["status"], "pending", "{name}");

        let noop = patch(h, history, uri, "3", &json!({})).await?;
        assert_eq!(noop.status(), StatusCode::OK);
        assert_eq!(noop.headers()["etag"], "\"3\"");
        let saved = body(noop).await?;
        assert_eq!(saved["resources"]["requested"], json!(case.requested));
        assert_eq!(saved["resources"]["status"], "applied");

        let workflow = h.workflow.object().await;
        let parameters = workflow["spec"]["workflowSpec"]["arguments"]["parameters"]
            .as_array()
            .ok_or("missing Workflow arguments")?;
        for (name, value) in expected {
            let actual = parameters.iter().find(|p| p["name"] == name);
            assert_eq!(
                actual.and_then(|p| p["value"].as_str()),
                Some(value),
                "{name}"
            );
        }
    }
    Ok(())
}
