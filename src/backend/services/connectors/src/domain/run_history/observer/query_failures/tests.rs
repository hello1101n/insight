use sea_orm::Database;
use sea_orm_migration::MigratorTrait;

use super::*;
use crate::domain::run_history::{RunSnapshot, StageSnapshot, history, store};

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_CLICKHOUSE_URL and INTEGRATION_TESTS_MARIADB_URL"]
async fn query_log_distinguishes_memory_and_query_errors_by_pod_tag() -> Result<()> {
    let app = fixture_state().await?;
    let now = Utc::now();
    let since = now - chrono::Duration::seconds(1);
    let uid = uuid::Uuid::new_v4().to_string();
    let tag_prefix = format!("insight:sync={uid}:stage=transform-staging");
    let cases = [
        (
            241,
            "Query memory limit exceeded",
            "clickhouse_memory_limit",
        ),
        (
            241,
            "(total) memory limit exceeded",
            "clickhouse_server_memory_pressure",
        ),
        (
            47,
            "Fixture query error",
            "clickhouse_query_error:47:UNKNOWN_IDENTIFIER",
        ),
        (47, "Fixture query error", "pod_oom"),
    ];
    let mut stages = Vec::new();
    for (ordinal, (code, message, expected)) in (1..).zip(cases) {
        let pod = uuid::Uuid::new_v4();
        let tag = format!("{tag_prefix}:pod={pod}");
        let sent = app
            .ch
            .query("SELECT throwIf(1,?,toInt32(?))")
            .bind(message)
            .bind(code)
            .with_setting("allow_custom_error_code_in_throwif", "1")
            .with_setting("log_comment", &tag)
            .execute()
            .await;
        assert!(sent.is_err(), "the fixture query should fail: {code}");
        let mut stage = StageSnapshot::new("transform-staging", ordinal, since);
        stage.query_pod = Some(pod);
        stage.status = "failed";
        if expected == "pod_oom" {
            stage.reason = Some("pod_oom".into());
        }
        stages.push(stage);
    }
    app.ch.query("SYSTEM FLUSH LOGS").execute().await?;
    let end = Utc::now();
    for stage in &mut stages {
        stage.finished_at = Some(end);
    }
    let run = RunSnapshot {
        uid,
        name: "example".into(),
        connector: "example".into(),
        source: "source".into(),
        tenant: "tenant".into(),
        created_at: since,
        execution: since,
        status: Some("failed"),
        finished_at: Some(end),
        stages,
    };
    store::save(&app.db, &app.cluster.namespace, &run, end).await?;
    reconcile(&app, end + chrono::Duration::seconds(9)).await?;
    let unsettled = saved_runs(&app).await?;
    assert!(
        unsettled[0].stages[0].reason.is_none(),
        "query log lookup ran before the flush settle wait"
    );

    reconcile(&app, end + chrono::Duration::seconds(10)).await?;
    let result = saved_runs(&app).await?;
    for (observed, (code, _, expected)) in result[0].stages.iter().zip(cases) {
        assert_eq!(
            observed.reason.as_deref(),
            Some(expected),
            "{code} on attempt {}",
            observed.attempt
        );
    }
    assert_eq!(result[0].stages.len(), 4);
    assert!(query(&app.ch, "", &tag_prefix, since, end).await?.is_none());
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_CLICKHOUSE_URL and INTEGRATION_TESTS_MARIADB_URL"]
async fn query_lookup_tolerates_clock_skew_at_both_stage_boundaries() -> Result<()> {
    let app = fixture_state().await?;
    let tag = uuid::Uuid::new_v4().to_string();
    let before = Utc::now();
    let sent = app
        .ch
        .query("SELECT throwIf(1,'User memory limit exceeded',toInt32(241))")
        .with_setting("allow_custom_error_code_in_throwif", "1")
        .with_setting("log_comment", &tag)
        .execute()
        .await;
    assert!(sent.is_err(), "the fixture query should fail");
    let after = Utc::now();
    app.ch.query("SYSTEM FLUSH LOGS").execute().await?;
    for (offset, expected) in [(-90, false), (-30, true), (30, true), (90, false)] {
        let skew = chrono::Duration::seconds(offset);
        let failure = query(&app.ch, "", &tag, before + skew, after + skew).await?;
        assert_eq!(failure.is_some(), expected, "clock offset: {offset}");
    }
    let failure = query(&app.ch, "", &tag, before, after).await?;
    assert_eq!(
        failure.map(|failure| failure.reason()).as_deref(),
        Some("clickhouse_user_memory_limit")
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_CLICKHOUSE_URL and INTEGRATION_TESTS_MARIADB_URL"]
async fn identity_failure_is_recovered_from_a_late_query_log_after_restart() -> Result<()> {
    let app = fixture_state().await?;
    let end = Utc::now() + chrono::Duration::seconds(60);
    let pod = uuid::Uuid::new_v4();
    let uid = save_failures(&app, end, &[("identity-seed", pod)]).await?;
    reconcile(&app, end + chrono::Duration::seconds(15)).await?;
    assert!(saved_runs(&app).await?[0].stages[0].reason.is_none());

    let tag = format!("insight:sync={uid}:stage=identity-seed:pod={pod}");
    let sent = app
        .ch
        .query("SELECT throwIf(1,'fixture',toInt32(47))")
        .with_setting("allow_custom_error_code_in_throwif", "1")
        .with_setting("log_comment", &tag)
        .execute()
        .await;
    assert!(sent.is_err(), "the fixture query should fail");
    app.ch.query("SYSTEM FLUSH LOGS").execute().await?;
    let mut restarted = fixture_state().await?;
    restarted.cluster.namespace = app.cluster.namespace.clone();
    drop(app);

    reconcile(&restarted, end + chrono::Duration::seconds(90)).await?;
    assert_eq!(
        saved_runs(&restarted).await?[0].stages[0].reason.as_deref(),
        Some("clickhouse_query_error:47:UNKNOWN_IDENTIFIER"),
        "a late query log should classify a persisted identity attempt after restart"
    );
    assert!(
        query(
            &restarted.ch,
            "",
            &tag,
            end + chrono::Duration::seconds(60),
            end + chrono::Duration::seconds(65)
        )
        .await?
        .is_none()
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_CLICKHOUSE_URL and INTEGRATION_TESTS_MARIADB_URL"]
async fn timed_out_query_lookup_does_not_block_other_stages_in_the_pass() -> Result<()> {
    let app = fixture_state().await?;
    let end = Utc::now();
    save_failures(
        &app,
        end,
        &[
            ("identity-seed", uuid::Uuid::new_v4()),
            ("transform-staging", uuid::Uuid::new_v4()),
            ("transform-legacy", uuid::Uuid::new_v4()),
        ],
    )
    .await?;
    let timeout = |entry: PendingFailure| async move {
        if entry.stage == "identity-seed" {
            tokio::time::timeout(Duration::ZERO, std::future::pending::<()>()).await?;
        }
        Ok(Some(QueryFailure {
            code: 241,
            name: "fixture".into(),
            server_memory: false,
            user_memory: false,
        }))
    };
    reconcile_with(&app, end + chrono::Duration::minutes(11), timeout).await?;
    assert!(
        saved_runs(&app).await?[0]
            .stages
            .iter()
            .all(|stage| stage.reason.is_none()),
        "expired stages must not be queried"
    );

    let pass = reconcile_with(&app, end + chrono::Duration::seconds(15), timeout).await;
    let runs = saved_runs(&app).await?;
    assert_eq!(runs[0].stages.len(), 3);
    for stage in &runs[0].stages {
        let expected = (stage.stage != "identity-seed").then_some("clickhouse_memory_limit");
        assert_eq!(
            stage.reason.as_deref(),
            expected,
            "a timeout must not prevent updating {}",
            stage.stage
        );
    }
    pass
}

async fn save_failures(
    app: &AppState,
    end: DateTime<Utc>,
    stages: &[(&'static str, uuid::Uuid)],
) -> Result<String> {
    let since = end - chrono::Duration::minutes(2);
    let run = RunSnapshot {
        uid: uuid::Uuid::new_v4().to_string(),
        name: "example".into(),
        connector: "example".into(),
        source: "source".into(),
        tenant: "tenant".into(),
        created_at: since,
        execution: since,
        status: Some("failed"),
        finished_at: Some(end),
        stages: stages
            .iter()
            .map(|&(name, pod)| {
                let mut stage = StageSnapshot::new(name, 1, since);
                stage.query_pod = Some(pod);
                stage.status = "failed";
                stage.finished_at = Some(end);
                stage
            })
            .collect(),
    };
    store::save(&app.db, &app.cluster.namespace, &run, end).await?;
    Ok(run.uid)
}

async fn saved_runs(app: &AppState) -> Result<Vec<history::Run>> {
    Ok(history::runs(
        &app.db,
        &app.cluster.namespace,
        "example",
        Some("tenant"),
        Some("source"),
    )
    .await?)
}

async fn fixture_state() -> Result<AppState> {
    let url = std::env::var("INTEGRATION_TESTS_CLICKHOUSE_URL")?;
    let config = insight_clickhouse::Config::new(url, "default").with_auth(
        std::env::var("INTEGRATION_TESTS_CLICKHOUSE_USER")?,
        std::env::var("INTEGRATION_TESTS_CLICKHOUSE_PASSWORD")?,
    );
    let db = Database::connect(std::env::var("INTEGRATION_TESTS_MARIADB_URL")?).await?;
    crate::migration::Migrator::up(&db, None).await?;
    let mut cluster = crate::infra::cluster::Cluster::disabled();
    cluster.namespace = uuid::Uuid::new_v4().to_string();
    Ok(AppState {
        cluster,
        db,
        ch: insight_clickhouse::Client::new(config),
        identity: crate::infra::identity::IdentityClient::new("http://127.0.0.1:1")?,
        schedule_slots: tokio::sync::Semaphore::new(4),
    })
}
