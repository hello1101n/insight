use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::{Json, Router, extract::State, routing::get};
use chrono::Utc;
use sea_orm::{DatabaseBackend, MockDatabase};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::task::JoinSet;

use super::observe_work;
use crate::api::AppState;
use crate::domain::admission::StageRow;
use crate::infra::{cluster::Cluster, identity::IdentityClient};

async fn pod_exits(State(query_running): State<Arc<AtomicBool>>) -> Json<Value> {
    // The pod submits its last query immediately before disappearing from Kubernetes.
    query_running.store(true, Ordering::SeqCst);
    Json(json!({"apiVersion":"v1","kind":"PodList","metadata":{},"items":[]}))
}

async fn query_evidence(State(query_running): State<Arc<AtomicBool>>) -> Vec<u8> {
    // RowBinary fields in QueryEvidence order. An earlier metadata query already completed.
    [
        u64::from(query_running.load(Ordering::SeqCst)),
        1,
        1,
        0,
        0,
        0,
        0,
        0,
    ]
    .into_iter()
    .flat_map(u64::to_le_bytes)
    .collect()
}

async fn serve(app: Router, servers: &mut JoinSet<std::io::Result<()>>) -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    servers.spawn(async move { axum::serve(listener, app).await });
    Ok(port)
}

#[tokio::test]
async fn last_query_submitted_as_pod_exits_retains_the_grant() -> anyhow::Result<()> {
    let mut servers = JoinSet::new();
    let query_running = Arc::new(AtomicBool::new(false));
    let pods = Router::new()
        .route("/api/v1/namespaces/fixture/pods", get(pod_exits))
        .with_state(Arc::clone(&query_running));
    let warehouse = Router::new()
        .fallback(query_evidence)
        .with_state(Arc::clone(&query_running));
    let state = test_state(pods, warehouse, &mut servers).await?;
    let row = running_stage();
    let observation =
        observe_work(&state, &reqwest::Client::new(), &row, &Value::Null, true).await?;
    assert!(query_running.load(Ordering::SeqCst));
    assert!(
        observation.finished_at.is_none(),
        "released capacity with a running last query"
    );
    assert_eq!(observation.status.as_deref(), Some("unknown"));
    Ok(())
}

async fn test_state(
    pods: Router,
    warehouse: Router,
    servers: &mut JoinSet<std::io::Result<()>>,
) -> anyhow::Result<AppState> {
    let kube_url = format!("http://127.0.0.1:{}", serve(pods, servers).await?);
    let warehouse_url = format!(
        "http://mocked.clickhouse.test:{}",
        serve(warehouse, servers).await?
    );
    let client = kube::Client::try_from(kube::Config::new(kube_url.parse()?))?;
    Ok(AppState {
        db: MockDatabase::new(DatabaseBackend::MySql).into_connection(),
        ch: insight_clickhouse::Client::new(insight_clickhouse::Config::new(
            &warehouse_url,
            "default",
        )),
        identity: IdentityClient::new(&kube_url)?,
        cluster: Cluster::new(client, "fixture", "tenant"),
        schedule_slots: tokio::sync::Semaphore::new(1),
    })
}

fn running_stage() -> StageRow {
    let now = Utc::now();
    StageRow {
        id: 1,
        sync_id: "7a57fc05-3455-48e7-bdad-e36084b89ecc".into(),
        workflow_name: "fixture".into(),
        connector: "mock".into(),
        source_id: "fixture".into(),
        stage: "transform-staging".into(),
        attempt: 1,
        status: "transforming".into(),
        decision: "granted".into(),
        estimated_bytes: 1,
        reason: None,
        cold: true,
        queued_at: now,
        started_at: Some(now),
        granted_at: Some(now),
        finished_at: None,
        airbyte_job_id: None,
        connection_id: None,
        airbyte_claimed: false,
        airbyte_previous_job: None,
    }
}

mod placement;

#[tokio::test]
async fn finishing_stage_waits_for_heavy_queries_still_buffered_in_query_log() -> anyhow::Result<()>
{
    let mut servers = JoinSet::new();
    let flushed = Arc::new(AtomicBool::new(false));
    let kube = Router::new().route(
        "/api/v1/namespaces/fixture/pods",
        get(|| async {
            Json(json!({"apiVersion":"v1","kind":"PodList","metadata":{},"items":[]}))
        }),
    );
    let ch = Router::new()
        .fallback(|State(flushed): State<Arc<AtomicBool>>| async move {
            let (peak, completed) = if flushed.load(Ordering::SeqCst) {
                (90_000_000, 3)
            } else {
                (1024, 1)
            };
            [0_u64, peak, completed, 0, 0, 0, 0, 0]
                .into_iter()
                .flat_map(u64::to_le_bytes)
                .collect::<Vec<_>>()
        })
        .with_state(Arc::clone(&flushed));
    let state = test_state(kube, ch, &mut servers).await?;
    let row = running_stage();
    let http = reqwest::Client::new();
    let mut status = json!({"nodes":{"work":{"type":"Pod","displayName":row.stage,
        "templateRef":{"name":"dbt-run","template":"run"},"phase":"Succeeded","finishedAt":Utc::now()}}});
    let early = observe_work(&state, &http, &row, &status, false).await?;
    assert_eq!(early.peak_bytes, Some(1024));
    assert!(
        early.finished_at.is_none(),
        "finalized the early metadata query as the complete history"
    );
    flushed.store(true, Ordering::SeqCst);
    status["nodes"]["work"]["finishedAt"] = json!(Utc::now() - chrono::Duration::seconds(11));
    let final_sample = observe_work(&state, &http, &row, &status, false).await?;
    assert_eq!(final_sample.peak_bytes, Some(90_000_000));
    assert_eq!(final_sample.status.as_deref(), Some("succeeded"));
    Ok(())
}
