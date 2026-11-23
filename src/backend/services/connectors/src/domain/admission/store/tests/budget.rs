use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use axum::{Router, extract::State};
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio::task::JoinSet;

use super::*;
use crate::api::AppState;
use crate::domain::admission::capacity;
use crate::infra::{cluster::Cluster, identity::IdentityClient};

struct Warehouse {
    state: AppState,
    used: Arc<AtomicU64>,
    tracked: Arc<AtomicU64>,
    pause: Arc<QueryPause>,
    _servers: JoinSet<std::io::Result<()>>,
}

#[derive(Default)]
struct QueryPause {
    next: AtomicBool,
    started: Notify,
    resume: Notify,
}

impl Warehouse {
    async fn new(
        db: &DatabaseConnection,
        server_limit: u64,
        container_limit: u64,
        used: u64,
    ) -> anyhow::Result<Self> {
        let used = Arc::new(AtomicU64::new(used));
        let tracked = Arc::new(AtomicU64::new(0));
        let pause = Arc::new(QueryPause::default());
        let app = Router::new()
            .fallback(
                move |State((used, tracked, pause)): State<(
                    Arc<AtomicU64>,
                    Arc<AtomicU64>,
                    Arc<QueryPause>,
                )>| async move {
                    if pause.next.swap(false, Ordering::Relaxed) {
                        pause.started.notify_one();
                        pause.resume.notified().await;
                    }
                    let used = used.load(Ordering::Relaxed);
                    let tracked = tracked.load(Ordering::Relaxed);
                    let mut row = b"\x01a".to_vec();
                    for number in [server_limit, container_limit, used, tracked, 50, 0, 0] {
                        row.extend(number.to_le_bytes());
                    }
                    row.push(1);
                    row
                },
            )
            .with_state((Arc::clone(&used), Arc::clone(&tracked), Arc::clone(&pause)));
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let url = format!(
            "http://mocked.clickhouse.test:{}",
            listener.local_addr()?.port()
        );
        let mut servers = JoinSet::new();
        servers.spawn(async move { axum::serve(listener, app).await });
        let mut cluster = Cluster::disabled();
        cluster.namespace = uuid::Uuid::now_v7().to_string();
        Ok(Self {
            state: AppState {
                db: db.clone(),
                ch: insight_clickhouse::Client::new(insight_clickhouse::Config::new(
                    url, "default",
                )),
                identity: IdentityClient::new("http://127.0.0.1")?,
                cluster,
                schedule_slots: tokio::sync::Semaphore::new(1),
            },
            used,
            tracked,
            pause,
            _servers: servers,
        })
    }

    fn stand(&self) -> &str {
        &self.state.cluster.namespace
    }

    async fn refresh(&self) -> anyhow::Result<()> {
        capacity::refresh_idle_budget(&self.state).await
    }

    async fn budget(&self) -> anyhow::Result<u64> {
        capacity::sample(&self.state).await
    }
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn budget_subtracts_idle_memory_and_dashboard_reserve() -> anyhow::Result<()> {
    let db = db().await?;
    let now = Utc::now();
    let mut warehouse = Warehouse::new(&db, 3_865_470_566, 4_294_967_296, 1_268_146_176).await?;
    let stand = warehouse.stand();
    warehouse.refresh().await?;
    record_bronze_peak(&db, stand, "jira", now, 1_600_000_000).await?;
    let budget = warehouse.budget().await?;
    assert_eq!(
        budget, 2_210_777_334,
        "subtract the idle baseline and a 10% reserve"
    );

    let req = request("jira", "bronze");
    assert_eq!(
        register(&db, stand, "tenant", &req, now, budget)
            .await?
            .1
            .decision,
        "granted"
    );
    assert_eq!(load(&db, stand, &req).await?.estimated_bytes, 2_000_000_000);

    warehouse.state.cluster.admission_dashboard_reserve_percent = 20;
    assert_eq!(warehouse.budget().await?, 1_824_230_277);
    warehouse.state.cluster.admission_budget_override_bytes = Some(700 * MIB);
    assert_eq!(warehouse.budget().await?, 700 * MIB);
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn missing_idle_baseline_allows_packing_while_a_stage_is_active() -> anyhow::Result<()> {
    let db = db().await?;
    let now = Utc::now();
    let limit = 4096 * MIB;
    let stage_usage = 100 * MIB;
    let stage_reservation = 640 * MIB;
    let container_used = 1024 * MIB + stage_usage;
    let warehouse = Warehouse::new(&db, limit, limit, container_used).await?;
    let stand = warehouse.stand();
    record_bronze_peak(&db, stand, "jira", now, 512 * MIB).await?;
    record_bronze_peak(&db, stand, "github", now, 32 * MIB).await?;
    let holder = request("jira", "bronze");
    assert_eq!(
        register(&db, stand, "tenant", &holder, now, limit)
            .await?
            .1
            .decision,
        "granted"
    );

    let req = request("github", "bronze");
    register(&db, stand, "tenant", &req, now, 0).await?;
    let row = load(&db, stand, &req).await?;
    let budget = warehouse.budget().await?;
    let remaining = budget.saturating_sub(stage_reservation);
    let remaining_after_growth =
        limit - limit / 10 - container_used - (stage_reservation - stage_usage);
    assert!(
        remaining <= remaining_after_growth,
        "available budget {remaining} exceeds {remaining_after_growth} after reservation growth"
    );
    assert_eq!(budget, limit - container_used - limit / 10);
    assert_eq!(
        promote_ready(&db, stand, &HashSet::from([row.id]), budget).await?,
        [row.id],
        "the queued stage fits the estimated budget"
    );
    assert_eq!(
        load(&db, stand, &holder).await?.estimated_bytes,
        stage_reservation
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn stale_idle_samples_use_the_tracked_memory_floor() -> anyhow::Result<()> {
    let db = db().await?;
    let now = Utc::now();
    let limit = 4096 * MIB;
    let warehouse = Warehouse::new(&db, limit, limit, 512 * MIB).await?;
    let stand = warehouse.stand();
    warehouse.refresh().await?;
    record_bronze_peak(&db, stand, "jira", now, 512 * MIB).await?;
    let holder = request("jira", "bronze");
    assert_eq!(
        register(&db, stand, "tenant", &holder, now, limit)
            .await?
            .1
            .decision,
        "granted"
    );
    warehouse.used.store(2048 * MIB, Ordering::Relaxed);
    warehouse.tracked.store(2300 * MIB, Ordering::Relaxed);
    assert_eq!(warehouse.budget().await?, limit - 512 * MIB - limit / 10);
    db.execute_raw(sql(
        "UPDATE ingestion_idle_memory_samples SET sampled_at=UTC_TIMESTAMP(3)-INTERVAL 86401 SECOND WHERE stand=?",
        vec![stand.into()],
    )).await?;

    assert_eq!(
        warehouse.budget().await?,
        limit - 2300 * MIB - limit / 10,
        "the stale baseline must yield to the tracked memory floor"
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn recent_stage_release_blocks_an_idle_sample() -> anyhow::Result<()> {
    let db = db().await?;
    let reported_finish = Utc::now() - chrono::Duration::minutes(5);
    let limit = 4096 * MIB;
    let warehouse = Warehouse::new(&db, limit, limit, 512 * MIB).await?;
    let stand = warehouse.stand();
    warehouse.refresh().await?;
    let original = warehouse.budget().await?;
    record_bronze_peak(&db, stand, "jira", reported_finish, 32 * MIB).await?;
    tokio::time::sleep(Duration::from_secs(1)).await;
    warehouse.used.store(2048 * MIB, Ordering::Relaxed);
    warehouse.refresh().await?;
    assert_eq!(
        warehouse.budget().await?,
        original,
        "one second of idle time is below the settle period"
    );
    let recorded = db
        .query_one_raw(sql(
            "SELECT 1 FROM ingestion_idle_memory_samples WHERE stand=? AND used_bytes=?",
            vec![stand.into(), (2048 * MIB).into()],
        ))
        .await?;
    assert!(recorded.is_none(), "the recent sample must not be stored");
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn idle_baseline_keeps_the_smallest_sample_in_the_window() -> anyhow::Result<()> {
    let db = db().await?;
    let limit = 4096 * MIB;
    let warehouse = Warehouse::new(&db, limit, limit, 1_600_000_000).await?;
    warehouse.refresh().await?;
    warehouse.used.store(1_300_000_000, Ordering::Relaxed);
    warehouse.refresh().await?;
    warehouse.used.store(1_600_000_000, Ordering::Relaxed);
    warehouse.refresh().await?;
    assert_eq!(
        warehouse.budget().await?,
        limit - 1_300_000_000 - limit / 10
    );
    db.execute_raw(sql(
        "UPDATE ingestion_idle_memory_samples SET sampled_at=TIMESTAMPADD(
            SECOND, IF(used_bytes=1300000000,-3601,-1800), sampled_at)
         WHERE stand=?",
        vec![warehouse.stand().into()],
    ))
    .await?;
    let with_fresh_sample = warehouse.budget().await?;

    db.execute_raw(sql(
        "UPDATE ingestion_idle_memory_samples SET sampled_at=sampled_at-INTERVAL 3601 SECOND
         WHERE stand=?",
        vec![warehouse.stand().into()],
    ))
    .await?;
    warehouse.used.store(1_800_000_000, Ordering::Relaxed);
    let without_fresh_sample = warehouse.budget().await?;
    assert_eq!(
        [with_fresh_sample, without_fresh_sample],
        [
            limit - 1_600_000_000 - limit / 10,
            limit - 1_800_000_000 - limit / 10
        ],
        "a window anchored to now uses a recent sample or falls back"
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn idle_probe_leaves_the_stand_unlocked_and_discards_overlapping_samples()
-> anyhow::Result<()> {
    let db = db().await?;
    let limit = 4096 * MIB;
    let warehouse = Warehouse::new(&db, limit, limit, 512 * MIB).await?;
    let stand = warehouse.stand();
    warehouse.pause.next.store(true, Ordering::Relaxed);
    let concurrent = async {
        warehouse.pause.started.notified().await;
        let write = async {
            let reported_finish = Utc::now() - chrono::Duration::minutes(5);
            record_bronze_peak(&db, stand, "jira", reported_finish, 32 * MIB).await
        };
        let outcome = tokio::time::timeout(Duration::from_millis(800), write).await;
        warehouse.pause.resume.notify_one();
        outcome
    };
    let (sample, write) = tokio::join!(warehouse.refresh(), concurrent);
    sample?;
    assert!(
        write.is_ok(),
        "a stage must register and close while the probe is blocked"
    );
    write??;
    assert!(
        idle::baseline(&db, stand, 3600, 86400).await?.is_empty(),
        "the overlapping sample must be discarded"
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn override_is_bounded_by_the_smaller_memory_limit() -> anyhow::Result<()> {
    let db = db().await?;
    let mut warehouse = Warehouse::new(&db, 1024 * MIB, 512 * MIB, 128 * MIB).await?;
    warehouse.state.cluster.admission_budget_override_bytes = Some(512 * MIB + 1);
    assert!(
        warehouse.budget().await.is_err(),
        "an override above the smaller limit must be rejected"
    );
    warehouse.state.cluster.admission_budget_override_bytes = Some(0);
    assert!(warehouse.budget().await.is_err());
    warehouse.state.cluster.admission_budget_override_bytes = Some(512 * MIB);
    assert_eq!(warehouse.budget().await?, 512 * MIB);
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn dashboard_memory_bursts_leave_queue_grants_unchanged() -> anyhow::Result<()> {
    let db = db().await?;
    let now = Utc::now();
    let limit = 4096 * MIB;
    for free in [2_000_000_000, 10 * MIB] {
        let warehouse = Warehouse::new(&db, limit, limit, 512 * MIB).await?;
        let stand = warehouse.stand();
        warehouse.refresh().await?;
        record_bronze_peak(&db, stand, "jira", now, 32 * MIB).await?;
        let req = request("jira", "bronze");
        register(&db, stand, "tenant", &req, now, 0).await?;
        let row = load(&db, stand, &req).await?;
        warehouse.used.store(limit - free, Ordering::Relaxed);
        assert_eq!(
            promote_ready(
                &db,
                stand,
                &HashSet::from([row.id]),
                warehouse.budget().await?
            )
            .await?,
            [row.id],
            "live free memory {free}"
        );
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn packing_preserves_fifo_when_the_first_warm_stage_fits_the_whole_budget()
-> anyhow::Result<()> {
    let db = db().await?;
    let stand = uuid::Uuid::now_v7().to_string();
    let now = Utc::now();
    let budget = 512 * MIB;
    let stages = [
        ("jira", 300 * MIB, "granted"),
        ("github", 112 * MIB, "granted"),
        ("mock", 150 * MIB, "queued"),
        ("outline", 50 * MIB, "queued"),
    ];
    for (connector, estimate, _) in stages {
        record_bronze_peak(&db, &stand, connector, now, estimate * 4 / 5).await?;
    }
    let mut queued = Vec::new();
    for (connector, estimate, decision) in stages {
        let req = request(connector, "bronze");
        assert_eq!(
            register(&db, &stand, "tenant", &req, now, budget)
                .await?
                .1
                .decision,
            decision
        );
        let row = load(&db, &stand, &req).await?;
        assert_eq!(row.estimated_bytes, estimate);
        if decision == "queued" {
            queued.push(row.id);
        }
    }
    let ready = queued.iter().copied().collect();
    let grants = promote_ready(&db, &stand, &ready, budget).await?;
    assert!(
        grants.is_empty(),
        "the 50 MiB stage must wait behind the 150 MiB stage: {grants:?}"
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn oversized_against_the_sync_budget_runs_alone_and_yields_while_busy() -> anyhow::Result<()>
{
    let db = db().await?;
    let now = Utc::now();
    let limit = 1024 * MIB;
    let warehouse = Warehouse::new(&db, limit, limit, 512 * MIB).await?;
    let stand = warehouse.stand();
    warehouse.refresh().await?;
    record_bronze_peak(&db, stand, "jira", now, 640 * MIB).await?;
    record_bronze_peak(&db, stand, "github", now, 40 * MIB).await?;
    let budget = warehouse.budget().await?;
    let big = request("jira", "bronze");
    assert_eq!(
        register(&db, stand, "tenant", &big, now, budget)
            .await?
            .1
            .decision,
        "granted"
    );
    let row = load(&db, stand, &big).await?;
    assert_eq!(row.estimated_bytes, budget);
    let active = request("github", "bronze");
    assert_eq!(
        register(&db, stand, "tenant", &active, now, budget)
            .await?
            .1
            .decision,
        "queued"
    );
    let active_row = load(&db, stand, &active).await?;
    assert!(!promote(&db, stand, &active_row, 2 * budget).await?);
    observe(
        &db,
        stand,
        &row,
        Observation {
            status: Some("succeeded".into()),
            finished_at: Some(now),
            ..Default::default()
        },
    )
    .await?;
    assert!(promote(&db, stand, &active_row, budget).await?);

    let next_big = request("jira", "bronze");
    let small = request("github", "bronze");
    register(&db, stand, "tenant", &next_big, now, budget).await?;
    register(&db, stand, "tenant", &small, now, budget).await?;
    let big_row = load(&db, stand, &next_big).await?;
    let small_row = load(&db, stand, &small).await?;
    assert_eq!(small_row.estimated_bytes, 50 * MIB);
    let ready = HashSet::from([big_row.id, small_row.id]);
    assert_eq!(
        promote_ready(&db, stand, &ready, budget).await?,
        [small_row.id]
    );
    assert!(load(&db, stand, &next_big).await?.granted_at.is_none());
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn active_stage_samples_do_not_replace_the_idle_baseline() -> anyhow::Result<()> {
    let db = db().await?;
    let now = Utc::now();
    let limit = 4096 * MIB;
    let warehouse = Warehouse::new(&db, limit, limit, 512 * MIB).await?;
    let stand = warehouse.stand();
    warehouse.refresh().await?;
    let idle_budget = warehouse.budget().await?;
    let req = request("jira", "bronze");
    assert_eq!(
        register(&db, stand, "tenant", &req, now, idle_budget)
            .await?
            .1
            .decision,
        "granted"
    );
    warehouse.used.store(2048 * MIB, Ordering::Relaxed);
    warehouse.refresh().await?;
    assert_eq!(
        warehouse.budget().await?,
        idle_budget,
        "active samples keep the idle budget"
    );
    let row = load(&db, stand, &req).await?;
    observe(
        &db,
        stand,
        &row,
        Observation {
            status: Some("succeeded".into()),
            finished_at: Some(now),
            ..Default::default()
        },
    )
    .await?;
    db.execute_raw(sql(
        "UPDATE ingestion_stands SET last_stage_release_at=UTC_TIMESTAMP(3)-INTERVAL 120 SECOND WHERE stand=?",
        vec![stand.into()],
    )).await?;
    db.execute_raw(sql(
        "UPDATE ingestion_idle_memory_samples SET sampled_at=UTC_TIMESTAMP(3)-INTERVAL 3601 SECOND WHERE stand=?",
        vec![stand.into()],
    )).await?;
    warehouse.refresh().await?;
    assert_eq!(warehouse.budget().await?, idle_budget - 1536 * MIB);
    Ok(())
}
