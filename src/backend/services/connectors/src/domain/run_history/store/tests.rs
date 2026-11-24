use sea_orm::Database;
use sea_orm_migration::MigratorTrait;

use super::*;
use crate::domain::run_history::{WaitKind, history};
use crate::migration::Migrator;

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
        kind: WaitKind::SyncSlot,
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
