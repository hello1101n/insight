use super::*;
use crate::domain::admission::history;
use sea_orm_migration::MigratorTrait;

fn request(connector: &str, stage: &str) -> Request {
    let id = uuid::Uuid::now_v7();
    Request {
        sync_id: id,
        workflow_name: format!("test-{id}"),
        mode_signature: Some("a".repeat(64)),
        connector: connector.into(),
        source_id: format!("{connector}-test"),
        stage: stage.into(),
        attempt: 1,
        connection_id: (stage == "bronze").then(|| uuid::Uuid::now_v7().to_string()),
    }
}
async fn db() -> anyhow::Result<DatabaseConnection> {
    let url = std::env::var("INTEGRATION_TESTS_MARIADB_URL")?;
    insight_migration::with_migration_session(
        &url,
        crate::infra::db::MIGRATION_LOCK,
        crate::infra::db::MIGRATION_LOCK_TIMEOUT,
        |db| async move {
            crate::migration::Migrator::up(&db, None).await?;
            Ok(())
        },
    )
    .await?;
    crate::infra::db::connect(&url).await
}
async fn load(db: &DatabaseConnection, stand: &str, req: &Request) -> anyhow::Result<StageRow> {
    unfinished(db, stand)
        .await?
        .into_iter()
        .find(|r| {
            r.sync_id == req.sync_id.to_string() && r.stage == req.stage && r.attempt == req.attempt
        })
        .ok_or_else(|| anyhow::anyhow!("missing stage"))
}
async fn assert_stale_cancel_rejected(
    db: &DatabaseConnection,
    stand: &str,
    req: &Request,
    before_claim: &StageRow,
    now: DateTime<Utc>,
) -> anyhow::Result<()> {
    observe(
        db,
        stand,
        before_claim,
        Observation {
            status: Some("cancelled".into()),
            finished_at: Some(now),
            run_status: Some("cancelled".into()),
            run_finished_at: Some(now),
            ..Default::default()
        },
    )
    .await?;
    assert!(load(db, stand, req).await?.finished_at.is_none());
    Ok(())
}

async fn record_bronze_input(
    db: &DatabaseConnection,
    stand: &str,
    req: &Request,
    now: DateTime<Utc>,
    volume: Option<u64>,
) -> anyhow::Result<()> {
    let mut bronze = request(&req.connector, "bronze");
    bronze.sync_id = req.sync_id;
    bronze.workflow_name.clone_from(&req.workflow_name);
    bronze.source_id.clone_from(&req.source_id);
    bronze.mode_signature.clone_from(&req.mode_signature);
    register(db, stand, "tenant", &bronze, now, 60).await?;
    let row = load(db, stand, &bronze).await?;
    observe(
        db,
        stand,
        &row,
        Observation {
            status: Some("succeeded".into()),
            started_at: Some(now),
            finished_at: Some(now),
            volume_bytes: volume,
            peak_bytes: Some(1),
            ..Default::default()
        },
    )
    .await?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn concurrent_admissions_share_one_stand_and_keep_original_branch() -> anyhow::Result<()> {
    let db = db().await?;
    let stand = uuid::Uuid::now_v7().to_string();
    let now = Utc::now();
    let tenant = "tenant";
    for connector in ["jira", "github"] {
        let req = request(connector, "transform-staging");
        record_bronze_input(&db, &stand, &req, now, Some(100)).await?;
        let (_, r) = register(&db, &stand, tenant, &req, now, 60).await?;
        assert_eq!(r.decision, "granted");
        let row = load(&db, &stand, &req).await?;
        observe(
            &db,
            &stand,
            &row,
            Observation {
                status: Some("succeeded".into()),
                started_at: Some(now),
                finished_at: Some(now),
                run_status: Some("succeeded".into()),
                run_finished_at: Some(now),
                peak_bytes: Some(24),
                ..Default::default()
            },
        )
        .await?;
    }
    let (a, b) = (
        request("jira", "transform-staging"),
        request("github", "transform-staging"),
    );
    record_bronze_input(&db, &stand, &a, now, Some(100)).await?;
    record_bronze_input(&db, &stand, &b, now, Some(100)).await?;
    let (r1, r2) = tokio::join!(
        register(&db, &stand, tenant, &a, now, 45),
        register(&db, &stand, tenant, &b, now, 45)
    );
    let (a_grant, b_grant) = (r1?.1.decision, r2?.1.decision);
    assert!(matches!(
        (a_grant.as_str(), b_grant.as_str()),
        ("granted", "queued") | ("queued", "granted")
    ));
    let (active, waiting) = if a_grant == "granted" {
        (&a, &b)
    } else {
        (&b, &a)
    };
    let waiting_row = load(&db, &stand, waiting).await?;
    assert!(!promote(&db, &stand, &waiting_row, 45).await?);
    assert!(promote(&db, &stand, &waiting_row, 60).await?);
    let (new, repeated) = register(&db, &stand, tenant, waiting, now, 0).await?;
    assert!(!new);
    assert_eq!(repeated.decision, "queued");
    let (new, repeated) = register(&db, &stand, tenant, active, now, 0).await?;
    assert!(!new);
    assert_eq!(repeated.decision, "granted");
    let runs = history::runs(&db, &stand, &a.connector, Some(tenant), Some(&a.source_id)).await?;
    assert_eq!(runs.len(), 2);
    assert!(
        history::runs(&db, &stand, &a.connector, None, None)
            .await?
            .is_empty()
    );
    let live = load(&db, &stand, waiting).await?;
    observe(
        &db,
        &stand,
        &live,
        Observation {
            status: Some("wait_timeout".into()),
            finished_at: Some(now),
            ..Default::default()
        },
    )
    .await?;
    let waiting_history = history::runs(
        &db,
        &stand,
        &waiting.connector,
        Some(tenant),
        Some(&waiting.source_id),
    )
    .await?;
    assert_eq!(
        waiting_history
            .iter()
            .find(|run| run.sync_id == live.sync_id)
            .map(|run| run.status.as_str()),
        Some("wait_timeout")
    );
    Ok(())
}
#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn lost_airbyte_claim_has_one_sender_and_retries_require_confirmed_safe_replay()
-> anyhow::Result<()> {
    let db = db().await?;
    let stand = uuid::Uuid::now_v7().to_string();
    let now = Utc::now();
    let tenant = "tenant";
    let mut req = request("jira", "bronze");
    register(&db, &stand, tenant, &req, now, 60).await?;
    let before_claim = load(&db, &stand, &req).await?;
    let (a, b) = tokio::join!(
        airbyte(&db, &stand, tenant, &req, None),
        airbyte(&db, &stand, tenant, &req, None)
    );
    assert!(matches!(
        (a?.decision, b?.decision),
        ("send", "verify") | ("verify", "send")
    ));
    assert_stale_cancel_rejected(&db, &stand, &req, &before_claim, now).await?;
    assert_eq!(
        airbyte(&db, &stand, tenant, &req, Some("8101"))
            .await?
            .job_id
            .as_deref(),
        Some("8101")
    );
    assert_eq!(
        airbyte(&db, &stand, tenant, &req, Some("8101"))
            .await?
            .decision,
        "poll"
    );
    assert!(matches!(
        airbyte(&db, &stand, tenant, &req, Some("8102")).await,
        Err(WriteError::Conflict)
    ));
    assert_eq!(
        poll_airbyte(&db, &stand, tenant, &req, 8101).await?.sync_id,
        req.sync_id.to_string()
    );
    assert!(matches!(
        poll_airbyte(&db, &stand, tenant, &req, 8102).await,
        Err(WriteError::Conflict)
    ));
    req.attempt = 2;
    assert!(matches!(
        register(&db, &stand, tenant, &req, now, 60).await,
        Err(WriteError::Conflict)
    ));
    req.attempt = 1;
    let first = load(&db, &stand, &req).await?;
    observe(
        &db,
        &stand,
        &first,
        Observation {
            status: Some("failed".into()),
            finished_at: Some(now),
            reason: Some("source_pod_oom".into()),
            source_oom_limit_bytes: Some(2048 * MIB),
            bronze_replay_safe: Some(true),
            ..Default::default()
        },
    )
    .await?;
    assert_eq!(
        retry_bronze(&db, &stand, tenant, &req, false, 60)
            .await?
            .decision,
        "stop"
    );
    assert_eq!(
        retry_bronze(&db, &stand, tenant, &req, true, 60)
            .await?
            .decision,
        "retry"
    );
    req.attempt = 2;
    let (_, r) = register(&db, &stand, tenant, &req, now, 60).await?;
    assert_eq!(r.resources.scope, "airbyte_source");
    assert_eq!(r.resources.memory_bytes, 3072 * MIB);
    assert_eq!(r.resources.source_memory_bytes, Some(3072 * MIB));
    assert_eq!(
        airbyte(&db, &stand, tenant, &req, None).await?.decision,
        "send"
    );
    assert!(matches!(
        airbyte(&db, &stand, tenant, &req, Some("8101")).await,
        Err(WriteError::Conflict)
    ));
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn ready_time_survives_a_later_quality_failure() -> anyhow::Result<()> {
    use crate::domain::connector_health::{ConnectorHealthResponse, LedgerFacts};
    let db = db().await?;
    let stand = uuid::Uuid::now_v7().to_string();
    let now = Utc::now();
    let mut req = request("jira", "transform-jira-silver");
    register(&db, &stand, "tenant", &req, now, 60).await?;
    let models = load(&db, &stand, &req).await?;
    observe(
        &db,
        &stand,
        &models,
        Observation {
            status: Some("succeeded".into()),
            started_at: Some(now),
            finished_at: Some(now),
            ..Default::default()
        },
    )
    .await?;
    req.stage = "connector-checks".into();
    req.mode_signature = None;
    register(&db, &stand, "tenant", &req, now, 60).await?;
    let checks = load(&db, &stand, &req).await?;
    let mut inventory = ConnectorHealthResponse::from_facts(LedgerFacts::default(), now);
    history::enrich(&db, &stand, &mut inventory).await?;
    assert_eq!(
        inventory.connectors[0]
            .last_successful_run
            .as_ref()
            .map(|r| r.status.as_str()),
        Some("succeeded")
    );
    let later = now + chrono::Duration::minutes(10);
    observe(
        &db,
        &stand,
        &checks,
        Observation {
            status: Some("failed".into()),
            finished_at: Some(later),
            run_status: Some("failed".into()),
            run_finished_at: Some(later),
            ..Default::default()
        },
    )
    .await?;
    let recent = history::runs(&db, &stand, "jira", Some("tenant"), Some(&req.source_id)).await?;
    assert_eq!(recent[0].status, "succeeded");
    assert_eq!(
        recent[0].finished_at.map(|t| t.timestamp_millis()),
        Some(now.timestamp_millis())
    );
    assert_eq!(recent[0].stages[1].status, "failed");
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn warm_parallel_loads_cannot_reuse_an_unknown_connection_or_another_sync_mode()
-> anyhow::Result<()> {
    let db = db().await?;
    let stand = uuid::Uuid::now_v7().to_string();
    let now = Utc::now();
    let baseline = request("jira", "bronze");
    register(&db, &stand, "tenant", &baseline, now, 60).await?;
    let baseline_row = load(&db, &stand, &baseline).await?;
    observe(
        &db,
        &stand,
        &baseline_row,
        Observation {
            status: Some("succeeded".into()),
            started_at: Some(now),
            finished_at: Some(now),
            peak_bytes: Some(10),
            ..Default::default()
        },
    )
    .await?;
    let first = request("jira", "bronze");
    let (_, grant) = register(&db, &stand, "tenant", &first, now, 60).await?;
    assert_eq!(grant.decision, "granted");
    assert_eq!(
        airbyte(&db, &stand, "tenant", &first, None).await?.decision,
        "send"
    );
    let row = load(&db, &stand, &first).await?;
    observe(
        &db,
        &stand,
        &row,
        Observation {
            status: Some("checking_start".into()),
            ..Default::default()
        },
    )
    .await?;
    let mut other = request("jira", "bronze");
    other.connection_id.clone_from(&first.connection_id);
    assert_eq!(
        register(&db, &stand, "tenant", &other, now, 60)
            .await?
            .1
            .decision,
        "queued"
    );
    assert!(matches!(
        airbyte(&db, &stand, "tenant", &other, None).await,
        Err(WriteError::Conflict)
    ));
    let mut changed = request("jira", "bronze");
    changed.mode_signature = Some("b".repeat(64));
    assert_eq!(
        register(&db, &stand, "tenant", &changed, now, 60)
            .await?
            .1
            .decision,
        "queued"
    );
    assert!(load(&db, &stand, &changed).await?.cold);
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn doubled_bronze_input_invalidates_transform_history() -> anyhow::Result<()> {
    let db = db().await?;
    let stand = uuid::Uuid::now_v7().to_string();
    let now = Utc::now();
    for (volume, cold) in [
        (Some(100), true),
        (Some(100), false),
        (Some(200), true),
        (None, true),
    ] {
        let mut req = request("jira", "bronze");
        register(&db, &stand, "tenant", &req, now, 60).await?;
        let row = load(&db, &stand, &req).await?;
        observe(
            &db,
            &stand,
            &row,
            Observation {
                status: Some("succeeded".into()),
                finished_at: Some(now),
                peak_bytes: Some(5),
                volume_bytes: volume,
                ..Default::default()
            },
        )
        .await?;
        req.stage = "transform-jira-silver".into();
        req.connection_id = None;
        req.mode_signature = None;
        register(&db, &stand, "tenant", &req, now, 60).await?;
        let model = load(&db, &stand, &req).await?;
        assert_eq!(model.cold, cold, "input volume {volume:?}");
        observe(
            &db,
            &stand,
            &model,
            Observation {
                status: Some("succeeded".into()),
                finished_at: Some(now),
                peak_bytes: Some(20),
                volume_bytes: Some(5000),
                ..Default::default()
            },
        )
        .await?;
    }
    Ok(())
}
