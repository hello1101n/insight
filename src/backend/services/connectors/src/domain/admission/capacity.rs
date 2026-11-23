use std::time::Duration;

use anyhow::ensure;
use clickhouse::Row;
use serde::Deserialize;

use super::{StageRow, store::idle};
use crate::api::AppState;

#[derive(Row, Deserialize)]
struct Measurements {
    node: String,
    server_limit: u64,
    container_limit: u64,
    container_used: u64,
    tracked: u64,
    free_disk: u64,
    cpu_busy: f64,
    io_wait: f64,
    complete: u8,
}

impl Measurements {
    fn memory_limit(&self) -> u64 {
        self.server_limit.min(self.container_limit)
    }
}

fn on_all_nodes(cluster: &str, source: &str) -> anyhow::Result<String> {
    if cluster.is_empty() {
        return Ok(source.to_owned());
    }
    ensure!(
        cluster
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-')),
        "invalid ClickHouse cluster name"
    );
    Ok(format!("clusterAllReplicas('{cluster}', {source})"))
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

const LIVE_TAG: &str = "if(startsWith(Settings['log_comment'], 'airbyte:job='), splitByString(':attempt=', Settings['log_comment'])[1], Settings['log_comment'])";
const TAG: &str = "if(startsWith(log_comment, 'airbyte:job='), splitByString(':attempt=', log_comment)[1], log_comment)";

fn budget(nodes: &[Measurements], baselines: &idle::IdleMemory, reserve_percent: u8) -> u64 {
    let percent = u64::from(reserve_percent);
    nodes
        .iter()
        .map(|node| {
            let limit = node.memory_limit();
            let reserve = limit / 100 * percent + limit % 100 * percent / 100;
            let baseline = baselines
                .get(&node.node)
                .copied()
                .unwrap_or_else(|| node.container_used.max(node.tracked));
            limit.saturating_sub(baseline).saturating_sub(reserve)
        })
        .min()
        .unwrap_or_default()
}

fn healthy(nodes: &[Measurements]) -> bool {
    !nodes
        .iter()
        .any(|node| node.free_disk < 5 || node.cpu_busy >= 0.9 || node.io_wait >= 0.25)
}

async fn measurements(state: &AppState) -> anyhow::Result<Vec<Measurements>> {
    // A remote view evaluates uptime() on each replica, including replicas restarted separately.
    let source = on_all_nodes(
        &state.cluster.clickhouse_cluster,
        &format!("view({NODE_MEASUREMENTS})"),
    )?;
    let sql = format!("SELECT * FROM {source} SETTINGS skip_unavailable_shards=0");
    let nodes = state.ch.query(&sql).fetch_all::<Measurements>().await?;
    validate_measurements(&nodes)?;
    Ok(nodes)
}

fn validate_measurements(nodes: &[Measurements]) -> anyhow::Result<()> {
    ensure!(!nodes.is_empty(), "no ClickHouse node measurements");
    ensure!(
        nodes
            .iter()
            .all(|node| node.complete == 1 && node.container_limit > 0 && node.server_limit > 0),
        "incomplete ClickHouse resource measurements"
    );
    Ok(())
}

pub(crate) async fn sample(state: &AppState) -> anyhow::Result<u64> {
    tokio::time::timeout(Duration::from_secs(5), sample_budget(state)).await?
}

fn validate_override(bytes: u64, nodes: &[Measurements]) -> anyhow::Result<u64> {
    let limit = nodes
        .iter()
        .map(Measurements::memory_limit)
        .min()
        .unwrap_or_default();
    ensure!(
        bytes > 0 && bytes <= limit,
        "admission_budget_override_bytes must be positive and at most the smallest ClickHouse memory limit ({limit} bytes)"
    );
    Ok(bytes)
}

async fn sample_budget(state: &AppState) -> anyhow::Result<u64> {
    let nodes = measurements(state).await?;
    if !healthy(&nodes) {
        return Ok(0);
    }
    if let Some(bytes) = state.cluster.admission_budget_override_bytes {
        return validate_override(bytes, &nodes);
    }

    let cluster = &state.cluster;
    let baselines = idle::baseline(
        &state.db,
        &cluster.namespace,
        cluster.admission_baseline_window_secs,
        cluster.admission_baseline_max_age_secs,
    )
    .await?;
    Ok(budget(
        &nodes,
        &baselines,
        cluster.admission_dashboard_reserve_percent,
    ))
}

pub(super) async fn refresh_idle_budget(state: &AppState) -> anyhow::Result<()> {
    tokio::time::timeout(Duration::from_secs(5), refresh_idle(state)).await?
}

async fn refresh_idle(state: &AppState) -> anyhow::Result<()> {
    let cluster = &state.cluster;
    if cluster.admission_budget_override_bytes.is_some() {
        return Ok(());
    }
    let stand = &cluster.namespace;
    let settle = cluster.admission_idle_settle_secs;
    let Some(sampled_at) = idle::settled_at(&state.db, stand, settle, None).await? else {
        return Ok(());
    };

    let nodes = measurements(state).await?;
    if !healthy(&nodes) {
        return Ok(());
    }

    let memory = nodes
        .into_iter()
        .map(|node| (node.node, node.container_used))
        .collect();
    idle::save(
        &state.db,
        stand,
        sampled_at,
        settle,
        cluster.admission_baseline_window_secs,
        &memory,
    )
    .await
}

const NODE_MEASUREMENTS: &str = "SELECT node, if(max(absolute_limit)>0,max(absolute_limit),toUInt64(floor(max(container_limit_raw)*max(ratio)))) AS server_limit,
        max(container_limit_raw) AS container_limit, max(container_used) AS container_used, max(tracked) AS tracked,
        min(free_disk) AS free_disk, max(cpu_busy) AS cpu_busy, max(io_wait) AS io_wait,
        toUInt8(sum(valid)=4) AS complete FROM (
        SELECT hostName() AS node,maxIf(toUInt64OrZero(value),name='max_server_memory_usage') AS absolute_limit,maxIf(toFloat64OrZero(value),name='max_server_memory_usage_to_ram_ratio') AS ratio,0 AS container_limit_raw,0 AS container_used,0 AS tracked,
        100 AS free_disk,0.0 AS cpu_busy,0.0 AS io_wait,toUInt8(uniqExact(name)=2) AS valid FROM system.server_settings WHERE name IN ('max_server_memory_usage','max_server_memory_usage_to_ram_ratio') GROUP BY node
        UNION ALL SELECT hostName(),0,0,0,0,toUInt64(greatest(any(value),0)),100,0.0,0.0,toUInt8(count()=1) FROM system.metrics WHERE metric='MemoryTracking' GROUP BY hostName()
        UNION ALL SELECT hostName(),0,0,toUInt64(maxIf(value,metric='CGroupMemoryTotal')),toUInt64(maxIf(value,metric='CGroupMemoryUsed')),0,100,
        sumIf(value,metric IN ('OSUserTimeNormalized','OSSystemTimeNormalized')),maxIf(value,metric='OSIOWaitTimeNormalized'),
        toUInt8(uniqExact(metric)=7 AND maxIf(value,metric='AsynchronousMetricsUpdateInterval') BETWEEN 0.01 AND 10 AND abs(toFloat64(uptime())-maxIf(value,metric='Uptime'))<=10)
        FROM system.asynchronous_metrics WHERE metric IN ('CGroupMemoryTotal','CGroupMemoryUsed','OSUserTimeNormalized','OSSystemTimeNormalized','OSIOWaitTimeNormalized','AsynchronousMetricsUpdateInterval','Uptime') GROUP BY hostName()
        UNION ALL SELECT hostName(),0,0,0,0,0,min(intDiv(100*unreserved_space,greatest(total_space,1))),0.0,0.0,toUInt8(count()>0)
        FROM system.disks WHERE type='Local' GROUP BY hostName()) GROUP BY node";

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

fn evidence_query(processes: &str, query_log: &str) -> String {
    // A logged peak is an upper bound over the query lifetime.
    format!(
        "SELECT sum(running) AS running, max(peak) AS peak, sum(completed) AS completed,
                sum(bytes) AS bytes, sum(records) AS records, sum(cpu_millis) AS cpu_millis,
                sum(memory_errors) AS memory_errors, sum(global_errors) AS global_memory_errors
         FROM (
            SELECT count() AS running, sum(toUInt64(greatest(memory_usage,0))) AS peak,
                   0 AS completed, 0 AS bytes, 0 AS records, 0 AS cpu_millis, 0 AS memory_errors, 0 AS global_errors
            FROM {processes} WHERE {LIVE_TAG}=? GROUP BY hostName()
            UNION ALL
            SELECT 0, toUInt64(max(active_peaks)), countIf(edge.2=1), sumIf(io_bytes,edge.2=1),
                   sumIf(written_rows,edge.2=1), intDiv(sumIf(cpu_us,edge.2=1),1000),
                   countIf(edge.2=1 AND exception_code=241),
                   countIf(edge.2=1 AND exception_code=241 AND (
                       positionCaseInsensitive(exception,'(total) memory limit exceeded')>0 OR
                       positionCaseInsensitive(exception,'memory limit (total) exceeded')>0))
            FROM (
                SELECT *, sum(toInt128(memory_usage)*edge.2) OVER (
                    PARTITION BY node ORDER BY edge.1,edge.2 ROWS UNBOUNDED PRECEDING
                ) AS active_peaks
                FROM (
                    SELECT hostName() AS node, memory_usage, read_bytes+written_bytes AS io_bytes, written_rows,
                           ProfileEvents['UserTimeMicroseconds']+ProfileEvents['SystemTimeMicroseconds'] AS cpu_us,
                           exception_code, exception,
                           arrayJoin([(toUnixTimestamp64Micro(query_start_time_microseconds),toInt8(1)),
                                      (greatest(toUnixTimestamp64Micro(event_time_microseconds),
                                                toUnixTimestamp64Micro(query_start_time_microseconds)+1),toInt8(-1))]) AS edge
                    FROM {query_log} WHERE event_date>=toDate(?) AND {TAG}=?
                        AND type IN ('QueryFinish','ExceptionWhileProcessing','ExceptionBeforeStart')
                )
            ) GROUP BY node
         ) SETTINGS skip_unavailable_shards=0"
    )
}

pub(super) async fn evidence(state: &AppState, row: &StageRow) -> anyhow::Result<QueryEvidence> {
    let Some(tag) = tag(row) else {
        return Ok(QueryEvidence::default());
    };
    let cluster = &state.cluster.clickhouse_cluster;
    let processes = on_all_nodes(cluster, "system.processes")?;
    let query_log = on_all_nodes(cluster, "system.query_log")?;
    let day = row.queued_at.date_naive().to_string();
    let sql = evidence_query(&processes, &query_log);
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

pub(crate) async fn query_failures(
    state: &AppState,
    tags: &[String],
    first_day: chrono::NaiveDate,
    last_day: chrono::NaiveDate,
) -> anyhow::Result<Vec<(String, String)>> {
    let log = on_all_nodes(&state.cluster.clickhouse_cluster, "system.query_log")?;
    let sql = format!("SELECT log_comment, concat('clickhouse_query_error:',toString(code),':',errorCodeToName(code))
                       FROM (SELECT log_comment,argMax(exception_code,event_time_microseconds) AS code
                         FROM {log} WHERE event_date BETWEEN toDate(?) AND toDate(?)
                         AND log_comment IN ? AND type IN ('ExceptionWhileProcessing','ExceptionBeforeStart')
                         AND exception_code>0 GROUP BY log_comment)
                       SETTINGS max_execution_time=1,skip_unavailable_shards=0");
    Ok(tokio::time::timeout(
        Duration::from_secs(2),
        state
            .ch
            .query(&sql)
            .bind(first_day.to_string())
            .bind(last_day.to_string())
            .bind(tags)
            .fetch_all::<(String, String)>(),
    )
    .await??)
}

pub(super) async fn idle_before(
    state: &AppState,
    end: chrono::DateTime<chrono::Utc>,
) -> anyhow::Result<bool> {
    let processes = on_all_nodes(&state.cluster.clickhouse_cluster, "system.processes")?;
    let sql = format!(
        "SELECT count() FROM {processes} WHERE Settings['log_comment'] != 'insight:admission:probe' AND query_id != currentQueryID() AND initial_query_id != initialQueryID() AND (toUnixTimestamp64Milli(now64(3))-toInt64(elapsed*1000)) <= ? SETTINGS skip_unavailable_shards=0"
    );
    let count: u64 = tokio::time::timeout(
        Duration::from_secs(3),
        state
            .ch
            .query(&sql)
            .bind(end.timestamp_millis().saturating_add(1000))
            .with_setting("log_comment", "insight:admission:probe")
            .fetch_one(),
    )
    .await??;
    Ok(count == 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn synthetic_log(rows: &str) -> anyhow::Result<QueryEvidence> {
        let url = std::env::var("INTEGRATION_TESTS_CLICKHOUSE_URL")?;
        let mut config = insight_clickhouse::Config::new(url, "default");
        if let Ok(user) = std::env::var("INTEGRATION_TESTS_CLICKHOUSE_USER") {
            config = config.with_auth(
                user,
                std::env::var("INTEGRATION_TESTS_CLICKHOUSE_PASSWORD")?,
            );
        }
        let logs = format!(
            "view(SELECT fromUnixTimestamp64Micro(start) AS query_start_time_microseconds,
                fromUnixTimestamp64Micro(finish) AS event_time_microseconds, toDate('1970-01-01') AS event_date,
                'fixture' AS log_comment, 'QueryFinish' AS type, memory_usage, exception_code, exception,
                toUInt64(2) AS read_bytes, toUInt64(1) AS written_bytes, toUInt64(1) AS written_rows,
                map('UserTimeMicroseconds', toUInt64(1000)) AS ProfileEvents
                FROM values('start Int64, finish Int64, memory_usage UInt64, exception_code Int32, exception String', {rows}))"
        );
        let client = insight_clickhouse::Client::new(config);
        Ok(client
            .query(&evidence_query("system.processes", &logs))
            .bind("fixture")
            .bind("1970-01-01")
            .bind("fixture")
            .fetch_one::<QueryEvidence>()
            .await?)
    }

    #[tokio::test]
    #[ignore = "requires INTEGRATION_TESTS_CLICKHOUSE_URL"]
    async fn logged_memory_counts_only_overlapping_peaks() -> anyhow::Result<()> {
        let usage = synthetic_log(
            "(1,5,110,0,''),(6,8,80,0,''),(7,9,50,0,''),(9,10,65,0,''),(11,11,40,0,'')",
        )
        .await?;
        assert_eq!(usage.peak, 130);
        assert_eq!(usage.completed, 5);
        assert_eq!(usage.bytes, 15);
        assert_eq!(usage.records, 5);
        assert_eq!(usage.cpu_millis, 5);
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires INTEGRATION_TESTS_CLICKHOUSE_URL"]
    async fn distinguishes_server_241_from_query_and_user_limits() -> anyhow::Result<()> {
        let usage = synthetic_log(
            "(1,2,0,241,'(total) memory limit exceeded:'),
            (2,3,0,241,'Memory limit (total) exceeded:'),
            (3,4,0,241,'Query memory limit exceeded:'),
            (4,5,0,241,'Memory limit (for user) exceeded:'),
            (5,6,0,123,'(total) memory limit exceeded:')",
        )
        .await?;
        assert_eq!(usage.memory_errors, 4);
        assert_eq!(usage.global_memory_errors, 2);
        Ok(())
    }

    #[test]
    fn constrains_admission_at_the_tighter_memory_limit_and_fails_closed() {
        let mut m = Measurements {
            node: "a".into(),
            server_limit: 140,
            container_limit: 100,
            container_used: 70,
            tracked: 60,
            free_disk: 15,
            cpu_busy: 0.1,
            io_wait: 0.1,
            complete: 1,
        };
        let baseline = idle::IdleMemory::from([("a".into(), 70)]);
        assert_eq!(budget(std::slice::from_ref(&m), &baseline, 10), 20);
        assert!(healthy(std::slice::from_ref(&m)));
        m.container_limit = 140;
        m.server_limit = 100;
        assert_eq!(budget(std::slice::from_ref(&m), &baseline, 10), 20);
        m.cpu_busy = 0.95;
        assert!(!healthy(std::slice::from_ref(&m)));
        m.cpu_busy = 0.1;
        m.io_wait = 0.25;
        assert!(!healthy(std::slice::from_ref(&m)));
        m.io_wait = 0.1;
        m.free_disk = 4;
        assert!(!healthy(std::slice::from_ref(&m)));
        m.complete = 0;
        assert!(validate_measurements(&[m]).is_err());
    }
}
