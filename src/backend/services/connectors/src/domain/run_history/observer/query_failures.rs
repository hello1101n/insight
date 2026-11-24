use std::{future::Future, time::Duration};

use anyhow::Result;
use chrono::{DateTime, Utc};
use futures_util::{StreamExt, stream};
use sea_orm::{ConnectionTrait, FromQueryResult};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use crate::{api::AppState, domain::run_history::store::sql};

const CLOCK_SKEW: chrono::Duration = chrono::Duration::seconds(60);
const LOG_SETTLE_TIME: chrono::Duration = chrono::Duration::seconds(10);
const LOOKUP_WINDOW: chrono::Duration = chrono::Duration::minutes(10);
const LOOKUP_PERIOD: Duration = Duration::from_secs(10);
const CONCURRENT_LOOKUPS: usize = 8;

#[derive(Debug, clickhouse::Row, Deserialize)]
struct QueryFailure {
    code: i32,
    name: String,
    server_memory: bool,
    user_memory: bool,
}

impl QueryFailure {
    fn reason(&self) -> String {
        if self.code == 241 {
            memory_limit_reason(self.server_memory, self.user_memory).to_owned()
        } else {
            format!("clickhouse_query_error:{}:{}", self.code, self.name)
        }
    }
}

pub(super) fn memory_limit_reason(server: bool, user: bool) -> &'static str {
    if user {
        "clickhouse_user_memory_limit"
    } else if server {
        "clickhouse_server_memory_pressure"
    } else {
        "clickhouse_memory_limit"
    }
}

#[derive(Debug, FromQueryResult)]
struct PendingFailure {
    id: u64,
    sync_id: String,
    stage: String,
    query_pod: String,
    started_at: DateTime<Utc>,
    finished_at: DateTime<Utc>,
}

pub(super) async fn run(state: &AppState, cancel: &CancellationToken) {
    let mut ticks = tokio::time::interval(LOOKUP_PERIOD);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            () = cancel.cancelled() => return,
            _ = ticks.tick() => {}
        }
        tokio::select! {
            () = cancel.cancelled() => return,
            result = reconcile(state, Utc::now()) => {
                if let Err(error) = result {
                    tracing::warn!(%error, "ClickHouse query failure lookup pass did not complete.");
                }
            }
        }
    }
}

async fn reconcile(state: &AppState, now: DateTime<Utc>) -> Result<()> {
    reconcile_with(state, now, |entry| async move {
        let tag = format!(
            "insight:sync={}:stage={}:pod={}",
            entry.sync_id, entry.stage, entry.query_pod
        );
        query(
            &state.ch,
            &state.cluster.query_log_replicas,
            &tag,
            entry.started_at,
            entry.finished_at,
        )
        .await
    })
    .await
}

async fn reconcile_with<F>(
    state: &AppState,
    now: DateTime<Utc>,
    lookup: impl Fn(PendingFailure) -> F,
) -> Result<()>
where
    F: Future<Output = Result<Option<QueryFailure>>> + Send,
{
    let mut cursor = 0u64;
    loop {
        let pending = PendingFailure::find_by_statement(sql(
            "SELECT s.id,r.sync_id,s.stage,s.query_pod,
              COALESCE(s.started_at,s.queued_at) AS started_at,s.finished_at
             FROM ingestion_stage_attempts s JOIN ingestion_runs r ON r.sync_id=s.sync_id
             WHERE r.stand=? AND s.status='failed' AND s.query_pod IS NOT NULL
               AND s.finished_at BETWEEN ? AND ? AND s.id>?
               AND (s.reason IS NULL OR (s.reason<>'pod_oom' AND s.reason NOT LIKE 'clickhouse_%'))
             ORDER BY s.id LIMIT 64",
            vec![
                state.cluster.namespace.clone().into(),
                (now - LOOKUP_WINDOW).into(),
                (now - LOG_SETTLE_TIME).into(),
                cursor.into(),
            ],
        ))
        .all(&state.db)
        .await?;
        let Some(last) = pending.last() else {
            return Ok(());
        };
        cursor = last.id;
        stream::iter(pending)
            .for_each_concurrent(CONCURRENT_LOOKUPS, |entry| {
                let id = entry.id;
                let result = lookup(entry);
                async move {
                    if let Err(error) = update_reason(state, id, result.await).await {
                        tracing::warn!(%error, stage_attempt_id = id, "ClickHouse query failure lookup did not complete.");
                    }
                }
            })
            .await;
    }
}

async fn update_reason(
    state: &AppState,
    id: u64,
    failure: Result<Option<QueryFailure>>,
) -> Result<()> {
    if let Some(failure) = failure? {
        state
            .db
            .execute_raw(sql(
                "UPDATE ingestion_stage_attempts SET reason=? WHERE id=? AND status='failed'
                  AND (reason IS NULL OR (reason<>'pod_oom' AND reason NOT LIKE 'clickhouse_%'))",
                vec![failure.reason().into(), id.into()],
            ))
            .await?;
    }
    Ok(())
}

async fn query(
    ch: &insight_clickhouse::Client,
    cluster: &str,
    tag: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<Option<QueryFailure>> {
    let start = start - CLOCK_SKEW;
    let end = end + CLOCK_SKEW;
    let source = if cluster.is_empty() {
        "system.query_log"
    } else {
        "clusterAllReplicas(?, system.query_log)"
    };
    let sql = format!(
        "SELECT exception_code AS code, errorCodeToName(code) AS name,
          CAST(positionCaseInsensitive(exception,'(total) memory limit')>0 OR
           positionCaseInsensitive(exception,'memory limit (total)')>0 OR
           positionCaseInsensitive(exception,'total memory limit')>0 AS Bool) AS server_memory,
          CAST(multiSearchAnyCaseInsensitive(exception, ['(for user) memory limit',
           'memory limit (for user)', 'user memory limit']) AS Bool) AS user_memory
         FROM {source}
         WHERE event_date BETWEEN toDate(toDateTime(?)) AND toDate(toDateTime(?))
           AND event_time BETWEEN toDateTime(?, 'UTC') AND toDateTime(?, 'UTC')
           AND log_comment = ?
           AND type IN ('ExceptionWhileProcessing','ExceptionBeforeStart') AND exception_code>0
           AND query_start_time_microseconds >= fromUnixTimestamp64Milli(?, 'UTC')
           AND event_time_microseconds <= fromUnixTimestamp64Milli(?, 'UTC')
         ORDER BY event_time_microseconds DESC
         LIMIT 1 SETTINGS max_execution_time=1,skip_unavailable_shards=0"
    );
    let mut query = ch.query(&sql);
    if !cluster.is_empty() {
        query = query.bind(cluster);
    }
    let query = query
        .bind(start.timestamp())
        .bind(end.timestamp())
        .bind(start.timestamp())
        .bind(end.timestamp())
        .bind(tag)
        .bind(start.timestamp_millis())
        .bind(end.timestamp_millis());
    Ok(tokio::time::timeout(Duration::from_secs(2), query.fetch_optional()).await??)
}

#[cfg(test)]
mod tests;
