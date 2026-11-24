use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Utc};
use sea_orm::{DatabaseConnection, FromQueryResult, Value};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::{StageWait, store::sql};
use crate::domain::connector_health::{ConnectorHealth, ConnectorHealthResponse};

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub(crate) struct RunStage {
    pub waits: Vec<StageWait>,
    pub airbyte_job_id: Option<String>,
    pub stage: String,
    pub attempt: u32,
    pub status: String,
    pub queued_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub duration_ms: Option<u64>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub(crate) struct Run {
    pub sync_id: String,
    pub execution_started_at: DateTime<Utc>,
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
    waits: Option<String>,
    airbyte_job_id: Option<String>,
    sync_id: String,
    tenant: String,
    connector: String,
    source_id: String,
    run_status: Option<String>,
    run_start: DateTime<Utc>,
    execution_started_at: DateTime<Utc>,
    run_end: Option<DateTime<Utc>>,
    workflow_end: Option<DateTime<Utc>>,
    stage: String,
    attempt: u32,
    status: String,
    queued_at: DateTime<Utc>,
    started_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
    reason: Option<String>,
    records_reported: Option<u64>,
}

const RUN_COLUMNS: &str = "r.sync_id,r.tenant,r.connector,r.source_id,IF(r.ready_at IS NOT NULL,'succeeded',r.status) AS run_status,r.started_at AS run_start,r.execution AS execution_started_at,COALESCE(r.ready_at,r.finished_at) AS run_end,r.finished_at AS workflow_end,CAST(s.waits AS CHAR) AS waits,s.airbyte_job_id,COALESCE(s.stage,'') AS stage,CAST(COALESCE(s.attempt,0) AS UNSIGNED) AS attempt,COALESCE(s.status,'') AS status,COALESCE(s.queued_at,r.started_at) AS queued_at,s.started_at,s.finished_at,s.reason,s.records_reported";
fn ms(from: DateTime<Utc>, to: DateTime<Utc>) -> u64 {
    u64::try_from((to - from).num_milliseconds()).unwrap_or_default()
}
fn stage_status(r: &Record, now: DateTime<Utc>) -> String {
    if r.status == "queued"
        && waits(r).iter().any(|wait| {
            wait.ended_at.is_none() && now - wait.started_at > chrono::Duration::hours(3)
        })
    {
        return "wait_warning".into();
    }
    r.status.clone()
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
fn waits(r: &Record) -> Vec<StageWait> {
    r.waits
        .as_deref()
        .and_then(|json| serde_json::from_str(json).ok())
        .unwrap_or_default()
}

fn build(records: &[Record], now: DateTime<Utc>) -> Run {
    let first = &records[0];
    let end = first.run_end.unwrap_or(now);
    let mut wait_intervals = Vec::new();
    let mut loads = Vec::new();
    let mut transforms = Vec::new();
    let mut wait_known = true;
    let mut load_known = true;
    let mut transform_known = true;
    let mut stages = Vec::new();
    let mut reported = None;
    for r in records {
        if r.stage.is_empty() {
            continue;
        }
        let stage_waits = waits(r);
        let until = r.finished_at.or(r.workflow_end).unwrap_or(now);
        let unobserved_start = r.started_at.is_none()
            && (matches!(
                r.status.as_str(),
                "succeeded" | "failed" | "loading" | "transforming"
            ) || r.status == "cancelled" && stage_waits.is_empty());
        if unobserved_start && r.stage != "connector-checks" {
            wait_known = false;
        }
        if r.status == "checking_start" || r.status == "unknown" || unobserved_start {
            if r.stage == "bronze" {
                load_known = false;
            } else if r.stage != "connector-checks" {
                transform_known = false;
            }
        }
        if r.stage != "connector-checks" {
            for w in &stage_waits {
                wait_intervals.push((w.started_at, w.ended_at.unwrap_or(until)));
            }
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
            waits: stage_waits,
            airbyte_job_id: r.airbyte_job_id.clone(),
            stage: r.stage.clone(),
            attempt: r.attempt,
            status: stage_status(r, now),
            queued_at: r.queued_at,
            started_at: r.started_at,
            finished_at: r.finished_at,
            duration_ms: r.started_at.map(|start| ms(start, until)),
            reason: r.reason.clone(),
        });
    }
    let status = first.run_status.clone().unwrap_or_else(|| {
        if stages
            .iter()
            .any(|s| s.status == "wait_timeout" && s.finished_at.is_none())
        {
            return "wait_timeout".to_owned();
        }
        stages
            .iter()
            .rev()
            .find(|s| s.finished_at.is_none())
            .map_or("starting", |s| s.status.as_str())
            .to_owned()
    });
    Run {
        sync_id: first.sync_id.clone(),
        execution_started_at: first.execution_started_at,
        status,
        started_at: first.run_start,
        finished_at: first.run_end,
        duration_ms: Some(ms(first.run_start, end)),
        wait_ms: wait_known.then(|| total(&mut wait_intervals)),
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
              LEFT JOIN ingestion_stage_attempts s ON s.sync_id=r.sync_id
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
              LEFT JOIN ingestion_stage_attempts s ON s.sync_id=recent.sync_id
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
    fn unobserved_worker_start_keeps_stage_and_wait_durations_unknown() {
        let now = Utc::now();
        let record = Record {
            waits: None,
            airbyte_job_id: Some("12".into()),
            sync_id: "uid".into(),
            tenant: "tenant".into(),
            connector: "jira".into(),
            source_id: "source".into(),
            run_status: Some("cancelled".into()),
            run_start: now - chrono::Duration::minutes(20),
            execution_started_at: now - chrono::Duration::minutes(20),
            run_end: Some(now),
            workflow_end: Some(now),
            stage: "bronze".into(),
            attempt: 1,
            status: "succeeded".into(),
            queued_at: now - chrono::Duration::minutes(18),
            started_at: None,
            finished_at: Some(now),
            reason: None,
            records_reported: Some(120),
        };
        let run = build(std::slice::from_ref(&record), now);
        assert_eq!(run.records_reported, Some(120));
        assert_eq!(run.wait_ms, None);
        assert_eq!(run.load_ms, None);
        assert_eq!(run.stages[0].duration_ms, None);
        assert_eq!(run.transform_ms, Some(0));

        let mut cancelled = Record {
            stage: "transform-staging".into(),
            status: "cancelled".into(),
            ..record
        };
        let run = build(std::slice::from_ref(&cancelled), now);
        assert_eq!(run.wait_ms, None);
        assert_eq!(run.transform_ms, None);
        cancelled.waits = Some(
            serde_json::json!([{
                "kind": "lock", "started_at": cancelled.queued_at, "ended_at": now,
                "holder": "example"
            }])
            .to_string(),
        );
        let run = build(std::slice::from_ref(&cancelled), now);
        assert_eq!(run.wait_ms, Some(18 * 60 * 1000));
        assert_eq!(run.transform_ms, Some(0));

        cancelled.waits = None;
        cancelled.started_at = Some(now);
        let run = build(std::slice::from_ref(&cancelled), now);
        assert_eq!(run.wait_ms, Some(0));
        assert!(run.stages[0].waits.is_empty());
        let from = now - chrono::Duration::seconds(20);
        let to = now - chrono::Duration::seconds(8);
        cancelled.waits = Some(
            serde_json::json!([{
                "kind": "placement", "started_at": from, "ended_at": to, "holder": null
            }])
            .to_string(),
        );
        let run = build(&[cancelled], now);
        assert_eq!(run.wait_ms, Some(12_000));
        assert_eq!(
            run.stages[0].waits[0].kind,
            super::super::WaitKind::Placement
        );
    }

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
