use std::collections::HashMap;
use std::time::Duration;

use anyhow::{Context, ensure};
use clickhouse::Row;
use serde::Deserialize;

use super::{StageRow, store};
use crate::api::AppState;

#[derive(Row, Deserialize)]
struct Measurements {
    node: String,
    server_limit: u64,
    tracked: u64,
    container_limit: u64,
    container_used: u64,
    free_disk: u64,
    cpu_busy: f64,
    io_wait: f64,
    complete: u8,
}

fn table(cluster: &str, name: &str) -> anyhow::Result<String> {
    if cluster.is_empty() {
        return Ok(format!("system.{name}"));
    }
    ensure!(
        cluster
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-')),
        "invalid ClickHouse cluster name"
    );
    Ok(format!("clusterAllReplicas('{cluster}', system.{name})"))
}

pub(super) fn tag(stage: &StageRow) -> Option<String> {
    if stage.stage == "bronze" {
        return Some(format!("airbyte:job={}", stage.airbyte_job_id.as_ref()?));
    }
    Some(format!(
        "insight:sync={}:stage={}:attempt={}",
        stage.sync_id, stage.stage, stage.attempt
    ))
}

#[derive(Row, Deserialize)]
struct Usage {
    node: String,
    tag: String,
    used: u64,
}

const LIVE_TAG: &str = "if(startsWith(Settings['log_comment'], 'airbyte:job='), splitByString(':attempt=', Settings['log_comment'])[1], Settings['log_comment'])";
const TAG: &str = "if(startsWith(log_comment, 'airbyte:job='), splitByString(':attempt=', log_comment)[1], log_comment)";

fn headroom(node: &Measurements, managed: u64) -> anyhow::Result<u64> {
    ensure!(
        node.complete == 1 && node.container_limit > 0 && node.server_limit > 0,
        "incomplete ClickHouse resource measurements"
    );
    if node.free_disk < 5 || node.cpu_busy >= 0.9 || node.io_wait >= 0.25 {
        return Ok(0);
    }
    let available = node
        .server_limit
        .saturating_sub(node.tracked)
        .min(node.container_limit.saturating_sub(node.container_used));
    Ok(available
        .saturating_add(managed)
        .min(node.container_limit.min(node.server_limit))
        .saturating_mul(3)
        / 4)
}

pub(crate) async fn sample(state: &AppState) -> anyhow::Result<u64> {
    tokio::time::timeout(Duration::from_secs(5), sample_nodes(state)).await?
}

async fn sample_nodes(state: &AppState) -> anyhow::Result<u64> {
    let cluster = &state.cluster.clickhouse_cluster;
    let rows = store::unfinished(&state.db, &state.cluster.namespace).await?;
    let mut estimates = HashMap::new();
    for row in &rows {
        if row.granted_at.is_some()
            && row.finished_at.is_none()
            && let Some(tag) = tag(row)
        {
            estimates.insert(tag, row.estimated_bytes);
        }
    }
    let processes = table(cluster, "processes")?;
    let sql = format!(
        "SELECT hostName() AS node, {LIVE_TAG} AS tag, sum(toUInt64(greatest(memory_usage,0))) AS used FROM {processes} WHERE has(?, {LIVE_TAG}) GROUP BY node,tag SETTINGS skip_unavailable_shards=0"
    );
    let mut managed = HashMap::<String, u64>::new();
    if !estimates.is_empty() {
        for item in state
            .ch
            .query(&sql)
            .bind(estimates.keys().collect::<Vec<_>>())
            .fetch_all::<Usage>()
            .await?
        {
            if let Some(estimate) = estimates.get(&item.tag) {
                let value = managed.entry(item.node).or_default();
                *value = value.saturating_add(item.used.min(*estimate));
            }
        }
    }
    let server = table(cluster, "server_settings")?;
    let metrics = table(cluster, "metrics")?;
    let asynchronous = table(cluster, "asynchronous_metrics")?;
    let disks = table(cluster, "disks")?;
    let sql=format!("SELECT node, if(max(absolute_limit)>0,max(absolute_limit),toUInt64(floor(max(container_limit_raw)*max(ratio)))) AS server_limit, max(tracked) AS tracked,
        max(container_limit_raw) AS container_limit, max(container_used) AS container_used,
        min(free_disk) AS free_disk, max(cpu_busy) AS cpu_busy, max(io_wait) AS io_wait,
        toUInt8(sum(valid)=4) AS complete FROM (
        SELECT hostName() AS node,maxIf(toUInt64OrZero(value),name='max_server_memory_usage') AS absolute_limit,maxIf(toFloat64OrZero(value),name='max_server_memory_usage_to_ram_ratio') AS ratio,0 AS tracked,0 AS container_limit_raw,0 AS container_used,
        100 AS free_disk,0.0 AS cpu_busy,0.0 AS io_wait,toUInt8(uniqExact(name)=2) AS valid FROM {server} WHERE name IN ('max_server_memory_usage','max_server_memory_usage_to_ram_ratio') GROUP BY node
        UNION ALL SELECT hostName(),0,0,toUInt64(greatest(any(value),0)),0,0,100,0.0,0.0,toUInt8(count()=1) FROM {metrics} WHERE metric='MemoryTracking' GROUP BY hostName()
        UNION ALL SELECT hostName(),0,0,0,toUInt64(maxIf(value,metric='CGroupMemoryTotal')),toUInt64(maxIf(value,metric='CGroupMemoryUsed')),100,
        sumIf(value,metric IN ('OSUserTimeNormalized','OSSystemTimeNormalized')),maxIf(value,metric='OSIOWaitTimeNormalized'),
        toUInt8(uniqExact(metric)=7 AND maxIf(value,metric='AsynchronousMetricsUpdateInterval') BETWEEN 0.01 AND 10 AND abs(toFloat64(uptime())-maxIf(value,metric='Uptime'))<=10)
        FROM {asynchronous} WHERE metric IN ('CGroupMemoryTotal','CGroupMemoryUsed','OSUserTimeNormalized','OSSystemTimeNormalized','OSIOWaitTimeNormalized','AsynchronousMetricsUpdateInterval','Uptime') GROUP BY hostName()
        UNION ALL SELECT hostName(),0,0,0,0,0,min(intDiv(100*unreserved_space,greatest(total_space,1))),0.0,0.0,toUInt8(count()>0)
        FROM {disks} WHERE type='Local' GROUP BY hostName()) GROUP BY node SETTINGS skip_unavailable_shards=0");
    let nodes = state.ch.query(&sql).fetch_all::<Measurements>().await?;
    nodes
        .iter()
        .map(|n| headroom(n, *managed.get(&n.node).unwrap_or(&0)))
        .collect::<anyhow::Result<Vec<_>>>()?
        .into_iter()
        .min()
        .context("no ClickHouse node measurements")
}

#[derive(Row, Deserialize, Default, Debug)]
pub(super) struct QueryEvidence {
    pub running: u64,
    pub peak: u64,
    pub completed: u64,
    pub bytes: u64,
    pub records: u64,
    pub cpu_millis: u64,
    pub memory_errors: u64,
    pub global_memory_errors: u64,
}

pub(super) async fn evidence(state: &AppState, row: &StageRow) -> anyhow::Result<QueryEvidence> {
    let Some(tag) = tag(row) else {
        return Ok(QueryEvidence::default());
    };
    let cluster = &state.cluster.clickhouse_cluster;
    let processes = table(cluster, "processes")?;
    let query_log = table(cluster, "query_log")?;
    let day = row.queued_at.date_naive().to_string();
    let sql=format!("SELECT sum(running) AS running, max(peak) AS peak, sum(completed) AS completed,
        sum(bytes) AS bytes, sum(records) AS records, sum(cpu_millis) AS cpu_millis, sum(memory_errors) AS memory_errors,sum(global_errors) AS global_memory_errors FROM
        (SELECT count() AS running,sum(toUInt64(greatest(memory_usage,0))) AS peak,0 AS completed,0 AS bytes,0 AS records,0 AS cpu_millis,0 AS memory_errors,0 AS global_errors
        FROM {processes} WHERE {LIVE_TAG}=? GROUP BY hostName()
        UNION ALL SELECT 0, max(memory_usage),count(),sum(read_bytes+written_bytes),sum(written_rows),intDiv(sum(ProfileEvents['UserTimeMicroseconds'] + ProfileEvents['SystemTimeMicroseconds']),1000),countIf(exception_code=241),countIf(exception_code=241 AND positionCaseInsensitive(exception,'Memory limit (total) exceeded')>0)
        FROM {query_log} WHERE event_date>=toDate(?) AND {TAG}=? AND type IN ('QueryFinish','ExceptionWhileProcessing','ExceptionBeforeStart') GROUP BY hostName())
        SETTINGS skip_unavailable_shards=0");
    Ok(tokio::time::timeout(
        Duration::from_secs(5),
        state
            .ch
            .query(&sql)
            .bind(&tag)
            .bind(day)
            .bind(&tag)
            .fetch_one(),
    )
    .await??)
}

pub(super) async fn idle(state: &AppState) -> anyhow::Result<bool> {
    let processes = table(&state.cluster.clickhouse_cluster, "processes")?;
    let sql = format!(
        "SELECT count() FROM {processes} WHERE Settings['log_comment'] != 'insight:admission:probe' AND query_id != currentQueryID() AND initial_query_id != initialQueryID() SETTINGS skip_unavailable_shards=0"
    );
    let count: u64 = tokio::time::timeout(
        Duration::from_secs(3),
        state
            .ch
            .query(&sql)
            .with_setting("log_comment", "insight:admission:probe")
            .fetch_one(),
    )
    .await??;
    Ok(count == 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn constrains_admission_at_the_tighter_memory_limit_and_fails_closed() -> anyhow::Result<()> {
        let mut m = Measurements {
            node: "a".into(),
            server_limit: 140,
            tracked: 70,
            container_limit: 100,
            container_used: 70,
            free_disk: 15,
            cpu_busy: 0.1,
            io_wait: 0.1,
            complete: 1,
        };
        assert_eq!(headroom(&m, 10)?, 30);
        m.tracked = 135;
        assert_eq!(headroom(&m, 3)?, 6);
        m.cpu_busy = 0.95;
        assert_eq!(headroom(&m, 3)?, 0);
        m.complete = 0;
        assert!(headroom(&m, 0).is_err());
        Ok(())
    }
}
