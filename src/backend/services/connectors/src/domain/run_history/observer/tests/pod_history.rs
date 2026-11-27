use super::*;

#[tokio::test]
async fn pods_report_placement_and_previous_container_oom() -> Result<()> {
    use axum::{Json, Router, extract::Path, routing::get};
    use tokio::net::TcpListener;

    let owner = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    let pod = |node: &str, status: Value| {
        json!({
            "metadata": {
                "annotations": {"workflows.argoproj.io/node-id": node},
                "ownerReferences": [{
                    "apiVersion": "argoproj.io/v1alpha1", "kind": "Workflow",
                    "name": "example-sync", "uid": owner
                }]
            },
            "status": status
        })
    };
    let containers = |name: &str| {
        json!({
            "phase": "Failed", "containerStatuses": [{
                "name": name, "image":"example", "imageID":"example", "ready":false, "restartCount":1,
                "state":{"waiting":{"reason":"BackOff"}},
                "lastState":{"terminated":{"exitCode":137,"reason":"OOMKilled"}}
            }]
        })
    };
    let pods = json!([
        pod(
            "pending",
            json!({"phase":"Pending","conditions":[{
                "type":"PodScheduled","status":"False","reason":"Unschedulable","lastTransitionTime":at(2)
            }]})
        ),
        pod("failed", containers("main"))
    ]);
    let airbyte_pods = json!([pod("source", containers("source"))]);
    let server =
        Router::new().route(
            "/api/v1/namespaces/{namespace}/pods",
            get(move |Path(namespace): Path<String>| {
                let items = if namespace == "example-airbyte" {
                    airbyte_pods.clone()
                } else {
                    pods.clone()
                };
                async move {
                    Json(json!({"apiVersion":"v1","kind":"PodList","metadata":{},"items":items}))
                }
            }),
        );
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let task = tokio::spawn(async move { axum::serve(listener, server).await });
    let client = kube::Client::try_from(kube::Config::new(url.parse()?))?;
    let observed = pods::workflow(client.clone(), "example", "example-sync", owner).await?;
    let status = json!({"nodes":{
        "pending":{"id":"pending","displayName":"transform-jira-staging","type":"Pod","phase":"Pending","startedAt":at(1)},
        "failed":{"id":"failed","displayName":"identity-seed","type":"Pod","phase":"Failed","startedAt":at(1),"finishedAt":at(3)}
    }});
    let stages = nodes::transforms(&status, &observed, None);
    let pending = stages
        .iter()
        .find(|stage| stage.stage == "transform-jira-staging")
        .context("pending stage")?;
    let failed = stages
        .iter()
        .find(|stage| stage.stage == "identity-seed")
        .context("failed stage")?;
    assert_eq!(
        pending
            .wait
            .as_ref()
            .map(|wait| (wait.kind, wait.started_at)),
        Some((WaitKind::Placement, at(2)))
    );
    assert_eq!(pending.status, "queued");
    assert_eq!(failed.reason.as_deref(), Some("pod_oom"));

    let mut cluster = crate::infra::cluster::Cluster::new(client, "example", "example-tenant");
    cluster.airbyte_namespace = "example-airbyte".into();
    let app = AppState {
        db: sea_orm::MockDatabase::new(sea_orm::DbBackend::MySql).into_connection(),
        ch: insight_clickhouse::Client::new(insight_clickhouse::Config::new(&url, "default")),
        cluster,
        identity: crate::infra::identity::IdentityClient::new(&url)?,
        schedule_slots: tokio::sync::Semaphore::new(1),
    };
    let mut bronze = StageSnapshot::new("bronze", 1, at(1));
    bronze.job = Some(42);
    bronze.connection = Some("11111111-1111-1111-1111-111111111111".into());
    bronze.status = "failed";
    bronze.finished_at = Some(at(3));
    observe_bronze(&app, &reqwest::Client::new(), &mut bronze, false).await;
    assert_eq!(bronze.reason.as_deref(), Some("source_pod_oom"));
    task.abort();
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn argo_retry_numbers_a_rerun_of_the_same_stage_node() -> Result<()> {
    use sea_orm_migration::MigratorTrait;

    let db = sea_orm::Database::connect(std::env::var("INTEGRATION_TESTS_MARIADB_URL")?).await?;
    crate::migration::Migrator::up(&db, None).await?;
    let stand = uuid::Uuid::new_v4().to_string();
    let uid = uuid::Uuid::new_v4().to_string();
    for (start, end, phase) in [(at(1), Some(at(2)), "Failed"), (at(3), None, "Running")] {
        let mut object = workflow(&json!({
            "phase":phase,"startedAt":start,"finishedAt":end,
            "nodes":{"stage":{"id":"stage","displayName":"transform-jira-staging","type":"Pod",
                "phase":phase,"startedAt":start,"finishedAt":end}}
        }))?;
        object.metadata.uid = Some(uid.clone());
        let observed = end.unwrap_or(start);
        let (mut run, _) = identity(&object, observed, false).context("ingestion workflow")?;
        run.stages = nodes::transforms(&object.data["status"], &HashMap::new(), run.finished_at);
        store::save(&db, &stand, &run, observed).await?;
    }

    let runs = crate::domain::run_history::history::runs(
        &db,
        &stand,
        "jira",
        Some("tenant"),
        Some("example"),
    )
    .await?;
    assert_eq!(runs.len(), 1);
    let attempts: Vec<_> = runs[0]
        .stages
        .iter()
        .map(|stage| (stage.attempt, stage.status.as_str()))
        .collect();
    assert_eq!(attempts, [(1, "failed"), (2, "transforming")]);
    Ok(())
}
