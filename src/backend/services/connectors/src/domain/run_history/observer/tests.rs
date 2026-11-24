use super::*;
use serde_json::{Value, json};

use crate::domain::connector_schedules::resources::PARAMETER;

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
fn history_records_stage_overrides_from_the_workflow_patches() -> Result<()> {
    let fixture = crate::test_support::ResourceParameterFixture::load()?;
    let case = fixture
        .cases
        .iter()
        .find(|case| case.name == "everything set")
        .context("missing resource case")?;
    let names = fixture.parameters;
    let mut workflow = workflow(&json!({}))?;
    let sync = json!({"name": names.sync, "value": case.sync_resources});
    let dbt = json!({"name": names.dbt, "value": case.dbt_pod_patch});
    let identity = json!({"name": names.identity, "value": case.identity_pod_patch});
    let empty_dbt = json!({"name": names.dbt, "value": "{}"});
    let empty_identity = json!({"name": names.identity, "value": "{}"});
    let dbt_settings = json!({
        "dbt_cpu_millis":2000, "dbt_memory_bytes":2_147_483_648_u64,
        "dbt_query_memory_bytes":5_368_709_120_u64
    });
    let identity_settings = json!({"identity_cpu_millis":250, "identity_memory_bytes":536_870_912});
    let default = Value::Null;

    for (label, parameters, expected_dbt, expected_identity, expected_bronze) in [
        (
            "legacy",
            vec![&sync],
            &default,
            &default,
            json!({"airbyte_cpu_millis":1000, "airbyte_memory_bytes":1_073_741_824_u64}),
        ),
        (
            "empty patches",
            vec![&sync, &empty_dbt, &empty_identity],
            &default,
            &default,
            json!({"airbyte_cpu_millis":1000, "airbyte_memory_bytes":1_073_741_824_u64}),
        ),
        (
            "patches only",
            vec![&dbt, &identity],
            &dbt_settings,
            &identity_settings,
            Value::Null,
        ),
    ] {
        workflow.data["spec"]["arguments"]["parameters"] = json!(parameters);
        let mut stages = [
            "bronze",
            "transform-staging",
            "connector-checks",
            "identity-seed",
        ]
        .map(|stage| StageSnapshot::new(stage, 1, at(1)));
        observe_resources(&workflow, &mut stages);
        assert_eq!(
            json!(stages[1].resources),
            *expected_dbt,
            "{label}: dbt transform"
        );
        assert_eq!(
            json!(stages[2].resources),
            *expected_dbt,
            "{label}: connector checks"
        );
        assert_eq!(
            json!(stages[3].resources),
            *expected_identity,
            "{label}: identity"
        );
        assert_eq!(
            json!(stages[0].resources),
            expected_bronze,
            "{label}: bronze"
        );
    }
    Ok(())
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
fn bronze_and_checks_report_their_own_slot_waits() -> Result<()> {
    let mut workflow = workflow(&json!({
        "phase":"Running",
        "nodes":{
            "load":{"id":"load","templateRef":{"name":"airbyte-sync","template":"main"},
                "type":"Steps","phase":"Pending","startedAt":at(2),
                "synchronizationStatus":{"waiting":"example/ConfigMap/insight-sync-limits/bronze"}},
            "checks":{"id":"checks","displayName":"connector-checks","type":"Pod","phase":"Pending",
                "startedAt":at(3),"synchronizationStatus":{"waiting":"example/ConfigMap/insight-sync-limits/checks"}}
        }
    }))?;
    let pods = HashMap::new();
    let load = bronze::snapshot(&workflow, at(1), &pods, None);
    let checks = &nodes::transforms(&workflow.data["status"], &pods, None)[0];
    assert_eq!(
        load.wait.as_ref().map(|wait| wait.kind),
        Some(WaitKind::SyncSlot)
    );
    assert_eq!(load.wait.as_ref().map(|wait| wait.started_at), Some(at(2)));
    assert_eq!(
        serde_json::to_value(checks.wait.as_ref().map(|wait| wait.kind))?,
        "check_slot"
    );

    let (mut run, _) = identity(&workflow, at(9), false).context("expected ingestion pipeline")?;
    run.stages = vec![nodes::transforms(&workflow.data["status"], &pods, None).remove(0)];
    assert!(timeout::expired(&run, at(9)).is_none());
    assert!(timeout::expired(&run, at(10)).is_none());

    workflow.data["status"]["nodes"]["load"]["phase"] = json!("Error");
    let ended = bronze::snapshot(&workflow, at(1), &pods, Some(at(8)));
    assert!(ended.wait.is_none());
    Ok(())
}

#[test]
fn stops_no_workflow_after_gold_is_ready() -> Result<()> {
    let workflow = workflow(&json!({"phase":"Running"}))?;
    let (mut run, _) = identity(&workflow, at(9), false).context("expected ingestion pipeline")?;
    let mut gold = StageSnapshot::new("transform-jira-silver", 1, at(1));
    gold.status = "succeeded";
    gold.finished_at = Some(at(2));
    let mut waiting = StageSnapshot::new("connector-checks", 1, at(2));
    waiting.status = "queued";
    waiting.wait = Some(nodes::wait(WaitKind::CheckSlot, at(2), None));
    run.stages = vec![gold, waiting];
    assert!(timeout::expired(&run, at(9)).is_none());
    run.stages[0].finished_at = None;
    run.stages[1].stage = "transform-jira-staging";
    run.stages[1].wait = Some(nodes::wait(WaitKind::Lock, at(2), None));
    assert!(timeout::expired(&run, at(9)).is_none());
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
    object.data["spec"]["shutdown"] = json!("Terminate");
    timeout::stop(&api, &object, &run, at(8)).await?;
    assert_eq!(
        patches.lock().await.len(),
        1,
        "a stopped Workflow was patched again"
    );
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
    assert_eq!(load.reason, None);
    assert_eq!(load.status, "unknown");
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

#[test]
fn airbyte_lookup_recovers_the_destination_memory_reason_without_poll_evidence() -> Result<()> {
    let connection = uuid::Uuid::new_v4();
    let response = json!({
        "job": {"id": 21, "configId": connection, "configType": "sync", "status": "failed"},
        "attempts": [
            {"attempt": {"id": 2, "failureSummary": {"failures": [
                {"failureOrigin": "source", "internalMessage": "Code: 241. Query memory limit exceeded"},
                {"failureOrigin": "destination", "internalMessage": "Code: 241. User memory limit exceeded. Total memory limit exceeded"}
            ]}}},
            {"attempt": {"id": 1, "failureSummary": {"failures": [
                {"failureOrigin": "destination", "internalMessage": "Code: 241. Query memory limit exceeded"}
            ]}}}
        ]
    });
    let mut load = StageSnapshot::new("bronze", 1, at(1));
    airbyte::parse_job(&response, 21, connection)?.apply(&mut load, Some(at(2)));
    assert_eq!(load.reason.as_deref(), Some("clickhouse_user_memory_limit"));
    Ok(())
}

#[test]
fn checks_report_dbt_errors_without_failing_the_workflow() -> Result<()> {
    for (code, expected) in [("0", "succeeded"), ("1", "failed")] {
        let workflow = workflow(&json!({
            "phase": "Succeeded",
            "startedAt": at(1),
            "finishedAt": at(3),
            "nodes": {"checks": {
                "id": "checks", "displayName": "connector-checks", "type": "Pod",
                "phase": "Succeeded", "startedAt": at(2), "finishedAt": at(3),
                "outputs": {"parameters": [{"name": "dbt-exit-code", "value": code}]}
            }}
        }))?;
        let (run, _) = identity(&workflow, at(3), false).context("expected ingestion pipeline")?;
        let attempts =
            nodes::transforms(&workflow.data["status"], &HashMap::new(), run.finished_at);
        assert_eq!(run.status, Some("succeeded"));
        assert_eq!(attempts[0].status, expected, "dbt exit {code}");
    }
    Ok(())
}

#[test]
fn the_argo_termination_reason_records_an_oom_after_pod_deletion() {
    let status = json!({"nodes":{"stage":{
        "id":"stage",
        "displayName":"identity-seed",
        "type":"Pod",
        "phase":"Failed",
        "startedAt":at(1),
        "finishedAt":at(2),
        "message":"main: OOMKilled (exit code 137)"
    }}});
    let attempts = nodes::transforms(&status, &HashMap::new(), Some(at(2)));
    assert_eq!(attempts[0].reason.as_deref(), Some("pod_oom"));
}

#[test]
fn legacy_bronze_uses_argo_phases_and_the_job_id_passed_to_poll() -> Result<()> {
    for (trigger, poll, expected, reason) in [
        ("Succeeded", Some("Succeeded"), "succeeded", None),
        (
            "Succeeded",
            Some("Failed"),
            "failed",
            Some("airbyte_job_failed"),
        ),
        ("Failed", None, "failed", Some("stage_failed")),
    ] {
        let mut status = json!({"startedAt":at(1),"finishedAt":at(3),"nodes":{
            "trigger":{"id":"trigger","type":"Pod","templateName":"trigger-sync",
                "phase":trigger,"startedAt":at(1),"finishedAt":at(2),
                "inputs":{"parameters":[{"name":"connection_id","value":"11111111-1111-1111-1111-111111111111"}]},
                "outputs": if trigger == "Succeeded" {json!({"result":"19"})} else {json!({"exitCode":"42"})}
            }
        }});
        if let Some(poll) = poll {
            status["nodes"]["poll"] = json!({"id":"poll","type":"Pod","templateName":"poll-job",
                "phase":poll,"startedAt":at(2),"finishedAt":at(3),
                "inputs":{"parameters":[{"name":"job_id","value":"19"}]}});
        }
        let wf = workflow(&status)?;
        let (load, lookup) = bronze::observation(&wf, at(1), &HashMap::new(), Some(at(3)));
        assert_eq!(load.status, expected, "trigger {trigger}, poll {poll:?}");
        assert_eq!(load.reason.as_deref(), reason);
        assert_eq!(load.job, poll.map(|_| 19));
        assert_eq!(lookup, poll.is_some());
        assert_eq!(
            load.finished_at,
            Some(if poll.is_some() { at(3) } else { at(2) })
        );
    }
    Ok(())
}

fn bronze_capacity_marker(
    execution: i64,
    attempt: u32,
    started: i64,
    ended: Option<i64>,
) -> String {
    json!({
        "workflow_uid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "workflow_started_at": at(execution),
        "attempt": attempt,
        "started_at": at(started),
        "ended_at": ended.map(at),
    })
    .to_string()
}

fn bronze_launch_mark(execution: i64, attempt: u32, job_id: u64) -> Value {
    json!({
        "workflow_uid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "workflow_started_at": at(execution),
        "attempt": attempt,
        "connection": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        "outcome": "accepted",
        "job_id": job_id,
    })
}

#[test]
fn bronze_capacity_wait_is_a_placement_wait_for_the_current_execution_and_survives_six_hours()
-> Result<()> {
    let mut workflow = workflow(&json!({"phase":"Running", "startedAt":at(2)}))?;
    workflow.metadata.annotations = Some(
        [
            (
                "insight.cyberfabric.com/airbyte-capacity-wait".into(),
                bronze_capacity_marker(2, 2, 3, None),
            ),
            (
                "insight.cyberfabric.com/airbyte-launch".into(),
                bronze_launch_mark(1, 1, 19).to_string(),
            ),
        ]
        .into(),
    );

    let (mut run, _) = identity(&workflow, at(10), false).context("missing run")?;
    let stage = bronze::snapshot(&workflow, run.created_at, &HashMap::new(), None);
    assert_eq!(stage.attempt, 2);
    assert_eq!(stage.job, None);
    assert_eq!(stage.status, "queued");
    assert_eq!(stage.started_at, None);
    let wait = stage.wait.as_ref().context("missing placement wait")?;
    assert_eq!(wait.kind, WaitKind::Placement);
    assert_eq!(wait.started_at, at(3));
    run.stages.push(stage);
    assert!(timeout::expired(&run, at(10)).is_none());

    workflow.data["status"]["startedAt"] = json!(at(4));
    let next_execution = bronze::snapshot(&workflow, run.created_at, &HashMap::new(), None);
    assert!(next_execution.wait.is_none());
    assert_eq!(next_execution.job, None);
    Ok(())
}

#[test]
fn failed_workflow_closes_the_capacity_wait_and_keeps_its_failure() -> Result<()> {
    for (template, expected_reason) in [
        ("trigger-sync", "stage_failed"),
        ("poll-job", "stage_failed"),
        ("", "stage_failed"),
    ] {
        let mut status = json!({"phase":"Failed", "startedAt":at(1), "finishedAt":at(4)});
        if !template.is_empty() {
            status["nodes"] = json!({"load": {
                "type":"Pod", "templateName":template, "phase":"Failed",
                "startedAt":at(2), "finishedAt":at(3),
            }});
        }
        let mut workflow = workflow(&status)?;
        workflow
            .metadata
            .annotations
            .get_or_insert_default()
            .insert(
                "insight.cyberfabric.com/airbyte-capacity-wait".into(),
                bronze_capacity_marker(1, 1, 2, None),
            );
        let stage = bronze::snapshot(&workflow, at(1), &HashMap::new(), Some(at(4)));

        assert_eq!(
            (stage.status, stage.reason.as_deref()),
            ("failed", Some(expected_reason)),
            "{template}"
        );
        assert_eq!(
            stage.finished_at,
            Some(if template.is_empty() { at(4) } else { at(3) })
        );
        assert!(stage.wait.is_none());
        let wait = stage.capacity_wait.context("missing capacity wait")?;
        assert_eq!(
            (wait.kind, wait.started_at, wait.ended_at),
            (WaitKind::Placement, at(2), Some(at(4)))
        );
    }
    Ok(())
}

#[test]
fn poll_launch_receipt_recovers_a_relaunch_when_the_annotation_stays_pending() -> Result<()> {
    let old = bronze_launch_mark(1, 1, 19);
    let mut relaunch = bronze_launch_mark(2, 2, 20);
    relaunch["pod_request"] = json!({"cpu_millis":2500, "memory_bytes":5_368_709_120_u64});
    let mut pending = relaunch.clone();
    pending["outcome"] = json!("pending");
    pending["job_id"] = Value::Null;
    pending["pod_request"] = Value::Null;
    let mut wf = workflow(&json!({"phase":"Running", "startedAt":at(2), "nodes":{
        "trigger":{"type":"Pod", "templateName":"trigger-sync",
            "outputs":{"parameters":[{"name":"airbyte-launch-evidence","value":old.to_string()}]}},
        "poll":{"type":"Pod", "templateName":"poll-job",
            "outputs":{"parameters":[{"name":"airbyte-launch-evidence","value":relaunch.to_string()}]}}
    }}))?;
    wf.metadata.annotations.get_or_insert_default().insert(
        "insight.cyberfabric.com/airbyte-launch".into(),
        pending.to_string(),
    );
    let stage = bronze::snapshot(&wf, at(1), &HashMap::new(), None);

    assert_eq!((stage.attempt, stage.job), (2, Some(20)));
    assert_eq!(
        stage
            .actual_resources
            .and_then(|resources| resources.airbyte_cpu_millis),
        Some(2500)
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn history_records_the_next_execution_after_bronze_stops_without_a_launch_claim() -> Result<()>
{
    use sea_orm::Database;
    use sea_orm_migration::MigratorTrait;

    use crate::domain::run_history::history;
    use crate::migration::Migrator;

    let db = Database::connect(std::env::var("INTEGRATION_TESTS_MARIADB_URL")?).await?;
    Migrator::up(&db, None).await?;
    let stand = uuid::Uuid::new_v4().to_string();
    let mut workflow = workflow(&json!({"phase":"Failed", "startedAt":at(1), "finishedAt":at(3)}))?;
    workflow.metadata.uid = Some(uuid::Uuid::new_v4().to_string());
    let uid = workflow
        .metadata
        .uid
        .clone()
        .context("missing Workflow UID")?;
    let key = "insight.cyberfabric.com/airbyte-capacity-wait";

    for (execution, attempt, started, now) in [(1, 1, 2, 3), (4, 2, 5, 6)] {
        if execution > 1 {
            workflow.data["status"] = json!({"phase":"Running", "startedAt":at(execution)});
        }
        let mut wait: Value =
            serde_json::from_str(&bronze_capacity_marker(execution, attempt, started, None))?;
        wait["workflow_uid"] = json!(uid);
        workflow
            .metadata
            .annotations
            .get_or_insert_default()
            .insert(key.into(), wait.to_string());
        let (mut run, _) = identity(&workflow, at(now), false).context("missing run")?;
        run.stages = vec![bronze::snapshot(
            &workflow,
            run.created_at,
            &HashMap::new(),
            run.finished_at,
        )];
        store::save(&db, &stand, &run, at(now)).await?;
        store::save(&db, &stand, &run, at(now)).await?;
    }

    let result = history::runs(&db, &stand, "jira", Some("tenant"), Some("example")).await?;
    assert_eq!(result[0].execution_started_at, at(4));
    assert_eq!(result[0].stages.len(), 2);
    let first = &result[0].stages[0];
    let retry = &result[0].stages[1];
    assert_eq!(
        (
            first.attempt,
            first.status.as_str(),
            first.reason.as_deref()
        ),
        (1, "failed", Some("stage_failed"))
    );
    assert_eq!(first.waits.len(), 1);
    assert_eq!(first.waits[0].ended_at, Some(at(3)));
    assert_eq!(
        (
            retry.attempt,
            retry.status.as_str(),
            retry.airbyte_job_id.as_deref()
        ),
        (2, "wait_warning", None)
    );
    assert_eq!(retry.waits.len(), 1);
    assert_eq!(
        (
            retry.waits[0].kind,
            retry.waits[0].started_at,
            retry.waits[0].ended_at
        ),
        (WaitKind::Placement, at(5), None)
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn history_records_bronze_capacity_time_and_the_actual_pod_request_after_replay() -> Result<()>
{
    use sea_orm::Database;
    use sea_orm_migration::MigratorTrait;

    use crate::domain::run_history::history;
    use crate::migration::Migrator;

    let db = Database::connect(std::env::var("INTEGRATION_TESTS_MARIADB_URL")?).await?;
    Migrator::up(&db, None).await?;
    let stand = uuid::Uuid::new_v4().to_string();
    let mut workflow = workflow(&json!({"phase":"Running", "startedAt":at(1)}))?;
    workflow.data["spec"]["arguments"]["parameters"]
        .as_array_mut()
        .context("missing Workflow parameters")?
        .push(json!({"name":PARAMETER, "value":"{\"airbyte_cpu_millis\":1750}"}));
    let annotations = workflow.metadata.annotations.get_or_insert_default();
    let key = "insight.cyberfabric.com/airbyte-capacity-wait";
    annotations.insert(key.into(), bronze_capacity_marker(1, 1, 2, None));
    let (mut run, _) = identity(&workflow, at(7), false).context("missing run")?;
    run.stages = vec![bronze::snapshot(
        &workflow,
        run.created_at,
        &HashMap::new(),
        None,
    )];
    observe_resources(&workflow, &mut run.stages);
    store::save(&db, &stand, &run, at(7)).await?;
    let result = history::runs(&db, &stand, "jira", Some("tenant"), Some("example")).await?;
    assert_eq!(result[0].stages[0].status, "wait_warning");

    let annotations = workflow.metadata.annotations.get_or_insert_default();
    annotations.insert(key.into(), bronze_capacity_marker(1, 1, 2, Some(8)));
    let mut mark = bronze_launch_mark(1, 1, 20);
    mark["pod_request"] = json!({"cpu_millis":3575, "memory_bytes":5_368_709_120_u64});
    annotations.insert(
        "insight.cyberfabric.com/airbyte-launch".into(),
        mark.to_string(),
    );
    let evidence = json!({
        "job_id":20, "status":"succeeded", "started_at":at(9).timestamp(), "ended_at":at(10).timestamp(),
    });
    workflow.data["status"]["nodes"] = json!({"poll": {
        "templateName":"poll-job", "type":"Pod", "phase":"Succeeded", "finishedAt":at(10),
        "outputs":{"parameters":[{"name":"airbyte-evidence","value":evidence.to_string()}]},
    }});
    run.stages = vec![bronze::snapshot(
        &workflow,
        run.created_at,
        &HashMap::new(),
        None,
    )];
    observe_resources(&workflow, &mut run.stages);
    store::save(&db, &stand, &run, at(11)).await?;
    store::save(&db, &stand, &run, at(12)).await?;
    let result = history::runs(&db, &stand, "jira", Some("tenant"), Some("example")).await?;
    let stage = &result[0].stages[0];
    assert_eq!(stage.waits.len(), 1);
    assert_eq!(stage.waits[0].ended_at, Some(at(8)));
    assert_eq!(result[0].wait_ms, Some(6 * 60 * 60 * 1000));
    assert_eq!(result[0].load_ms, Some(60 * 60 * 1000));
    let recorded = stage.resources.as_ref().context("missing resources")?;
    assert_eq!(recorded.airbyte_cpu_millis, Some(3575));
    assert_eq!(recorded.airbyte_memory_bytes, Some(5 * 1024_u64.pow(3)));
    Ok(())
}

#[test]
fn bronze_attempt_one_is_scoped_to_each_workflow_execution() -> Result<()> {
    let mut wf = workflow(
        &json!({"phase":"Failed", "startedAt":at(1), "finishedAt":at(3), "nodes":{
            "resolve":{"type":"Pod", "templateName":"resolve-connection-by-name", "phase":"Failed",
                       "startedAt":at(1), "finishedAt":at(3)}
        }}),
    )?;
    let failed = bronze::snapshot(&wf, at(0), &HashMap::new(), Some(at(3)));
    assert_eq!(failed.attempt, 1);
    assert!(failed.capacity_wait.is_none() && failed.job.is_none());

    wf.data["status"] = json!({"phase":"Running", "startedAt":at(4)});
    let retry = bronze::snapshot(&wf, at(0), &HashMap::new(), None);
    assert_eq!(retry.attempt, 1);
    assert_ne!(retry.key(), failed.key());

    wf.metadata.annotations.get_or_insert_default().insert(
        "insight.cyberfabric.com/airbyte-capacity-wait".into(),
        bronze_capacity_marker(4, 1, 5, None),
    );
    let waiting = bronze::snapshot(&wf, at(0), &HashMap::new(), None);
    assert_eq!(waiting.key(), retry.key());
    assert_eq!(waiting.status, "queued");
    assert_eq!(
        waiting.wait.context("missing retry wait")?.started_at,
        at(5)
    );
    Ok(())
}

fn transform_retry_workflow() -> Result<DynamicObject> {
    let mut receipt = bronze_launch_mark(1, 1, 19);
    let uid = uuid::Uuid::new_v4();
    receipt["workflow_uid"] = json!(uid);
    let evidence = json!({
        "job_id":19, "status":"succeeded", "started_at":at(2).timestamp(),
        "ended_at":at(3).timestamp(), "records_reported":42,
    });
    let mut wf = workflow(&json!({
        "phase":"Failed", "startedAt":at(1), "finishedAt":at(5), "nodes":{
            "sync":{"id":"sync", "type":"Steps", "phase":"Succeeded", "startedAt":at(1), "finishedAt":at(3)},
            "trigger":{"id":"trigger", "type":"Pod", "templateName":"trigger-sync", "phase":"Succeeded",
                "startedAt":at(1), "finishedAt":at(2),
                "outputs":{"result":"19","parameters":[{"name":"airbyte-launch-evidence","value":receipt.to_string()}]}},
            "poll":{"id":"poll", "type":"Pod", "templateName":"poll-job", "phase":"Succeeded",
                "startedAt":at(2), "finishedAt":at(3),
                "inputs":{"parameters":[{"name":"job_id","value":"19"}]},
                "outputs":{"parameters":[{"name":"airbyte-evidence","value":evidence.to_string()}]}},
            "transform":{"id":"transform", "type":"Pod", "displayName":"transform-jira-staging",
                "phase":"Failed", "startedAt":at(4), "finishedAt":at(5)}
        }
    }))?;
    wf.metadata.uid = Some(uid.to_string());
    wf.metadata.annotations = Some(
        [(
            "insight.cyberfabric.com/airbyte-launch".into(),
            receipt.to_string(),
        )]
        .into(),
    );
    Ok(wf)
}

fn retry_transform(wf: &mut DynamicObject, finished_at: Option<DateTime<Utc>>) {
    let status = &mut wf.data["status"];
    let phase = if finished_at.is_some() {
        "Succeeded"
    } else {
        "Running"
    };
    status["phase"] = json!(phase);
    status["startedAt"] = json!(at(6));
    status["finishedAt"] = json!(finished_at);
    status["nodes"]["transform"]["phase"] = json!(phase);
    status["nodes"]["transform"]["startedAt"] = json!(at(6));
    status["nodes"]["transform"]["finishedAt"] = json!(finished_at);
}

#[test]
fn bronze_observation_ignores_the_retained_sync_on_a_transform_retry() -> Result<()> {
    let mut wf = transform_retry_workflow()?;
    let pods = HashMap::new();
    let (first, lookup) = bronze::current_observation(&wf, at(1), &pods, Some(at(5)))
        .context("missing the first Bronze execution")?;
    assert_eq!(
        (first.status, first.job, lookup),
        ("succeeded", Some(19), false)
    );

    for end in [None, Some(at(7))] {
        retry_transform(&mut wf, end);
        assert!(
            bronze::current_observation(&wf, at(1), &pods, end).is_none(),
            "transform retry ending at {end:?}"
        );
    }

    retry_transform(&mut wf, None);
    for template in ["trigger-sync", "poll-job"] {
        wf.data["status"]["nodes"]["new-bronze-step"] = json!({
            "type":"Pod", "templateName":template, "phase":"Running", "startedAt":at(6)
        });
        let (retry, _) = bronze::current_observation(&wf, at(1), &pods, None)
            .context("missing the retry Bronze execution")?;
        assert_ne!(retry.key(), first.key(), "{template}");
    }
    wf.data["status"]["nodes"]["new-bronze-step"] = Value::Null;
    let mut wait: Value = serde_json::from_str(&bronze_capacity_marker(6, 2, 7, None))?;
    wait["workflow_uid"] = json!(wf.metadata.uid);
    wf.metadata.annotations.get_or_insert_default().insert(
        "insight.cyberfabric.com/airbyte-capacity-wait".into(),
        wait.to_string(),
    );
    let (retry, _) = bronze::current_observation(&wf, at(1), &pods, None)
        .context("missing the retry capacity wait")?;
    assert_ne!(retry.key(), first.key());
    assert_eq!(retry.status, "queued");
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn history_keeps_the_succeeded_bronze_attempt_when_only_transform_retries() -> Result<()> {
    use sea_orm::Database;
    use sea_orm_migration::MigratorTrait;

    use crate::domain::run_history::history;
    use crate::migration::Migrator;

    let db = Database::connect(std::env::var("INTEGRATION_TESTS_MARIADB_URL")?).await?;
    Migrator::up(&db, None).await?;
    let stand = uuid::Uuid::new_v4().to_string();
    let initial = transform_retry_workflow()?;
    let pods = HashMap::new();
    let mut first = None;
    for (now, execution, end, retained) in [
        (5, 1, Some(at(5)), true),
        (6, 6, None, true),
        (6, 6, None, false),
        (7, 6, Some(at(7)), true),
    ] {
        let mut wf = initial.clone();
        if execution == 6 {
            retry_transform(&mut wf, end);
        }
        if !retained {
            let transform = wf.data["status"]["nodes"]["transform"].clone();
            wf.data["status"]["nodes"] = json!({"transform": transform});
            wf.metadata.annotations = None;
        }
        let (mut run, has_bronze) = identity(&wf, at(now), false).context("missing the run")?;
        assert!(has_bronze);
        run.stages = nodes::transforms(&wf.data["status"], &pods, run.finished_at);
        run.stages.extend(
            bronze::current_observation(&wf, run.created_at, &pods, run.finished_at)
                .map(|(stage, _)| stage),
        );
        store::save(&db, &stand, &run, at(now)).await?;

        let result = history::runs(&db, &stand, "jira", Some("tenant"), Some("example")).await?;
        let run = &result[0];
        assert_eq!(run.execution_started_at, at(execution));
        let bronze: Vec<_> = run
            .stages
            .iter()
            .filter(|stage| stage.stage == "bronze")
            .collect();
        assert_eq!(
            bronze.len(),
            1,
            "Bronze count at execution {execution}, time {now}, retained nodes {retained}"
        );
        assert_eq!(bronze[0].status, "succeeded");
        assert_eq!(bronze[0].airbyte_job_id.as_deref(), Some("19"));
        let stored = serde_json::to_value(bronze[0])?;
        assert_eq!(first.get_or_insert_with(|| stored.clone()), &stored);
        assert_eq!(run.records_reported, Some(42));
        assert_eq!(run.load_ms, Some(3_600_000));
    }
    Ok(())
}

#[test]
fn bronze_retry_takes_the_job_only_from_the_new_launch_mark() -> Result<()> {
    let first = bronze_launch_mark(1, 1, 19);
    let mut wf = workflow(&json!({
        "phase":"Running", "startedAt":at(6), "nodes":{
            "trigger":{"id":"trigger", "type":"Pod", "templateName":"trigger-sync", "phase":"Succeeded",
                "startedAt":at(1), "finishedAt":at(2),
                "outputs":{"result":"19","parameters":[{"name":"airbyte-launch-evidence","value":first.to_string()}]}},
            "poll":{"id":"poll", "type":"Pod", "templateName":"poll-job", "phase":"Running",
                "startedAt":at(6), "inputs":{"parameters":[{"name":"job_id","value":"19"}]}}
        }
    }))?;
    wf.metadata.annotations.get_or_insert_default().insert(
        "insight.cyberfabric.com/airbyte-launch".into(),
        first.to_string(),
    );
    let pods = HashMap::new();
    let (load, lookup) = bronze::observation(&wf, at(1), &pods, None);
    assert_eq!((load.job, lookup, load.status), (None, false, "starting"));

    wf.data["status"]["nodes"]["poll"]["phase"] = json!("Failed");
    wf.data["status"]["nodes"]["poll"]["finishedAt"] = json!(at(7));
    let (failed, _) = bronze::observation(&wf, at(1), &pods, Some(at(7)));
    assert_eq!(
        (failed.job, failed.status, failed.reason.as_deref()),
        (None, "failed", Some("stage_failed"))
    );
    wf.data["status"]["nodes"]["poll"]["phase"] = json!("Running");
    wf.data["status"]["nodes"]["poll"]["finishedAt"] = Value::Null;

    for foreign in [
        bronze_launch_mark(1, 1, 19)
            .to_string()
            .replace("aaaaaaaa", "cccccccc"),
        json!({"workflow_uid":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","outcome":"later"})
            .to_string(),
    ] {
        let mut other = wf.clone();
        other.data["status"]["nodes"]["trigger"]["outputs"]["parameters"][0]["value"] =
            json!(foreign);
        other.metadata.annotations.get_or_insert_default().insert(
            "insight.cyberfabric.com/airbyte-launch".into(),
            foreign.clone(),
        );
        let (load, lookup) = bronze::observation(&other, at(1), &pods, None);
        assert_eq!((load.job, lookup), (None, false), "{foreign}");
    }

    let relaunch = bronze_launch_mark(6, 2, 20);
    wf.metadata.annotations.get_or_insert_default().insert(
        "insight.cyberfabric.com/airbyte-launch".into(),
        relaunch.to_string(),
    );
    let (load, lookup) = bronze::observation(&wf, at(1), &pods, None);
    assert_eq!(
        (load.job, lookup, load.status, load.attempt),
        (Some(20), true, "loading", 2)
    );
    Ok(())
}

mod pod_history;
