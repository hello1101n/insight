use super::*;
use serde_json::{Value, json};

fn at(hours: i64) -> DateTime<Utc> {
    DateTime::UNIX_EPOCH + chrono::Duration::hours(hours)
}

fn workflow(status: &Value) -> serde_json::Result<DynamicObject> {
    serde_json::from_value(json!({
        "apiVersion":"argoproj.io/v1alpha1","kind":"Workflow",
        "metadata":{"name":"example-sync","uid":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "resourceVersion":"15","creationTimestamp":at(1)},
        "spec":{"workflowTemplateRef":{"name":"ingestion-pipeline"},"arguments":{"parameters":[
            {"name":"data_source","value":"jira"},{"name":"connection_name","value":"jira-example-tenant-conn"},
            {"name":"insight_source_id","value":"example"}
        ]}},
        "status":status,
    }))
}

#[test]
fn identity_query_attribution_survives_pod_deletion() {
    let pod = uuid::Uuid::new_v4();
    let status = json!({"nodes": {"identity": {
        "id": "identity", "displayName": "identity-seed", "type": "Pod", "phase": "Failed",
        "startedAt": at(1), "finishedAt": at(2),
        "outputs": {"parameters": [{"name": "query-pod-uid", "value": pod}]}
    }}});

    let stages = nodes::transforms(&status, &HashMap::new(), Some(at(2)));
    assert_eq!(stages.len(), 1);
    assert_eq!(stages[0].query_pod, Some(pod));
}

#[test]
fn argo_lock_holder_and_sync_slot_are_distinct_from_placement() -> Result<()> {
    let mut workflow = workflow(&json!({
        "phase":"Running",
        "synchronization":{"mutex":{"waiting":[{"mutex":"example/Mutex/ch-staging","holder":"example/holder/id"}]}},
        "nodes":{
            "pipeline":{"id":"pipeline","templateName":"pipeline","type":"DAG","phase":"Pending",
                "startedAt":at(1),"synchronizationStatus":{"waiting":"example/ConfigMap/insight-sync-limits/syncs"}},
            "staging":{"id":"staging","displayName":"transform-jira-staging","type":"Pod","phase":"Pending",
                "startedAt":at(1),"synchronizationStatus":{"waiting":"example/Mutex/ch-staging"}},
            "identity":{"id":"identity","displayName":"identity-seed","type":"Pod","phase":"Pending",
                "startedAt":at(1),"message":"Pod is forbidden: exceeded quota: fixture"}
        }
    }))?;
    let arguments = workflow.data["spec"]["arguments"].clone();
    workflow.data["spec"] = json!({
        "entrypoint":"run",
        "templates":[{"name":"run","steps":[[{"name":"pipeline",
            "templateRef":{"name":"ingestion-pipeline","template":"pipeline"},
            "arguments":arguments
        }]]}]
    });
    let status = &workflow.data["status"];
    let (mut run, has_bronze) =
        identity(&workflow, at(8), false).context("expected ingestion pipeline")?;
    assert!(has_bronze);
    let pods = HashMap::new();
    run.stages = nodes::transforms(status, &pods, None);
    run.stages
        .push(bronze::snapshot(&workflow, run.created_at, &pods, None));
    let wait = |stage| {
        run.stages
            .iter()
            .find(|s| s.stage == stage)
            .and_then(|s| s.wait.as_ref())
    };

    let lock = wait("transform-jira-staging").context("missing writer lock")?;
    assert_eq!(lock.kind, WaitKind::Lock);
    assert_eq!(lock.holder.as_deref(), Some("holder"));
    assert_eq!(
        wait("identity-seed").map(|wait| wait.kind),
        Some(WaitKind::Placement)
    );
    assert_eq!(
        wait("bronze").map(|wait| wait.kind),
        Some(WaitKind::SyncSlot)
    );
    Ok(())
}

#[test]
fn stops_strictly_after_six_hours_and_only_for_argo_synchronization() -> Result<()> {
    let workflow = workflow(&json!({"phase":"Running"}))?;
    let (mut run, _) = identity(&workflow, at(8), false).context("expected ingestion pipeline")?;
    for (kind, stop) in [
        (WaitKind::Placement, false),
        (WaitKind::Lock, true),
        (WaitKind::SyncSlot, true),
    ] {
        let mut attempt = StageSnapshot::new("bronze", 1, at(1));
        attempt.status = "queued";
        attempt.wait = Some(nodes::wait(kind, at(1), None));
        run.stages = vec![attempt];
        assert!(
            timeout::expired(&run, at(7)).is_none(),
            "{kind:?} at exactly six hours"
        );
        assert_eq!(
            timeout::expired(&run, at(8)).is_some(),
            stop,
            "{kind:?} after six hours"
        );
    }
    Ok(())
}

#[test]
fn bronze_launch_receipts_set_the_two_not_started_reasons() -> Result<()> {
    let mut workflow = workflow(&json!({"phase":"Failed","startedAt":at(1),"finishedAt":at(2)}))?;
    for (outcome, reason) in [
        ("rejected", "airbyte_launch_rejected"),
        ("unconfirmed", "airbyte_launch_unconfirmed"),
        ("unreadable", "airbyte_launch_unreadable"),
    ] {
        workflow
            .metadata
            .annotations
            .get_or_insert_default()
            .insert(
                "insight.cyberfabric.com/airbyte-launch".into(),
                json!({
                    "workflow_uid":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                "workflow_started_at":at(1),"attempt":1,
                "connection":"11111111-1111-1111-1111-111111111111","outcome":outcome
                })
                .to_string(),
            );
        let attempt = bronze::snapshot(&workflow, at(1), &HashMap::new(), Some(at(2)));
        assert_eq!(attempt.status, "not_started", "{outcome}");
        assert_eq!(attempt.reason.as_deref(), Some(reason), "{outcome}");
        assert!(attempt.started_at.is_none(), "{outcome}");
        assert_eq!(attempt.finished_at, Some(at(2)), "{outcome}");
    }
    Ok(())
}

#[tokio::test]
async fn stop_patches_uid_and_version_and_ignores_placement_or_running_stages() -> Result<()> {
    use axum::{Json, Router, extract::State, routing::patch};
    use tokio::{net::TcpListener, sync::Mutex};

    async fn capture(
        State(patches): State<Arc<Mutex<Vec<Value>>>>,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        patches.lock().await.push(body);
        Json(
            json!({"apiVersion":"argoproj.io/v1alpha1","kind":"Workflow","metadata":{"name":"example-sync"}}),
        )
    }

    let patches = Arc::new(Mutex::new(Vec::new()));
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let config = kube::Config::new(format!("http://{}", listener.local_addr()?).parse()?);
    let server = Router::new()
        .route(
            "/apis/argoproj.io/v1alpha1/namespaces/example/workflows/example-sync",
            patch(capture),
        )
        .with_state(Arc::clone(&patches));
    let task = tokio::spawn(async move { axum::serve(listener, server).await });
    let resource = ApiResource::from_gvk(&GroupVersionKind::gvk(
        "argoproj.io",
        "v1alpha1",
        "Workflow",
    ));
    let api = Api::namespaced_with(kube::Client::try_from(config)?, "example", &resource);
    let mut object = workflow(&json!({"startedAt":at(1),"phase":"Running"}))?;
    let (mut run, _) = identity(&object, at(8), false).context("workflow fixture")?;

    let mut stage = StageSnapshot::new("bronze", 1, at(1));
    stage.wait = Some(nodes::wait(WaitKind::Placement, at(1), None));
    stage.status = "queued";
    run.stages.push(stage);
    timeout::stop(&api, &object, &run, at(8)).await?;
    run.stages[0].wait = Some(nodes::wait(WaitKind::SyncSlot, at(1), None));
    run.stages[0].started_at = Some(at(2));
    timeout::stop(&api, &object, &run, at(8)).await?;
    assert!(
        patches.lock().await.is_empty(),
        "a placement or running stage was stopped"
    );

    run.stages[0].started_at = None;
    timeout::stop(&api, &object, &run, at(8)).await?;
    let sent = patches.lock().await;
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0]["metadata"]["uid"],
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    );
    assert_eq!(sent[0]["metadata"]["resourceVersion"], "15");
    assert_eq!(sent[0]["spec"]["shutdown"], "Terminate");
    let marker = sent[0]["metadata"]["annotations"][timeout::ANNOTATION]
        .as_str()
        .context("timeout marker")?;
    object
        .metadata
        .annotations
        .get_or_insert_default()
        .insert(timeout::ANNOTATION.into(), marker.into());
    drop(sent);
    task.abort();

    run.finished_at = Some(at(8));
    timeout::apply(&object, &mut run);
    assert_eq!(run.status, Some("wait_timeout"));
    Ok(())
}

#[test]
fn only_the_stopped_workflow_execution_uses_the_timeout_marker() -> Result<()> {
    let mut wf = workflow(&json!({"phase":"Succeeded","startedAt":at(2),"finishedAt":at(3)}))?;
    for (uid, execution) in [
        ("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", at(2)),
        ("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", at(1)),
    ] {
        wf.metadata.annotations.get_or_insert_default().insert(
            timeout::ANNOTATION.into(),
            json!({
                "uid":uid,"execution":execution,"stage":"bronze","attempt":1,
            })
            .to_string(),
        );
        let (mut run, _) = identity(&wf, at(3), false).context("workflow fixture")?;
        run.stages.push(StageSnapshot::new("bronze", 1, at(2)));
        timeout::apply(&wf, &mut run);
        assert_eq!(run.status, Some("succeeded"), "{uid} at {execution}");
    }
    Ok(())
}

#[test]
fn bronze_uses_argo_receipt_when_the_annotation_write_fails() -> Result<()> {
    let pending = json!({
        "workflow_uid":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "workflow_started_at":at(1),"attempt":1,
        "connection":"11111111-1111-1111-1111-111111111111","outcome":"pending"
    });
    let mut rejected = pending.clone();
    rejected["outcome"] = json!("rejected");
    let mut wf = workflow(
        &json!({"phase":"Failed","startedAt":at(1),"finishedAt":at(2),"nodes":{
            "trigger":{"id":"trigger","type":"Pod","templateName":"trigger-sync","phase":"Failed","startedAt":at(1),"finishedAt":at(2),
                "outputs":{"parameters":[{"name":"airbyte-launch-evidence","value":rejected.to_string()}]}}
        }}),
    )?;
    wf.metadata.annotations.get_or_insert_default().insert(
        "insight.cyberfabric.com/airbyte-launch".into(),
        pending.to_string(),
    );
    let load = bronze::snapshot(&wf, at(1), &HashMap::new(), Some(at(2)));
    assert_eq!(load.reason.as_deref(), Some("airbyte_launch_rejected"));
    wf.data["status"]["nodes"]["trigger"]["outputs"] = json!({"exitCode":"42"});
    let load = bronze::snapshot(&wf, at(1), &HashMap::new(), Some(at(2)));
    assert_eq!(load.reason.as_deref(), Some("airbyte_launch_rejected"));
    Ok(())
}

#[test]
fn bronze_ignores_foreign_receipts() -> Result<()> {
    let mut wf = workflow(&json!({"phase":"Running","startedAt":at(1)}))?;
    wf.metadata.annotations.get_or_insert_default().insert(
        "insight.cyberfabric.com/airbyte-launch".into(),
        json!({
            "workflow_uid":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            "workflow_started_at":at(1),"attempt":1,
            "connection":"11111111-1111-1111-1111-111111111111","outcome":"accepted","job_id":19
        })
        .to_string(),
    );
    let load = bronze::snapshot(&wf, at(1), &HashMap::new(), None);
    assert_eq!(load.job, None);
    assert_eq!(load.status, "starting");
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn record_missing_closes_absent_workflows_and_leaves_present_ones_open() -> Result<()> {
    use sea_orm::Database;
    use sea_orm_migration::MigratorTrait;

    let db = Database::connect(std::env::var("INTEGRATION_TESTS_MARIADB_URL")?).await?;
    crate::migration::Migrator::up(&db, None).await?;
    let mut cluster = crate::infra::cluster::Cluster::disabled();
    cluster.namespace = uuid::Uuid::new_v4().to_string();
    let state = AppState {
        cluster,
        db,
        ch: insight_clickhouse::Client::new(insight_clickhouse::Config::new(
            "http://127.0.0.1:1",
            "default",
        )),
        identity: crate::infra::identity::IdentityClient::new("http://127.0.0.1:1")?,
        schedule_slots: tokio::sync::Semaphore::new(4),
    };
    let http = insight_http_client::client_builder()?.build()?;
    let stand = &state.cluster.namespace;
    let wf = workflow(&json!({"phase":"Running","startedAt":at(1)}))?;
    let (mut current, _) = identity(&wf, at(2), false).context("workflow fixture")?;
    current.uid = uuid::Uuid::new_v4().to_string();
    current.stages.push(StageSnapshot::new("bronze", 1, at(1)));
    current.stages[0].status = "checking_start";
    store::save(&state.db, stand, &current, at(2)).await?;

    let present = current.uid.clone();
    current.uid = uuid::Uuid::new_v4().to_string();
    store::save(&state.db, stand, &current, at(2)).await?;
    let missing = current.uid;

    record_missing(&state, &http, &HashSet::from([present.clone()])).await?;
    let runs = crate::domain::run_history::history::runs(
        &state.db,
        stand,
        "jira",
        Some("tenant"),
        Some("example"),
    )
    .await?;
    let active = runs
        .iter()
        .find(|run| run.sync_id == present)
        .context("present run")?;
    let closed = runs
        .iter()
        .find(|run| run.sync_id == missing)
        .context("missing run")?;
    assert_eq!(active.status, "checking_start");
    assert_eq!(closed.status, "cancelled");
    assert_eq!(closed.stages[0].status, "unknown");
    assert_eq!(
        closed.stages[0].reason.as_deref(),
        Some("workflow_not_found")
    );
    Ok(())
}
