use chrono::{DateTime, Utc};
use sea_orm::{
    ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbErr, FromQueryResult, Statement,
    TransactionTrait, Value,
};

use super::{RunSnapshot, StageSnapshot, StageWait};

pub(super) fn sql(query: impl Into<String>, params: Vec<Value>) -> Statement {
    Statement::from_sql_and_values(sea_orm::DbBackend::MySql, query, params)
}

#[derive(Debug, FromQueryResult)]
struct SavedAttempt {
    attempt: u32,
    waits: String,
    finished_at: Option<DateTime<Utc>>,
    airbyte_job_id: Option<String>,
}

pub(super) async fn save(
    db: &DatabaseConnection,
    stand: &str,
    run: &RunSnapshot,
    now: DateTime<Utc>,
) -> Result<(), DbErr> {
    let tx = db.begin().await?;
    let ready = run.ready_at();

    tx.execute_raw(sql(
        "INSERT INTO ingestion_runs(sync_id,stand,tenant,connector,source_id,workflow_name,started_at,execution,finished_at,status,ready_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE sync_id=VALUES(sync_id)",
        vec![run.uid.clone().into(), stand.into(), run.tenant.clone().into(), run.connector.clone().into(),
            run.source.clone().into(), run.name.clone().into(), run.created_at.into(), run.execution.into(), run.finished_at.into(),
            run.status.into(), ready.into()],
    )).await?;

    let mut ordered: Vec<_> = run.stages.iter().collect();
    ordered.sort_unstable_by_key(|stage| (stage.stage, stage.attempt));
    for stage in ordered {
        let key = stage.key();
        if stage.stage == "bronze" && !prepare_bronze_attempt(&tx, run, stage, &key).await? {
            continue;
        }
        save_stage(&tx, &run.uid, stage, &key, now).await?;
    }

    tx.execute_raw(sql(
        "UPDATE ingestion_runs SET status=?,finished_at=?,ready_at=?,execution=?
         WHERE sync_id=? AND execution<=?",
        vec![
            run.status.into(),
            run.finished_at.into(),
            ready.into(),
            run.execution.into(),
            run.uid.clone().into(),
            run.execution.into(),
        ],
    ))
    .await?;
    tx.commit().await
}

async fn prepare_bronze_attempt(
    tx: &DatabaseTransaction,
    run: &RunSnapshot,
    stage: &StageSnapshot,
    key: &str,
) -> Result<bool, DbErr> {
    let execution = stage.bronze_execution.unwrap_or(run.created_at);
    let previous_key = tx
        .query_one_raw(sql(
            "SELECT s.execution_key FROM ingestion_stage_attempts s
             JOIN ingestion_runs r ON r.sync_id=s.sync_id
             WHERE s.sync_id=? AND s.stage='bronze' AND (
                s.execution_key=? OR
                (s.execution_key='bronze:pending' AND s.finished_at IS NULL AND r.execution<=?) OR
                (s.execution_key=? AND r.execution=? AND (s.finished_at IS NULL OR s.finished_at>=r.execution))
             )
             ORDER BY (s.execution_key=?) DESC, (s.execution_key='bronze:pending') DESC LIMIT 1",
            vec![
                run.uid.clone().into(), key.into(), execution.into(),
                stage.attempt.to_string().into(), execution.into(), key.into(),
            ],
        ))
        .await?;
    if let Some(row) = previous_key {
        let previous: String = row.try_get("", "execution_key")?;
        if previous != key {
            tx.execute_raw(sql(
                "UPDATE ingestion_stage_attempts SET execution_key=?
                 WHERE sync_id=? AND stage='bronze' AND execution_key=?",
                vec![key.into(), run.uid.clone().into(), previous.into()],
            ))
            .await?;
        }
        return Ok(true);
    }

    if !stage.bronze_is_provisional {
        return Ok(true);
    }
    let previous_attempt = tx
        .query_one_raw(sql(
            "SELECT 1 FROM ingestion_stage_attempts WHERE sync_id=? AND stage='bronze' LIMIT 1",
            vec![run.uid.clone().into()],
        ))
        .await?;
    Ok(previous_attempt.is_none())
}

fn merge_waits(waits: &mut Vec<StageWait>, stage: &StageSnapshot, now: DateTime<Utc>) {
    if let Some(capacity) = &stage.capacity_wait {
        merge_capacity_wait(waits, capacity);
        if capacity.ended_at.is_none() {
            return;
        }
    }
    if let Some(last) = waits.last_mut().filter(|last| last.ended_at.is_none()) {
        if let Some(current) = &stage.wait {
            if last.kind == current.kind {
                last.holder.clone_from(&current.holder);
                return;
            }
            last.ended_at = Some(last.started_at.max(current.started_at.min(now)));
        } else {
            let cutoff = stage
                .started_at
                .filter(|at| *at >= last.started_at)
                .or(stage.finished_at)
                .unwrap_or(now);
            last.ended_at = Some(last.started_at.max(cutoff));
        }
    }
    if let Some(current) = &stage.wait {
        let last_end = waits.last().and_then(|v| v.ended_at);
        let mut current = current.clone();
        current.started_at = current
            .started_at
            .max(last_end.unwrap_or(current.started_at));
        waits.push(current);
    }
}

fn merge_capacity_wait(waits: &mut Vec<StageWait>, capacity: &StageWait) {
    if let Some(existing) = waits
        .iter_mut()
        .find(|wait| wait.kind == capacity.kind && wait.started_at == capacity.started_at)
    {
        existing.ended_at = capacity.ended_at.or(existing.ended_at);
        return;
    }
    let index = waits.partition_point(|wait| wait.started_at <= capacity.started_at);
    if let Some(prior) = index.checked_sub(1).and_then(|i| waits.get_mut(i))
        && prior.ended_at.is_none_or(|end| end > capacity.started_at)
    {
        prior.ended_at = Some(capacity.started_at);
    }
    waits.insert(index, capacity.clone());
}

async fn save_stage(
    tx: &DatabaseTransaction,
    uid: &str,
    stage: &StageSnapshot,
    key: &str,
    now: DateTime<Utc>,
) -> Result<(), DbErr> {
    let saved = SavedAttempt::find_by_statement(sql(
        "SELECT attempt,CAST(waits AS CHAR) AS waits,finished_at,airbyte_job_id FROM ingestion_stage_attempts
         WHERE sync_id=? AND stage=? AND execution_key=?",
        vec![uid.into(), stage.stage.into(), key.into()],
    ))
    .one(tx)
    .await?;
    if stage.finished_at.is_none()
        && saved.as_ref().is_some_and(|saved| {
            saved.finished_at.is_some() && (stage.job.is_none() || saved.airbyte_job_id.is_some())
        })
    {
        return Ok(());
    }
    let attempt = match saved.as_ref() {
        Some(saved) => saved.attempt,
        None if stage.stage == "bronze" => {
            next_attempt(tx, uid, stage.stage).await?.max(stage.attempt)
        }
        None => next_attempt(tx, uid, stage.stage).await?,
    };
    let queued_at = if stage.stage == "bronze" && attempt > 1 {
        stage.queued_at.max(stage.bronze_execution.unwrap_or(now))
    } else {
        stage.queued_at
    };
    let mut waits = match saved {
        Some(saved) => {
            serde_json::from_str(&saved.waits).map_err(|error| DbErr::Json(error.to_string()))?
        }
        None => Vec::new(),
    };
    merge_waits(&mut waits, stage, now);
    let waits = serde_json::to_string(&waits).map_err(|error| DbErr::Json(error.to_string()))?;
    let resources = stage
        .actual_resources
        .as_ref()
        .or(stage.resources.as_ref())
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| DbErr::Json(error.to_string()))?;
    tx.execute_raw(sql(
        "INSERT INTO ingestion_stage_attempts(sync_id,stage,attempt,status,queued_at,started_at,finished_at,waits,reason,connection_id,airbyte_job_id,records_reported,execution_key,query_pod,resources)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE
         status=VALUES(status), queued_at=LEAST(queued_at,VALUES(queued_at)),
         started_at=COALESCE(started_at,VALUES(started_at)), finished_at=VALUES(finished_at),
         waits=VALUES(waits),
         reason=CASE WHEN VALUES(reason) IN ('pod_oom','source_pod_oom') THEN VALUES(reason)
            WHEN reason IN ('pod_oom','source_pod_oom') THEN reason
            WHEN reason LIKE 'clickhouse_%' AND COALESCE(VALUES(reason),'') NOT LIKE 'clickhouse_%'
            THEN reason ELSE COALESCE(VALUES(reason),reason) END,
         connection_id=COALESCE(connection_id,VALUES(connection_id)),
         airbyte_job_id=COALESCE(airbyte_job_id,VALUES(airbyte_job_id)), records_reported=COALESCE(VALUES(records_reported),records_reported),query_pod=COALESCE(query_pod,VALUES(query_pod)),
         resources=IF(?,VALUES(resources),COALESCE(resources,VALUES(resources)))",
        vec![uid.into(), stage.stage.into(), attempt.into(), stage.status.into(), queued_at.into(),
            stage.started_at.into(), stage.finished_at.into(), waits.into(), stage.reason.clone().into(),
            stage.connection.clone().into(), stage.job.map(|id| id.to_string()).into(), stage.records.into(), key.into(), stage.query_pod.map(|id| id.to_string()).into(), resources.into(), stage.actual_resources.is_some().into()],
    )).await?;
    Ok(())
}

async fn next_attempt(tx: &DatabaseTransaction, uid: &str, stage: &str) -> Result<u32, DbErr> {
    let row = tx
        .query_one_raw(sql(
            "SELECT CAST(COALESCE(MAX(attempt),0)+1 AS UNSIGNED) AS ordinal
         FROM ingestion_stage_attempts WHERE sync_id=? AND stage=?",
            vec![uid.into(), stage.into()],
        ))
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("stage ordinal".into()))?;
    row.try_get("", "ordinal")
}

#[derive(Debug, FromQueryResult)]
pub(super) struct UnsettledRun {
    pub(super) sync_id: String,
    pub(super) connection_id: Option<String>,
    pub(super) queued_at: Option<DateTime<Utc>>,
    pub(super) attempt: Option<u32>,
    airbyte_job_id: Option<String>,
}

impl UnsettledRun {
    pub(super) fn job(&self) -> Option<u64> {
        self.airbyte_job_id.as_deref()?.parse().ok()
    }
}

pub(super) async fn unsettled(
    db: &DatabaseConnection,
    stand: &str,
) -> Result<Vec<UnsettledRun>, DbErr> {
    UnsettledRun::find_by_statement(sql(
        "SELECT r.sync_id,s.connection_id,s.queued_at,s.airbyte_job_id,s.attempt
         FROM ingestion_runs r
         LEFT JOIN ingestion_stage_attempts s ON s.sync_id=r.sync_id AND s.stage='bronze'
           AND s.finished_at IS NULL AND s.airbyte_job_id IS NOT NULL
         WHERE r.stand=? AND (r.finished_at IS NULL OR s.id IS NOT NULL)",
        vec![stand.into()],
    ))
    .all(db)
    .await
}

#[derive(Debug, FromQueryResult)]
struct OpenAttempt {
    id: u64,
    attempt: u32,
    airbyte_job_id: Option<String>,
    stage: String,
    status: String,
    execution_key: String,
    waits: String,
}

pub(super) async fn close_missing(
    db: &DatabaseConnection,
    uid: &str,
    now: DateTime<Utc>,
    load: Option<StageSnapshot>,
) -> Result<(), DbErr> {
    let tx = db.begin().await?;
    tx.execute_raw(sql(
        "UPDATE ingestion_runs SET finished_at=?,status='cancelled' WHERE sync_id=? AND finished_at IS NULL",
        vec![now.into(), uid.into()],
    )).await?;

    let open = OpenAttempt::find_by_statement(sql(
        "SELECT id,stage,status,attempt,airbyte_job_id,execution_key,CAST(waits AS CHAR) AS waits FROM ingestion_stage_attempts
         WHERE sync_id=? AND finished_at IS NULL",
        vec![uid.into()],
    ))
    .all(&tx)
    .await?;
    for attempt in open {
        if attempt.stage == "bronze" && attempt.airbyte_job_id.is_some() {
            if let Some(load) = load.as_ref().filter(|load| load.attempt == attempt.attempt) {
                save_stage(&tx, uid, load, &attempt.execution_key, now).await?;
            }
            continue;
        }

        let mut waits: Vec<StageWait> =
            serde_json::from_str(&attempt.waits).map_err(|error| DbErr::Json(error.to_string()))?;
        if let Some(wait) = waits.last_mut().filter(|wait| wait.ended_at.is_none()) {
            wait.ended_at = Some(now.max(wait.started_at));
        }
        let waits =
            serde_json::to_string(&waits).map_err(|error| DbErr::Json(error.to_string()))?;
        let (status, reason) = match attempt.status.as_str() {
            "checking_start" => ("unknown", "workflow_not_found"),
            "wait_timeout" => ("wait_timeout", "wait_timeout"),
            _ => ("cancelled", "workflow_not_found"),
        };
        tx.execute_raw(sql(
            "UPDATE ingestion_stage_attempts SET status=?,reason=?,finished_at=?,waits=? WHERE id=?",
            vec![status.into(), reason.into(), now.into(), waits.into(), attempt.id.into()],
        )).await?;
    }
    tx.commit().await
}

#[cfg(test)]
mod tests;
