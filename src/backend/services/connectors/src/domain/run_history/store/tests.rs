use sea_orm::Database;
use sea_orm_migration::MigratorTrait;

use super::*;
use crate::domain::run_history::{WaitKind, history};
use crate::migration::Migrator;

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn bronze_retry_closes_a_superseded_capacity_wait() -> anyhow::Result<()> {
    let (latest, unsettled, retry) = save_bronze_retry(None).await?;
    assert_eq!(latest.status, "succeeded");
    let old = &latest.stages[0];
    assert_eq!(old.status, "cancelled");
    assert_eq!(old.reason.as_deref(), Some("workflow_not_found"));
    assert_eq!(
        old.finished_at.map(|time| time.timestamp_millis()),
        Some(retry.timestamp_millis())
    );
    assert_eq!(
        old.waits[0].ended_at.map(|time| time.timestamp_millis()),
        Some(retry.timestamp_millis())
    );
    assert_eq!(latest.stages[1].status, "succeeded");
    assert!(unsettled.is_empty());
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn bronze_retry_keeps_a_superseded_airbyte_job_available_for_lookup() -> anyhow::Result<()> {
    let (latest, unsettled, _) = save_bronze_retry(Some(19)).await?;
    assert_eq!(latest.stages[0].finished_at, None);
    assert_eq!(unsettled.len(), 1);
    assert_eq!(unsettled[0].job(), Some(19));
    Ok(())
}

async fn save_bronze_retry(
    old_job: Option<u64>,
) -> anyhow::Result<(history::Run, Vec<UnsettledRun>, DateTime<Utc>)> {
    let db = Database::connect(std::env::var("INTEGRATION_TESTS_MARIADB_URL")?).await?;
    Migrator::up(&db, None).await?;
    let stand = uuid::Uuid::new_v4().to_string();
    let queued = Utc::now() - chrono::Duration::hours(4);
    let retry = queued + chrono::Duration::hours(1);
    let finished = retry + chrono::Duration::minutes(1);
    let mut bronze = StageSnapshot::new("bronze", 1, queued);
    bronze.bronze_execution = Some(queued);
    bronze.job = old_job;
    bronze.status = "queued";
    bronze.capacity_wait = Some(StageWait {
        kind: WaitKind::Placement,
        started_at: queued,
        ended_at: None,
        holder: None,
    });
    let mut run = RunSnapshot {
        uid: uuid::Uuid::new_v4().to_string(),
        name: "example".into(),
        connector: "jira".into(),
        tenant: "tenant".into(),
        source: "source".into(),
        created_at: queued,
        execution: queued,
        finished_at: None,
        status: None,
        stages: vec![bronze],
    };
    save(&db, &stand, &run, queued).await?;
    let read = || history::runs(&db, &stand, "jira", Some("tenant"), Some("source"));
    assert_eq!(read().await?[0].stages[0].status, "wait_warning");

    let mut bronze = StageSnapshot::new("bronze", 2, retry);
    bronze.bronze_execution = Some(retry);
    bronze.started_at = Some(retry);
    bronze.finished_at = Some(finished);
    bronze.status = "succeeded";
    bronze.job = Some(20);
    let mut gold = StageSnapshot::new("transform-jira-silver", 1, finished);
    gold.finished_at = Some(finished);
    gold.status = "succeeded";
    run.execution = retry;
    run.finished_at = Some(finished);
    run.status = Some("succeeded");
    run.stages = vec![bronze, gold];
    save(&db, &stand, &run, finished).await?;

    let latest = read().await?.remove(0);
    Ok((latest, unsettled(&db, &stand).await?, retry))
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn history_keeps_each_attempt_once_after_replay_and_workflow_deletion() -> anyhow::Result<()>
{
    let database_url = std::env::var("INTEGRATION_TESTS_MARIADB_URL")?;
    let db = Database::connect(database_url).await?;
    Migrator::up(&db, None).await?;
    let stand = uuid::Uuid::new_v4().to_string();
    let uid = uuid::Uuid::new_v4().to_string();
    let now = Utc::now();
    let queued = now - chrono::Duration::hours(4);
    let mut run = RunSnapshot {
        uid: uid.clone(),
        name: "example-sync".into(),
        connector: "jira".into(),
        tenant: "tenant".into(),
        source: "source".into(),
        created_at: queued,
        execution: queued,
        finished_at: None,
        status: None,
        stages: vec![StageSnapshot::new("transform-jira-staging", 1, queued)],
    };
    run.stages[0].status = "queued";
    run.stages[0].wait = Some(StageWait {
        kind: WaitKind::Lock,
        started_at: queued,
        ended_at: None,
        holder: Some("example-holder".into()),
    });
    save(&db, &stand, &run, now).await?;
    save(&db, &stand, &run, now).await?;
    let result = history::runs(&db, &stand, "jira", Some("tenant"), Some("source")).await?;
    assert_eq!(result[0].stages.len(), 1);
    assert_eq!(result[0].stages[0].waits.len(), 1);
    assert_eq!(result[0].stages[0].status, "wait_warning");

    let retry = now + chrono::Duration::seconds(1);
    run.stages[0].wait = None;
    run.stages[0].started_at = Some(now);
    run.stages[0].finished_at = Some(retry);
    run.stages[0].status = "failed";
    run.stages
        .push(StageSnapshot::new("transform-jira-staging", 2, retry));
    save(&db, &stand, &run, retry).await?;
    save(&db, &stand, &run, retry).await?;
    let end = retry + chrono::Duration::seconds(1);
    close_missing(&db, &uid, end, None).await?;
    let result = history::runs(&db, &stand, "jira", Some("tenant"), Some("source")).await?;
    let stages = &result[0].stages;
    assert_eq!(result[0].status, "cancelled");
    assert_eq!(stages.len(), 2);
    assert_eq!((stages[0].attempt, stages[1].attempt), (1, 2));
    assert_eq!(stages[0].status, "failed");
    assert_eq!(stages[1].status, "cancelled");
    assert_eq!(
        stages[0].waits[0]
            .ended_at
            .map(|time| time.timestamp_millis()),
        Some(now.timestamp_millis())
    );
    Ok(())
}

#[test]
fn merge_waits_keeps_one_open_wait_until_the_reason_changes() {
    let first = DateTime::UNIX_EPOCH;
    let second = first + chrono::Duration::minutes(5);
    let third = second + chrono::Duration::minutes(5);
    let mut observed = StageSnapshot::new("bronze", 1, first);
    let mut waits = Vec::new();
    observed.wait = Some(StageWait {
        kind: WaitKind::Lock,
        started_at: first,
        ended_at: None,
        holder: None,
    });
    merge_waits(&mut waits, &observed, second);
    merge_waits(&mut waits, &observed, second);
    assert_eq!(waits.len(), 1);
    observed.wait = Some(StageWait {
        kind: WaitKind::Placement,
        started_at: second,
        ended_at: None,
        holder: None,
    });
    merge_waits(&mut waits, &observed, third);
    assert_eq!(waits.len(), 2);
    assert_eq!(waits[0].ended_at, Some(second));
    observed.wait = None;
    observed.started_at = Some(third);
    merge_waits(&mut waits, &observed, third);
    assert_eq!(waits[1].ended_at, Some(third));
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn retry_reopens_a_finished_run_and_preserves_previous_stage_attempts() -> anyhow::Result<()>
{
    let db = Database::connect(std::env::var("INTEGRATION_TESTS_MARIADB_URL")?).await?;
    Migrator::up(&db, None).await?;
    let stand = uuid::Uuid::new_v4().to_string();
    let now = Utc::now();
    let previous = now - chrono::Duration::seconds(40);
    let mut run = RunSnapshot {
        uid: uuid::Uuid::new_v4().to_string(),
        name: "example".into(),
        connector: "jira".into(),
        source: "source".into(),
        tenant: "tenant".into(),
        created_at: previous,
        execution: previous,
        status: Some("failed"),
        finished_at: Some(previous),
        stages: vec![StageSnapshot::new("transform-jira-staging", 1, previous)],
    };
    run.stages[0].status = "failed";
    run.stages[0].finished_at = Some(previous);
    save(&db, &stand, &run, previous).await?;

    run.execution = now;
    run.status = None;
    run.finished_at = None;
    run.stages = vec![StageSnapshot::new("transform-jira-staging", 1, now)];
    save(&db, &stand, &run, now).await?;
    let read = || history::runs(&db, &stand, "jira", Some("tenant"), Some("source"));
    let active = read().await?;
    assert_eq!(
        (active[0].status.as_str(), active[0].finished_at),
        ("starting", None)
    );
    assert_eq!(active[0].stages.len(), 2);
    assert_eq!(active[0].stages[1].attempt, 2);

    run.status = Some("succeeded");
    run.finished_at = Some(now);
    run.stages[0].status = "succeeded";
    run.stages[0].finished_at = Some(now);
    save(&db, &stand, &run, now).await?;
    save(&db, &stand, &run, now).await?;
    let outcome = read().await?;
    assert_eq!(outcome[0].status, "succeeded");
    assert_eq!(outcome[0].stages.len(), 2);
    assert_eq!(outcome[0].stages[0].status, "failed");
    assert_eq!(outcome[0].stages[1].status, "succeeded");
    Ok(())
}

#[test]
fn closed_capacity_wait_survives_a_missed_watch_event_and_does_not_merge_with_pod_placement() {
    let at = |seconds| DateTime::UNIX_EPOCH + chrono::Duration::seconds(seconds);
    let mut stage = StageSnapshot::new("bronze", 1, at(1));
    stage.capacity_wait = Some(StageWait {
        kind: WaitKind::Placement,
        started_at: at(2),
        ended_at: Some(at(3)),
        holder: None,
    });
    stage.wait = Some(StageWait {
        kind: WaitKind::Placement,
        started_at: at(4),
        ended_at: None,
        holder: None,
    });

    let mut waits = Vec::new();
    merge_waits(&mut waits, &stage, at(5));
    merge_waits(&mut waits, &stage, at(6));

    assert_eq!(waits.len(), 2);
    assert_eq!(waits[0].started_at, at(2));
    assert_eq!(waits[0].ended_at, Some(at(3)));
    assert_eq!(waits[1].started_at, at(4));
    assert!(waits[1].ended_at.is_none());
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn bronze_retry_keeps_a_distinct_wait_when_both_executions_use_attempt_one()
-> anyhow::Result<()> {
    let db = Database::connect(std::env::var("INTEGRATION_TESTS_MARIADB_URL")?).await?;
    Migrator::up(&db, None).await?;
    let epoch = DateTime::UNIX_EPOCH;
    let first = epoch + chrono::Duration::seconds(1);
    let stopped = epoch + chrono::Duration::seconds(2);
    let retry = epoch + chrono::Duration::seconds(3);
    let queued = epoch + chrono::Duration::seconds(4);

    for legacy in [false, true] {
        let stand = uuid::Uuid::new_v4().to_string();
        let mut bronze = StageSnapshot::new("bronze", 1, epoch);
        bronze.bronze_execution = Some(first);
        bronze.finished_at = Some(stopped);
        bronze.status = "failed";
        bronze.reason = Some("stage_failed".into());
        let mut run = RunSnapshot {
            uid: uuid::Uuid::new_v4().to_string(),
            name: "example".into(),
            connector: "jira".into(),
            tenant: "tenant".into(),
            source: "source".into(),
            created_at: epoch,
            execution: first,
            status: Some("failed"),
            finished_at: Some(stopped),
            stages: vec![bronze],
        };
        let mut pending = StageSnapshot::new("bronze", 1, epoch);
        pending.status = "queued";
        let initial = RunSnapshot {
            uid: run.uid.clone(),
            name: run.name.clone(),
            connector: run.connector.clone(),
            tenant: run.tenant.clone(),
            source: run.source.clone(),
            created_at: epoch,
            execution: epoch,
            status: None,
            finished_at: None,
            stages: vec![pending],
        };
        save(&db, &stand, &initial, epoch).await?;
        save(&db, &stand, &run, stopped).await?;
        if legacy {
            db.execute_raw(sql(
                "UPDATE ingestion_stage_attempts SET execution_key='1' WHERE sync_id=?",
                vec![run.uid.clone().into()],
            ))
            .await?;
            save(&db, &stand, &run, stopped).await?;
        }

        save(&db, &stand, &initial, retry).await?;
        let mut bronze = StageSnapshot::new("bronze", 1, epoch);
        bronze.bronze_execution = Some(retry);
        run.execution = retry;
        run.status = None;
        run.finished_at = None;
        run.stages = vec![bronze];
        save(&db, &stand, &run, retry).await?;

        let wait = StageWait {
            kind: WaitKind::Placement,
            started_at: queued,
            ended_at: None,
            holder: None,
        };
        run.stages[0].status = "queued";
        run.stages[0].wait = Some(wait.clone());
        run.stages[0].capacity_wait = Some(wait);
        save(&db, &stand, &run, queued).await?;
        save(&db, &stand, &run, queued).await?;

        let result = history::runs(&db, &stand, "jira", Some("tenant"), Some("source")).await?;
        assert_eq!(result[0].stages.len(), 2, "legacy row: {legacy}");
        let old = &result[0].stages[0];
        let new = &result[0].stages[1];
        assert_eq!((old.attempt, old.status.as_str()), (1, "failed"));
        assert!(old.waits.is_empty());
        assert_eq!((new.attempt, new.queued_at), (2, retry));
        assert_eq!(new.waits.len(), 1);
        assert_eq!(
            (
                new.waits[0].kind,
                new.waits[0].started_at,
                new.waits[0].ended_at
            ),
            (WaitKind::Placement, queued, None)
        );
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn a_bronze_row_follows_a_relaunched_airbyte_job() -> anyhow::Result<()> {
    let db = Database::connect(std::env::var("INTEGRATION_TESTS_MARIADB_URL")?).await?;
    Migrator::up(&db, None).await?;
    let stand = uuid::Uuid::new_v4().to_string();
    let epoch = DateTime::UNIX_EPOCH;
    let at = |seconds| epoch + chrono::Duration::seconds(seconds);
    let mut bronze = StageSnapshot::new("bronze", 2, at(1));
    bronze.bronze_execution = Some(at(1));
    bronze.status = "failed";
    bronze.reason = Some("source_pod_oom".into());
    bronze.job = Some(19);
    bronze.started_at = Some(at(2));
    bronze.finished_at = Some(at(3));
    bronze.records = Some(5);
    let mut run = RunSnapshot {
        uid: uuid::Uuid::new_v4().to_string(),
        name: "example".into(),
        connector: "jira".into(),
        tenant: "tenant".into(),
        source: "source".into(),
        created_at: epoch,
        execution: at(1),
        status: None,
        finished_at: None,
        stages: vec![bronze],
    };
    save(&db, &stand, &run, at(3)).await?;

    let stage = &mut run.stages[0];
    stage.status = "loading";
    stage.reason = None;
    stage.job = Some(20);
    stage.started_at = Some(at(4));
    stage.finished_at = None;
    stage.records = None;
    save(&db, &stand, &run, at(4)).await?;
    let result = history::runs(&db, &stand, "jira", Some("tenant"), Some("source")).await?;
    let row = &result[0].stages[0];
    assert_eq!(
        (
            row.status.as_str(),
            row.airbyte_job_id.as_deref(),
            row.reason.as_deref()
        ),
        ("loading", Some("20"), None)
    );
    assert_eq!((row.started_at, row.finished_at), (Some(at(4)), None));
    assert_eq!(result[0].records_reported, None);

    let stage = &mut run.stages[0];
    stage.status = "unknown";
    stage.reason = Some("stage_failed".into());
    stage.finished_at = Some(at(5));
    save(&db, &stand, &run, at(5)).await?;
    let stage = &mut run.stages[0];
    stage.status = "succeeded";
    stage.reason = None;
    stage.records = Some(7);
    save(&db, &stand, &run, at(5)).await?;
    let stage = &mut run.stages[0];
    stage.status = "loading";
    stage.finished_at = None;
    save(&db, &stand, &run, at(6)).await?;
    let result = history::runs(&db, &stand, "jira", Some("tenant"), Some("source")).await?;
    let row = &result[0].stages[0];
    assert_eq!(
        (
            row.status.as_str(),
            row.airbyte_job_id.as_deref(),
            row.reason.as_deref()
        ),
        ("succeeded", Some("20"), None)
    );
    assert_eq!(
        (row.attempt, row.started_at, row.finished_at),
        (2, Some(at(4)), Some(at(5)))
    );
    assert_eq!(result[0].records_reported, Some(7));
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn a_closed_bronze_row_without_a_job_reopens_with_its_first_job() -> anyhow::Result<()> {
    let db = Database::connect(std::env::var("INTEGRATION_TESTS_MARIADB_URL")?).await?;
    Migrator::up(&db, None).await?;
    let stand = uuid::Uuid::new_v4().to_string();
    let epoch = DateTime::UNIX_EPOCH;
    let at = |seconds| epoch + chrono::Duration::seconds(seconds);
    let mut first = StageSnapshot::new("bronze", 1, at(1));
    first.bronze_execution = Some(at(1));
    first.status = "failed";
    first.reason = Some("stage_failed".into());
    first.finished_at = Some(at(2));
    let mut run = RunSnapshot {
        uid: uuid::Uuid::new_v4().to_string(),
        name: "example".into(),
        connector: "jira".into(),
        tenant: "tenant".into(),
        source: "source".into(),
        created_at: epoch,
        execution: at(1),
        status: None,
        finished_at: None,
        stages: vec![first],
    };
    save(&db, &stand, &run, at(2)).await?;
    let stage = &mut run.stages[0];
    stage.status = "loading";
    stage.reason = None;
    stage.job = Some(21);
    stage.finished_at = None;
    save(&db, &stand, &run, at(3)).await?;
    let result = history::runs(&db, &stand, "jira", Some("tenant"), Some("source")).await?;
    let row = &result[0].stages[0];
    assert_eq!(
        (
            row.status.as_str(),
            row.airbyte_job_id.as_deref(),
            row.reason.as_deref()
        ),
        ("loading", Some("21"), None)
    );
    Ok(())
}
