use super::*;
use crate::domain::admission::reconcile::{placement, workflows};
use axum::http::StatusCode;
use axum::routing::patch;
use kube::api::DynamicObject;
use std::sync::atomic::AtomicUsize;

fn api_workflow(row: &StageRow, guarded: bool) -> anyhow::Result<DynamicObject> {
    let mut node = json!({"id":"worker","type":"Pod","phase":"Pending","displayName":"transform-staging",
        "templateRef":{"name":"dbt-run","template":"run"},"inputs":{"parameters":[]},
        "message":"pods \"worker\" is forbidden: exceeded quota: stand-memory, requested: requests.memory=2Gi"});
    if guarded {
        node["inputs"]["parameters"] =
            json!([{"name":"admission_start_guard","value":"workflow-v1"}]);
    }
    Ok(serde_json::from_value(
        json!({"apiVersion":"argoproj.io/v1alpha1","kind":"Workflow","metadata":{
        "name":row.workflow_name,"uid":row.sync_id,"resourceVersion":"42"},"spec":{},
        "status":{"phase":"Running","nodes":{"worker":node}}}),
    )?)
}

#[tokio::test]
async fn absent_pod_with_quota_denial_times_out_only_before_work_wins() -> anyhow::Result<()> {
    let mut servers = JoinSet::new();
    let patches = Arc::new(AtomicUsize::new(0));
    let mut row = running_stage();
    row.started_at = None;
    row.granted_at = Some(row.queued_at);
    let wf = api_workflow(&row, true)?;
    let server_wf = wf.clone();
    let kube = Router::new()
        .route(
            "/api/v1/namespaces/fixture/pods",
            get(|| async {
                Json(json!({"apiVersion":"v1","kind":"PodList","metadata":{},"items":[]}))
            }),
        )
        .route(
            "/apis/argoproj.io/v1alpha1/namespaces/fixture/workflows/fixture",
            patch(
                move |State(p): State<Arc<AtomicUsize>>, Json(request): Json<Value>| async move {
                    assert_eq!(request["metadata"]["resourceVersion"], "42");
                    assert_eq!(
                        request["metadata"]["uid"].as_str(),
                        server_wf.metadata.uid.as_deref()
                    );
                    assert_eq!(request["spec"]["shutdown"], "Terminate");
                    assert_eq!(
                        request["metadata"]["annotations"][placement::key("transform-staging", 1)],
                        "wait_timeout"
                    );
                    p.fetch_add(1, Ordering::SeqCst);
                    Json(server_wf)
                },
            ),
        )
        .with_state(Arc::clone(&patches));
    let state = test_state(
        kube,
        Router::new().fallback(|| async { vec![0u8; 64] }),
        &mut servers,
    )
    .await?;
    let api = workflows(&state)?;
    let http = reqwest::Client::new();
    let observed = placement::observe(&state, &api, &http, &row, &wf, false).await?;
    assert_eq!(observed.status.as_deref(), Some("waiting_pod"));
    row.queued_at -= chrono::Duration::hours(7);
    let legacy = placement::observe(
        &state,
        &api,
        &http,
        &row,
        &api_workflow(&row, false)?,
        false,
    )
    .await?;
    assert_eq!(legacy.status.as_deref(), Some("placement_overdue"));
    let mut started = wf.clone();
    started
        .metadata
        .annotations
        .get_or_insert_default()
        .insert(placement::key(&row.stage, 1), row.sync_id.clone());
    let started = placement::observe(&state, &api, &http, &row, &started, false).await?;
    assert_ne!(started.status.as_deref(), Some("stopping_pod_wait"));
    assert_eq!(patches.load(Ordering::SeqCst), 0);
    let expired = placement::observe(&state, &api, &http, &row, &wf, false).await?;
    assert_eq!(expired.status.as_deref(), Some("stopping_pod_wait"));
    assert!(expired.finished_at.is_none());
    assert_eq!(patches.load(Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test]
async fn placement_decisions_contend_on_the_same_workflow_revision() -> anyhow::Result<()> {
    let mut servers = JoinSet::new();
    let row = running_stage();
    let wf = api_workflow(&row, true)?;
    for expire_first in [true, false] {
        let claimed = Arc::new(AtomicBool::new(false));
        let copy = wf.clone();
        let kube=Router::new().route("/apis/argoproj.io/v1alpha1/namespaces/fixture/workflows/fixture",
            patch(move |State(claimed):State<Arc<AtomicBool>>,Json(req):Json<Value>|async move {
                assert_eq!(req["metadata"]["resourceVersion"],"42");
                assert_eq!(req["metadata"]["uid"].as_str(),copy.metadata.uid.as_deref());
                let stopping=req["spec"]["shutdown"]=="Terminate";
                let key=placement::key("transform-staging",1);
                assert_eq!(req["metadata"]["annotations"][&key],if stopping {json!("wait_timeout")} else {json!(copy.metadata.uid)});
                if claimed.swap(true,Ordering::SeqCst) {
                    (StatusCode::CONFLICT,Json(json!({"kind":"Status","apiVersion":"v1","status":"Failure",
                        "code":409,"reason":"Conflict","message":"stale workflow revision"})))
                } else {
                    (StatusCode::OK,Json(json!(copy)))
                }
            })).with_state(claimed);
        let state = test_state(kube, Router::new(), &mut servers).await?;
        let api = workflows(&state)?;
        let key = placement::key(&row.stage, 1);
        placement::decide(&api, &wf, &key, expire_first).await?;
        assert!(
            placement::decide(&api, &wf, &key, !expire_first)
                .await
                .is_err()
        );
    }
    Ok(())
}

#[tokio::test]
async fn native_placement_overdue_recovers_when_worker_runs() -> anyhow::Result<()> {
    let mut servers = JoinSet::new();
    let running = Arc::new(AtomicBool::new(false));
    let pods=Router::new().fallback(move |State(running):State<Arc<AtomicBool>>|async move {
        let mut p=json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"replication"},"spec":{"containers":[{"name":"source","image":"source"}]},"status":{"phase":"Pending"}});
        if running.load(Ordering::SeqCst) {
            p["spec"]["nodeName"]=json!("node");
            p["status"]["phase"]=json!("Running");
        }
        Json(json!({"apiVersion":"v1","kind":"PodList","metadata":{},"items":[p]}))
    }).with_state(Arc::clone(&running));
    let mut state = test_state(
        pods,
        Router::new().fallback(|| async { vec![0u8; 64] }),
        &mut servers,
    )
    .await?;
    state.cluster.airbyte_namespace = "fixture".to_owned();
    let mut row = running_stage();
    row.stage = "bronze".into();
    row.airbyte_claimed = true;
    row.airbyte_job_id = Some("7".into());
    row.connection_id = Some("connection".into());
    row.started_at = None;
    row.queued_at -= chrono::Duration::hours(7);
    let http = reqwest::Client::new();
    let first = observe_work(&state, &http, &row, &Value::Null, false).await?;
    assert_eq!(first.status.as_deref(), Some("placement_overdue"));
    assert!(first.finished_at.is_none());
    row.status = "placement_overdue".into();
    running.store(true, Ordering::SeqCst);
    let next = observe_work(&state, &http, &row, &Value::Null, false).await?;
    assert_eq!(next.status.as_deref(), Some("loading"));
    assert!(next.finished_at.is_none());
    Ok(())
}

#[tokio::test]
async fn stalled_required_pod_listing_fails_closed_within_one_cycle() -> anyhow::Result<()> {
    let mut servers = JoinSet::new();
    let kube = Router::new().fallback(|| async {
        tokio::time::sleep(std::time::Duration::from_secs(12)).await;
        Json(json!({"apiVersion":"v1","kind":"PodList","metadata":{},"items":[]}))
    });
    let state = test_state(kube, Router::new(), &mut servers).await?;
    let sample = tokio::time::timeout(
        std::time::Duration::from_secs(7),
        crate::domain::admission::reconcile::pods::observe(&state, &running_stage()),
    )
    .await?;
    assert!(sample.is_err());
    Ok(())
}
