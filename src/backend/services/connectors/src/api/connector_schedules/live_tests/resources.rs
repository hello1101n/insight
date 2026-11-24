use super::*;
use crate::infra::cluster_stub::Scenario;

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
        json!(r#"{"dbt_cpu_millis":750,"airbyte_memory_bytes":2147483648}"#);
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
    assert_eq!(
        saved["resources"]["live"],
        json!({
            "dbt_cpu_millis": 1200,"dbt_query_memory_bytes": 5_368_709_120_u64,"airbyte_memory_bytes":2_147_483_648_u64
        })
    );
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
    assert_eq!(
        partial["resources"]["requested"],
        json!({"dbt_query_memory_bytes": 5_368_709_120_u64})
    );
    assert_eq!(partial["resources"]["live"]["dbt_cpu_millis"], 750);

    assert_repeat_save_fills_in_pod_patches(&h, &history, &uri, &partial["resources"]["requested"])
        .await?;

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
    requested: &Value,
) -> R {
    let mut legacy_workflow = h.workflow.object().await;
    let parameters = &mut legacy_workflow["spec"]["workflowSpec"]["arguments"]["parameters"];
    parameters
        .as_array_mut()
        .ok_or("missing Workflow arguments")?
        .retain(|p| p["name"] != "dbt_pod_patch" && p["name"] != "identity_pod_patch");
    h.workflow.replace(legacy_workflow, Scenario::Accept).await;

    let noop = patch(h, history, uri, "3", &json!({})).await?;
    assert_eq!(noop.status(), StatusCode::OK);
    assert_eq!(noop.headers()["etag"], "\"3\"");
    assert_eq!(&body(noop).await?["resources"]["requested"], requested);

    let workflow = h.workflow.object().await;
    let parameters = workflow["spec"]["workflowSpec"]["arguments"]["parameters"]
        .as_array()
        .ok_or("missing Workflow arguments")?;
    assert!(parameters.iter().any(|p| p["name"] == "dbt_pod_patch"));
    assert!(parameters.iter().any(|p| p["name"] == "identity_pod_patch"));
    Ok(())
}
