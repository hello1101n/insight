use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Utc};
use sea_orm::{DatabaseConnection, FromQueryResult, Value};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::store::sql;
use crate::domain::connector_health::{ConnectorHealth, ConnectorHealthResponse};

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub(crate) struct RunStage {
    pub airbyte_job_id: Option<String>,
    pub stage: String,
    pub attempt: u32,
    pub status: String,
    pub queued_at: DateTime<Utc>,
    pub granted_at: Option<DateTime<Utc>>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub duration_ms: Option<u64>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub(crate) struct Run {
    pub sync_id: String,
    pub status: String,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub duration_ms: Option<u64>,
    pub wait_ms: Option<u64>,
    pub load_ms: Option<u64>,
    pub transform_ms: Option<u64>,
    pub records_reported: Option<u64>,
    pub stages: Vec<RunStage>,
}

#[derive(Clone, FromQueryResult)]
struct Record {
    airbyte_job_id: Option<String>,
    sync_id: String,
    tenant: String,
    connector: String,
    source_id: String,
    run_status: Option<String>,
    run_start: DateTime<Utc>,
    run_end: Option<DateTime<Utc>>,
    workflow_end: Option<DateTime<Utc>>,
    stage: String,
    attempt: u32,
    status: String,
    queued_at: DateTime<Utc>,
    granted_at: Option<DateTime<Utc>>,
    started_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
    reason: Option<String>,
    records_reported: Option<u64>,
}

const RUN_COLUMNS: &str = "r.sync_id,r.tenant,r.connector,r.source_id,IF(r.ready_at IS NOT NULL,'succeeded',r.status) AS run_status,r.started_at AS run_start,COALESCE(r.ready_at,r.finished_at) AS run_end,r.finished_at AS workflow_end,s.airbyte_job_id,s.stage,s.attempt,s.status,s.queued_at,s.granted_at,s.started_at,s.finished_at,s.reason,s.records_reported";
fn ms(from: DateTime<Utc>, to: DateTime<Utc>) -> u64 {
    u64::try_from((to - from).num_milliseconds()).unwrap_or_default()
}
fn stage_status(r: &Record, now: DateTime<Utc>) -> String {
    match r.status.as_str() {
        "queued" | "starting" | "waiting_pod" if now - r.queued_at > chrono::Duration::hours(3) => {
            "wait_warning"
        }
        "queued" => "waiting_clickhouse",
        "starting" => "queued",
        other => other,
    }
    .into()
}
fn total(intervals: &mut [(DateTime<Utc>, DateTime<Utc>)]) -> u64 {
    intervals.sort_unstable();
    let mut sum: u64 = 0;
    let mut covered = None;
    for &(from, to) in intervals.iter() {
        let start = from.max(covered.unwrap_or(from));
        sum = sum.saturating_add(ms(start, to));
        covered = Some(to.max(start));
    }
    sum
}
fn build(records: &[Record], now: DateTime<Utc>) -> Run {
    let first = &records[0];
    let end = first.run_end.unwrap_or(now);
    let mut waits = Vec::new();
    let mut loads = Vec::new();
    let mut transforms = Vec::new();
    let mut load_known = true;
    let mut transform_known = true;
    let mut stages = Vec::new();
    let mut reported = None;
    for r in records {
        let until = r.finished_at.or(r.workflow_end).unwrap_or(now);
        let before = r.started_at.unwrap_or(until);
        if r.status == "checking_start" || r.status == "unknown" {
            if r.stage == "bronze" {
                load_known = false;
            } else {
                transform_known = false;
            }
        }
        let wait_until = if matches!(r.status.as_str(), "unknown" | "checking_start") {
            r.granted_at.unwrap_or(before)
        } else {
            before
        };
        if r.stage != "connector-checks" {
            waits.push((r.queued_at, wait_until));
        }
        if let Some(start) = r.started_at {
            if r.stage == "bronze" {
                loads.push((start, until));
            } else if r.stage != "connector-checks" {
                transforms.push((start, until));
            }
        }
        if r.stage == "bronze" && r.records_reported.is_some() {
            reported = r.records_reported;
        }
        stages.push(RunStage {
            airbyte_job_id: r.airbyte_job_id.clone(),
            stage: r.stage.clone(),
            attempt: r.attempt,
            status: stage_status(r, now),
            queued_at: r.queued_at,
            granted_at: r.granted_at,
            started_at: r.started_at,
            finished_at: r.finished_at,
            duration_ms: r.started_at.map(|start| ms(start, until)),
            reason: r.reason.clone(),
        });
    }
    let status = first.run_status.clone().unwrap_or_else(|| {
        if stages.iter().any(|s| s.status == "wait_timeout") {
            return "wait_timeout".to_owned();
        }
        stages
            .iter()
            .rev()
            .find(|s| s.finished_at.is_none())
            .map_or("queued", |s| s.status.as_str())
            .to_owned()
    });
    Run {
        sync_id: first.sync_id.clone(),
        status,
        started_at: first.run_start,
        finished_at: first.run_end,
        duration_ms: Some(ms(first.run_start, end)),
        wait_ms: Some(total(&mut waits)),
        load_ms: load_known.then(|| total(&mut loads)),
        transform_ms: transform_known.then(|| total(&mut transforms)),
        records_reported: reported,
        stages,
    }
}

type Instance = (String, String, String);
fn grouped(rows: Vec<Record>, now: DateTime<Utc>) -> BTreeMap<Instance, Vec<Run>> {
    let mut jobs: HashMap<String, Vec<Record>> = HashMap::new();
    for row in rows {
        jobs.entry(row.sync_id.clone()).or_default().push(row);
    }
    let mut instances: BTreeMap<Instance, Vec<Run>> = BTreeMap::new();
    for rs in jobs.into_values() {
        let r = &rs[0];
        instances
            .entry((r.tenant.clone(), r.connector.clone(), r.source_id.clone()))
            .or_default()
            .push(build(&rs, now));
    }
    for runs in instances.values_mut() {
        runs.sort_by(|a, b| {
            b.started_at
                .cmp(&a.started_at)
                .then_with(|| b.sync_id.cmp(&a.sync_id))
        });
    }
    instances
}

pub(crate) async fn enrich(
    db: &DatabaseConnection,
    stand: &str,
    output: &mut ConnectorHealthResponse,
) -> Result<(), sea_orm::DbErr> {
    let query = format!(
        "WITH ranked AS (SELECT sync_id,ROW_NUMBER() OVER(PARTITION BY tenant,connector,source_id
              ORDER BY started_at DESC,sync_id DESC) AS latest,ROW_NUMBER() OVER(PARTITION BY tenant,connector,source_id,(ready_at IS NOT NULL OR status='succeeded')
              ORDER BY started_at DESC,sync_id DESC) AS by_status,(ready_at IS NOT NULL OR status='succeeded') AS ready
              FROM ingestion_runs
              WHERE stand=?) SELECT {RUN_COLUMNS}
              FROM ranked k
              JOIN ingestion_runs r ON r.sync_id=k.sync_id
              JOIN ingestion_stage_attempts s ON s.sync_id=r.sync_id
              WHERE k.latest=1 OR (k.ready=1
              AND k.by_status=1)
              ORDER BY s.queued_at,s.id"
    );
    let records = Record::find_by_statement(sql(query, vec![stand.into()]))
        .all(db)
        .await?;
    for ((tenant, name, source), mut runs) in grouped(records, Utc::now()) {
        let idx = output.connectors.iter().position(|r| {
            r.connector == name
                && r.tenant_id.as_deref() == Some(&tenant)
                && r.source_id.as_deref() == Some(&source)
        });
        let idx = idx.unwrap_or_else(|| {
            output.connectors.push(ConnectorHealth {
                connector: name,
                tenant_id: Some(tenant),
                source_id: Some(source),
                configured: false,
                schedule: None,
                schedule_request: None,
                last_sync: None,
                latest_run: None,
                last_successful_run: None,
            });
            output.connectors.len() - 1
        });
        let row = &mut output.connectors[idx];
        row.last_successful_run = runs.iter().find(|r| r.status == "succeeded").cloned();
        row.latest_run = runs.drain(..).next();
        output.history_available = true;
    }
    Ok(())
}
pub(crate) async fn runs(
    db: &DatabaseConnection,
    stand: &str,
    connector: &str,
    tenant: Option<&str>,
    source: Option<&str>,
) -> Result<Vec<Run>, sea_orm::DbErr> {
    let (Some(tenant), Some(source)) = (tenant, source) else {
        return Ok(Vec::new());
    };
    let params: Vec<Value> = vec![stand.into(), connector.into(), tenant.into(), source.into()];
    let query = format!(
        "SELECT {RUN_COLUMNS}
              FROM (SELECT sync_id
              FROM ingestion_runs
              WHERE stand=?
              AND connector=?
              AND tenant=?
              AND source_id=?
              ORDER BY started_at DESC,sync_id DESC
              LIMIT 50) recent
              JOIN ingestion_runs r ON r.sync_id=recent.sync_id
              JOIN ingestion_stage_attempts s ON s.sync_id=recent.sync_id
              ORDER BY s.queued_at,s.id"
    );
    let rs = Record::find_by_statement(sql(query, params))
        .all(db)
        .await?;
    let mut results: Vec<_> = grouped(rs, Utc::now()).into_values().flatten().collect();
    results.sort_by(|a, b| {
        b.started_at
            .cmp(&a.started_at)
            .then_with(|| b.sync_id.cmp(&a.sync_id))
    });
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overlap_counts_elapsed_time_once() {
        let at = DateTime::<Utc>::UNIX_EPOCH;
        let after = |millis| at + chrono::Duration::milliseconds(millis);
        assert_eq!(
            total(&mut [
                (after(20), after(40)),
                (at, after(30)),
                (after(60), after(65))
            ]),
            45
        );
    }
}
