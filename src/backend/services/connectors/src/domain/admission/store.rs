use std::collections::HashSet;
use std::time::Duration;

use chrono::{DateTime, Utc};
use sea_orm::{
    ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbBackend, FromQueryResult,
    Statement, TransactionTrait, Value,
};
use serde::Serialize;

use super::{Observation, Request, StageRow, capacity::Snapshot};

const MIB: u64 = 1024 * 1024;
const COLD_MIN_BYTES: u64 = 256 * MIB;
const GRANTS_PER_CYCLE: usize = 32;

// Wait for the database write lock without using up the pool needed by readers.
static WRITE_QUEUE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
const FIELDS: &str = "s.id,s.sync_id,r.workflow_name,r.connector,r.source_id,s.reason,s.stage,s.attempt,s.status,s.decision,s.estimated_bytes,(s.cold OR (s.custom_selection IS NULL AND s.stage IN ('transform-jira-staging','transform-jira-silver'))) AS cold,s.queued_at,s.started_at,s.finished_at,s.granted_at,s.airbyte_job_id,s.connection_id,s.airbyte_claimed";
const JOIN: &str = " FROM ingestion_stage_attempts s JOIN ingestion_runs r ON r.sync_id=s.sync_id ";
const TERMINAL: &str = "'succeeded','failed','cancelled','wait_timeout'";

pub(super) fn sql(query: impl Into<String>, params: Vec<Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::MySql, query, params)
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum WriteError {
    #[error("stage conflicts with a previous request or a terminal workflow")]
    Conflict,
    #[error("ingestion store unavailable")]
    Db(#[from] sea_orm::DbErr),
}

#[derive(Serialize, Debug, Clone, Copy)]
pub(crate) struct Resources {
    pub scope: &'static str,
    pub cpu_millis: u32,
    pub memory_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_cpu_millis: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_memory_bytes: Option<u64>,
}
impl Resources {
    fn new(stage: &str, cpu_millis: u32, memory_bytes: u64) -> Self {
        let bronze = stage == "bronze";
        Self {
            cpu_millis,
            memory_bytes,
            scope: if bronze { "airbyte_source" } else { "pod" },
            source_cpu_millis: bronze.then_some(cpu_millis),
            source_memory_bytes: bronze.then_some(memory_bytes),
        }
    }
}
#[derive(Serialize, Debug)]
pub(crate) struct Reply {
    pub decision: String,
    pub resources: Resources,
}

#[derive(FromQueryResult)]
struct Saved {
    decision: String,
    state: String,
    mode_signature: Option<String>,
    run_status: Option<String>,
    source_id: String,
    connector: String,
    workflow_name: String,
    stand: String,
    tenant: String,
    connection_id: Option<String>,
    pod_cpu: u32,
    pod_memory: u64,
    airbyte_claimed: bool,
    airbyte_sender: Option<String>,
    airbyte_job_id: Option<String>,
}

async fn locked(db: &DatabaseConnection, stand: &str) -> Result<DatabaseTransaction, WriteError> {
    let acquire = async {
        let _turn = WRITE_QUEUE
            .acquire()
            .await
            .map_err(|_| sea_orm::DbErr::Custom("admission write queue closed".into()))?;
        let tx = db.begin().await?;
        tx.execute_raw(sql(
            "INSERT INTO ingestion_stands(stand) VALUES(?) ON DUPLICATE KEY UPDATE stand=VALUES(stand)",
            vec![stand.into()],
        ))
        .await?;
        Ok(tx)
    };
    tokio::time::timeout(Duration::from_secs(10), acquire)
        .await
        .map_err(|_| sea_orm::DbErr::Custom("admission write lock timed out".into()))?
}

fn key(req: &Request) -> Vec<Value> {
    vec![
        req.sync_id.to_string().into(),
        req.stage.clone().into(),
        req.attempt.into(),
    ]
}
async fn saved(
    tx: &DatabaseTransaction,
    req: &Request,
    stand: &str,
    tenant: &str,
) -> Result<Option<Saved>, WriteError> {
    let row=Saved::find_by_statement(sql(format!("SELECT r.mode_signature,s.status AS state,s.decision,s.pod_cpu,s.pod_memory,r.status AS run_status,r.stand,r.tenant,r.source_id,r.connector,r.workflow_name,s.connection_id,s.airbyte_claimed,s.airbyte_job_id,s.airbyte_sender
              {JOIN}
              WHERE s.sync_id=?
              AND s.stage=?
              AND s.attempt=?"),key(req))).one(tx).await?;
    if let Some(r) = &row
        && (r.stand != stand
            || r.tenant != tenant
            || r.source_id != req.source_id
            || r.connector != req.connector
            || r.workflow_name != req.workflow_name
            || req
                .mode_signature
                .as_ref()
                .is_some_and(|v| Some(v) != r.mode_signature.as_ref())
            || r.connection_id != req.connection_id
            || r.run_status.is_some()
            || matches!(
                r.state.as_str(),
                "succeeded" | "failed" | "cancelled" | "wait_timeout"
            ))
    {
        return Err(WriteError::Conflict);
    }
    Ok(row)
}

#[derive(FromQueryResult)]
struct Prior {
    peak_bytes: Option<u64>,
    pod_peak_bytes: Option<u64>,
    pod_cpu_millis: Option<u64>,
    source_peak_bytes: Option<u64>,
    source_cpu_millis: Option<u64>,
    input_volume_bytes: Option<u64>,
}
fn margin(v: u64) -> u64 {
    v.saturating_add(v.div_ceil(4))
}
#[derive(FromQueryResult)]
struct ActiveStage {
    id: u64,
    stage: String,
    estimated_bytes: u64,
    cold: bool,
    connection_id: Option<String>,
}

#[derive(Default)]
struct Occupied {
    ids: HashSet<u64>,
    bytes: u64,
    any: bool,
    cold: bool,
    connections: HashSet<String>,
    writers: HashSet<&'static str>,
}

// All staging selections build identity.identity_inputs. Downstream selections intersect
// on shared Silver/Gold tables. The resolver publishes identity tables independently.
fn writer(stage: &str) -> Option<&'static str> {
    match stage {
        "transform-staging" | "transform-jira-staging" => Some("staging"),
        "transform-legacy" | "transform-jira-silver" => Some("downstream"),
        "identity-seed" => Some("identity"),
        _ => None,
    }
}

enum Eligibility {
    Grant,
    Skip,
    WaitForActive,
}

impl Occupied {
    fn account(&mut self, stage: &str, connection: Option<String>, bytes: u64, cold: bool) {
        self.any = true;
        self.cold |= cold;
        self.bytes = self.bytes.saturating_add(bytes);
        self.connections.extend(connection);
        self.writers.extend(writer(stage));
    }

    fn eligibility(
        &self,
        stage: &str,
        connection: Option<&str>,
        bytes: u64,
        cold: bool,
        capacity: u64,
    ) -> Eligibility {
        if self.cold {
            return Eligibility::WaitForActive;
        }
        let needed = if cold { COLD_MIN_BYTES } else { bytes };
        if needed > capacity {
            return Eligibility::Skip;
        }
        if cold && self.any {
            return Eligibility::WaitForActive;
        }
        if connection.is_some_and(|c| self.connections.contains(c))
            || writer(stage).is_some_and(|w| self.writers.contains(w))
        {
            return Eligibility::Skip;
        }
        if needed > capacity.saturating_sub(self.bytes) {
            return Eligibility::WaitForActive;
        }
        Eligibility::Grant
    }
}

async fn occupied(tx: &DatabaseTransaction, stand: &str) -> Result<Occupied, sea_orm::DbErr> {
    let active=ActiveStage::find_by_statement(sql(
        format!("SELECT id,stage,estimated_bytes,(cold OR (custom_selection IS NULL AND stage IN ('transform-jira-staging','transform-jira-silver'))) AS cold,connection_id FROM ingestion_stage_attempts
            WHERE stand=? AND finished_at IS NULL AND granted_at IS NOT NULL AND status NOT IN ({TERMINAL})"),
        vec![stand.into()],
    )).all(tx).await?;
    let mut result = Occupied::default();
    for s in active {
        result.ids.insert(s.id);
        result.account(&s.stage, s.connection_id, s.estimated_bytes, s.cold);
    }
    Ok(result)
}

fn pod_resources(stage: &str, comparable: &[&Prior], retry_memory_floor: u64) -> Resources {
    let bronze = stage == "bronze";
    let measured_cpu = comparable
        .iter()
        .filter_map(|p| {
            if bronze {
                p.source_cpu_millis
            } else {
                p.pod_cpu_millis
            }
        })
        .max()
        .map_or(0, margin);
    let measured_memory = comparable
        .iter()
        .filter_map(|p| {
            if bronze {
                p.source_peak_bytes
            } else {
                p.pod_peak_bytes
            }
        })
        .max()
        .map_or(0, margin);
    let (cpu, memory) = if bronze {
        (measured_cpu.max(1000), measured_memory.max(2048 * MIB))
    } else {
        (measured_cpu.max(500), measured_memory.max(1024 * MIB))
    };
    Resources::new(
        stage,
        u32::try_from(cpu).unwrap_or(u32::MAX),
        memory.max(retry_memory_floor),
    )
}

async fn prepare_run(
    tx: &DatabaseTransaction,
    stand: &str,
    tenant: &str,
    req: &Request,
    workflow_start: DateTime<Utc>,
) -> Result<u64, WriteError> {
    let sync = req.sync_id.to_string();
    tx.execute_raw(sql("INSERT INTO ingestion_runs(sync_id,stand,tenant,connector,source_id,workflow_name,started_at,mode_signature)
              VALUES(?,?,?,?,?,?,?,?)
              ON DUPLICATE KEY UPDATE sync_id=VALUES(sync_id)",vec![
            sync.clone().into(),
            stand.into(),
            tenant.into(),
            req.connector.clone().into(),
            req.source_id.clone().into(),
            req.workflow_name.clone().into(),
            workflow_start.into(),
            req.mode_signature.clone().into(),
        ])).await?;
    if tx
        .query_one_raw(sql(
            "SELECT sync_id
              FROM ingestion_runs
              WHERE sync_id=?
              AND stand=?
              AND tenant=?
              AND connector=?
              AND source_id=?
              AND workflow_name=?
              AND status IS NULL",
            vec![
                sync.clone().into(),
                stand.into(),
                tenant.into(),
                req.connector.clone().into(),
                req.source_id.clone().into(),
                req.workflow_name.clone().into(),
            ],
        ))
        .await?
        .is_none()
    {
        return Err(WriteError::Conflict);
    }
    let mut retry_memory_floor = 0;
    if req.attempt != 1 {
        if req.attempt != 2 || req.stage != "bronze" {
            return Err(WriteError::Conflict);
        }
        let previous = tx
            .query_one_raw(sql(
                "SELECT reason,source_oom_limit_bytes
              FROM ingestion_stage_attempts
              WHERE sync_id=?
              AND stage='bronze'
              AND attempt=1
              AND retry_allowed=1
              AND status='failed'
              AND connection_id=?",
                vec![sync.clone().into(), req.connection_id.clone().into()],
            ))
            .await?
            .ok_or(WriteError::Conflict)?;
        if previous.try_get::<String>("", "reason")? == "source_pod_oom" {
            let limit = previous
                .try_get::<Option<u64>>("", "source_oom_limit_bytes")?
                .filter(|n| *n > 0)
                .ok_or(WriteError::Conflict)?;
            retry_memory_floor = limit.saturating_add(limit.div_ceil(2));
        }
    }
    Ok(retry_memory_floor)
}

struct Estimate {
    volume: Option<u64>,
    cold: bool,
    estimated: u64,
    resources: Resources,
}

async fn estimate(
    tx: &DatabaseTransaction,
    stand: &str,
    tenant: &str,
    req: &Request,
    retry_memory_floor: u64,
    capacity: u64,
) -> Result<Estimate, WriteError> {
    let sync = req.sync_id.to_string();
    let prior=Prior::find_by_statement(sql(format!("SELECT s.peak_bytes,s.pod_peak_bytes,s.pod_cpu_millis,s.source_cpu_millis,s.source_peak_bytes,s.input_volume_bytes
              {JOIN}
              WHERE r.stand=?
              AND r.tenant=?
              AND r.source_id=?
              AND r.connector=?
              AND s.stage=?
              AND s.status='succeeded'
              AND NOT COALESCE(s.custom_selection,s.stage IN ('transform-jira-staging','transform-jira-silver'))
              AND r.mode_signature=(SELECT current_run.mode_signature FROM ingestion_runs current_run WHERE current_run.sync_id=?)
              AND s.peak_bytes IS NOT NULL
              ORDER BY s.finished_at DESC
              LIMIT 5"),vec![
            stand.into(),
            tenant.into(),
            req.source_id.clone().into(),
            req.connector.clone().into(),
            req.stage.clone().into(),
            sync.clone().into(),
        ])).all(tx).await?;
    let volume = tx
        .query_one_raw(sql(
            "SELECT volume_bytes
              FROM ingestion_stage_attempts
              WHERE sync_id=?
              AND stage='bronze'
              AND status='succeeded'
              AND volume_bytes IS NOT NULL
              ORDER BY attempt DESC
              LIMIT 1",
            vec![sync.clone().into()],
        ))
        .await?
        .map(|row| row.try_get::<u64>("", "volume_bytes"))
        .transpose()?;
    let comparable: Vec<_> = prior
        .iter()
        .filter(|p| {
            !req.custom_selection
                && match (volume, p.input_volume_bytes) {
                    (Some(v), Some(old)) => v <= margin(old),
                    _ => req.stage == "bronze",
                }
        })
        .collect();
    let cold = comparable.is_empty();
    let estimated = comparable
        .iter()
        .filter_map(|p| p.peak_bytes)
        .max()
        .map_or(capacity.max(COLD_MIN_BYTES), |v| margin(v).max(1));
    let resources = pod_resources(&req.stage, &comparable, retry_memory_floor);
    Ok(Estimate {
        volume,
        cold,
        estimated,
        resources,
    })
}

pub(crate) async fn register(
    db: &DatabaseConnection,
    stand: &str,
    tenant: &str,
    req: &Request,
    workflow_start: DateTime<Utc>,
    capacity: impl Into<Snapshot>,
) -> Result<(bool, Reply), WriteError> {
    let tx = locked(db, stand).await?;
    if let Some(r) = saved(&tx, req, stand, tenant).await? {
        if req.stage == "bronze" && r.mode_signature != req.mode_signature {
            return Err(WriteError::Conflict);
        }
        tx.commit().await?;
        return Ok((
            false,
            Reply {
                decision: r.decision,
                resources: Resources::new(&req.stage, r.pod_cpu, r.pod_memory),
            },
        ));
    }
    let capacity = capacity.into();
    let sync = req.sync_id.to_string();
    let retry_memory_floor = prepare_run(&tx, stand, tenant, req, workflow_start).await?;
    let Estimate {
        volume,
        cold,
        estimated,
        resources,
    } = estimate(
        &tx,
        stand,
        tenant,
        req,
        retry_memory_floor,
        capacity.uncredited(),
    )
    .await?;
    let inserted=tx.execute_raw(sql("INSERT INTO ingestion_stage_attempts(stand,sync_id,stage,attempt,connection_id,decision,status,queued_at,estimated_bytes,cold,pod_cpu,pod_memory,input_volume_bytes,resource_scope,custom_selection)
              VALUES(?,?,?,?,?,'queued','queued',UTC_TIMESTAMP(3),?,?,?,?,?,?,?)",vec![
            stand.into(),
            sync.into(),
            req.stage.clone().into(),
            req.attempt.into(),
            req.connection_id.clone().into(),
            estimated.into(),
            cold.into(),
            resources.cpu_millis.into(),
            resources.memory_bytes.into(),
            volume.into(),
            resources.scope.into(),
            req.custom_selection.into(),
        ])).await?;
    let first = tx
        .query_one_raw(sql(
            "SELECT id FROM ingestion_stage_attempts
              WHERE stand=? AND status='queued' AND queued_at>=UTC_TIMESTAMP(3)-INTERVAL 6 HOUR
              ORDER BY queued_at,id LIMIT 1",
            vec![stand.into()],
        ))
        .await?;
    let direct = if capacity.with_managed > 0
        && first.map(|r| r.try_get::<u64>("", "id")).transpose()? == Some(inserted.last_insert_id())
    {
        let used = occupied(&tx, stand).await?;
        matches!(
            used.eligibility(
                &req.stage,
                req.connection_id.as_deref(),
                estimated,
                cold,
                capacity.for_active(&used.ids)
            ),
            Eligibility::Grant
        )
    } else {
        false
    };
    if direct {
        tx.execute_raw(sql(
            "UPDATE ingestion_stage_attempts
              SET decision='granted',status='starting',
                  granted_at=UTC_TIMESTAMP(3)
              WHERE id=?",
            vec![inserted.last_insert_id().into()],
        ))
        .await?;
    }
    tx.commit().await?;
    Ok((
        true,
        Reply {
            decision: if direct { "granted" } else { "queued" }.into(),
            resources,
        },
    ))
}

pub(crate) async fn promote_ready(
    db: &DatabaseConnection,
    stand: &str,
    ready: &HashSet<u64>,
    capacity: impl Into<Snapshot>,
) -> anyhow::Result<Vec<u64>> {
    let capacity = capacity.into();
    if ready.is_empty() || capacity.with_managed == 0 {
        return Ok(Vec::new());
    }
    let tx = locked(db, stand).await?;
    let mut used = occupied(&tx, stand).await?;
    let capacity = capacity.for_active(&used.ids);
    let queue = StageRow::find_by_statement(sql(
        format!(
            "SELECT {FIELDS} {JOIN}
        WHERE s.stand=? AND r.status IS NULL AND s.status='queued'
          AND s.queued_at>=UTC_TIMESTAMP(3)-INTERVAL 6 HOUR ORDER BY s.queued_at,s.id"
        ),
        vec![stand.into()],
    ))
    .all(&tx)
    .await?;
    let mut grants = Vec::new();
    for row in queue.into_iter().filter(|row| ready.contains(&row.id)) {
        match used.eligibility(
            &row.stage,
            row.connection_id.as_deref(),
            row.estimated_bytes,
            row.cold,
            capacity,
        ) {
            Eligibility::Skip => continue,
            Eligibility::WaitForActive => break,
            Eligibility::Grant => {}
        }
        let bytes = if row.cold {
            capacity
        } else {
            row.estimated_bytes
        };
        tx.execute_raw(sql("UPDATE ingestion_stage_attempts SET status='starting',granted_at=UTC_TIMESTAMP(3),estimated_bytes=? WHERE id=? AND status='queued'",vec![bytes.into(),row.id.into()])).await?;
        tracing::info!(connector=%row.connector,source_id=%row.source_id,stage=%row.stage,"granting queued ingestion stage");
        used.account(&row.stage, row.connection_id, bytes, row.cold);
        grants.push(row.id);
        if grants.len() == GRANTS_PER_CYCLE || used.cold {
            break;
        }
    }
    tx.commit().await?;
    Ok(grants)
}

pub(super) async fn active_stages(
    db: &DatabaseConnection,
    stand: &str,
) -> Result<Vec<StageRow>, sea_orm::DbErr> {
    StageRow::find_by_statement(sql(format!("SELECT {FIELDS} {JOIN}
        WHERE s.stand=? AND s.finished_at IS NULL AND s.granted_at IS NOT NULL AND s.status NOT IN ({TERMINAL})"),vec![stand.into()])).all(db).await
}

pub(crate) async fn unfinished(
    db: &DatabaseConnection,
    stand: &str,
) -> anyhow::Result<Vec<StageRow>> {
    Ok(StageRow::find_by_statement(sql(
        format!(
            "SELECT {FIELDS}
              {JOIN}
              WHERE r.stand=? AND r.status IS NULL
              UNION ALL SELECT {FIELDS} {JOIN}
              WHERE s.stand=? AND s.finished_at IS NULL AND s.status NOT IN ({TERMINAL}) AND r.status IS NOT NULL
              ORDER BY queued_at,id"
        ),
        vec![stand.into(),stand.into()],
    ))
    .all(db)
    .await?)
}

pub(crate) async fn observe(
    db: &DatabaseConnection,
    stand: &str,
    row: &StageRow,
    o: Observation,
) -> anyhow::Result<()> {
    let tx = locked(db, stand).await?;
    tx.execute_raw(sql(format!("UPDATE ingestion_stage_attempts s
              INNER JOIN ingestion_runs r ON r.sync_id=s.sync_id
              SET s.status=COALESCE(?,s.status),
                  s.started_at=COALESCE(s.started_at,?),
                  s.finished_at=COALESCE(s.finished_at,?),
                  s.reason=COALESCE(?,s.reason),
                  s.bronze_replay_safe=COALESCE(?,s.bronze_replay_safe),
                  s.airbyte_job_id=COALESCE(s.airbyte_job_id,?),
                  s.peak_bytes=GREATEST(COALESCE(s.peak_bytes,?),COALESCE(?,s.peak_bytes)),
                  s.volume_bytes=COALESCE(?,s.volume_bytes),
                  s.records_reported=COALESCE(?,s.records_reported),
                  s.cpu_millis=COALESCE(?,s.cpu_millis),
                  s.source_oom_limit_bytes=COALESCE(?,s.source_oom_limit_bytes),
                  s.source_peak_bytes=GREATEST(COALESCE(s.source_peak_bytes,?),COALESCE(?,s.source_peak_bytes)),
                  s.source_cpu_millis=GREATEST(COALESCE(s.source_cpu_millis,?),COALESCE(?,s.source_cpu_millis)),
                  s.pod_peak_bytes=GREATEST(COALESCE(s.pod_peak_bytes,?),COALESCE(?,s.pod_peak_bytes)),
                  s.pod_cpu_millis=GREATEST(COALESCE(s.pod_cpu_millis,?),COALESCE(?,s.pod_cpu_millis))
              WHERE r.stand=?
              AND s.id=?
              AND s.status=?
              AND s.airbyte_claimed=?
              AND s.status NOT IN ({TERMINAL})
              AND (s.airbyte_job_id IS NULL OR ? IS NULL OR s.airbyte_job_id=?)"),vec![
            o.status.into(),
            o.started_at.into(),
            o.finished_at.into(),
            o.reason.into(),
            o.bronze_replay_safe.into(),
            o.airbyte_job_id.clone().into(),
            o.peak_bytes.into(),
            o.peak_bytes.into(),
            o.volume_bytes.into(),
            o.records_reported.into(),
            o.cpu_millis.into(),
            o.source_oom_limit_bytes.into(),
            o.source_peak_bytes.into(),
            o.source_peak_bytes.into(),
            o.source_cpu_millis.into(),
            o.source_cpu_millis.into(),
            o.pod_peak_bytes.into(),
            o.pod_peak_bytes.into(),
            o.pod_cpu_millis.into(),
            o.pod_cpu_millis.into(),
            stand.into(),
            row.id.into(),
            row.status.clone().into(),
            row.airbyte_claimed.into(),
            o.airbyte_job_id.clone().into(),
            o.airbyte_job_id.into(),
        ])).await?;
    if matches!(
        row.stage.as_str(),
        "transform-jira-silver" | "transform-legacy"
    ) {
        tx.execute_raw(sql("UPDATE ingestion_runs r JOIN ingestion_stage_attempts s ON s.sync_id=r.sync_id
            SET r.ready_at=s.finished_at WHERE r.stand=? AND s.id=? AND r.ready_at IS NULL AND s.status='succeeded'
            AND s.stage=IF(r.connector='jira','transform-jira-silver','transform-legacy')",vec![stand.into(),row.id.into()])).await?;
    }
    if let (Some(status), Some(finished)) = (o.run_status, o.run_finished_at) {
        tx.execute_raw(sql(
            format!(
                "UPDATE ingestion_runs r
              SET r.status=IF(EXISTS(SELECT 1
              FROM ingestion_stage_attempts s
              WHERE s.sync_id=r.sync_id
              AND s.status='wait_timeout'),'wait_timeout',?),
                  r.finished_at=?
              WHERE r.stand=?
              AND r.sync_id=?
              AND r.status IS NULL
              AND NOT EXISTS(SELECT 1
              FROM ingestion_stage_attempts s
              WHERE s.sync_id=r.sync_id
              AND s.status NOT IN ({TERMINAL}))"
            ),
            vec![
                status.into(),
                finished.into(),
                stand.into(),
                row.sync_id.clone().into(),
            ],
        ))
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[derive(Serialize)]
pub(crate) struct Claim {
    pub decision: &'static str,
    pub job_id: Option<String>,
}
pub(crate) enum AirbyteWrite<'a> {
    Claim(Option<uuid::Uuid>),
    Receipt(&'a str),
}
pub(crate) async fn airbyte(
    db: &DatabaseConnection,
    stand: &str,
    tenant: &str,
    req: &Request,
    operation: AirbyteWrite<'_>,
) -> Result<Claim, WriteError> {
    let tx = locked(db, stand).await?;
    let s = saved(&tx, req, stand, tenant)
        .await?
        .ok_or(WriteError::Conflict)?;
    if req.stage != "bronze" || s.state == "queued" || s.connection_id.is_none() {
        return Err(WriteError::Conflict);
    }
    let (sender, job_id) = match operation {
        AirbyteWrite::Claim(sender) => (sender.map(|id| id.to_string()), None),
        AirbyteWrite::Receipt(job) => (None, Some(job)),
    };
    let params = key(req);
    let (decision, job) = if let Some(job) = s.airbyte_job_id {
        if job_id.is_some_and(|j| j != job) {
            return Err(WriteError::Conflict);
        }
        ("poll", Some(job))
    } else if let Some(job) = job_id {
        if !s.airbyte_claimed {
            return Err(WriteError::Conflict);
        }
        let owner = tx
            .query_one_raw(sql(
                "SELECT id FROM ingestion_stage_attempts WHERE stand=? AND airbyte_job_id=?",
                vec![stand.into(), job.into()],
            ))
            .await?;
        if owner.is_some() {
            return Err(WriteError::Conflict);
        }
        tx.execute_raw(sql("UPDATE ingestion_stage_attempts SET airbyte_job_id=? WHERE sync_id=? AND stage=? AND attempt=?",vec![job.into(),params[0].clone(),params[1].clone(),params[2].clone()])).await?;
        ("poll", Some(job.to_owned()))
    } else if s.airbyte_claimed {
        if sender.is_some() && sender == s.airbyte_sender {
            ("send", None)
        } else {
            ("verify", None)
        }
    } else {
        let other = tx
            .query_one_raw(sql(
                format!(
                    "SELECT s.id
              {JOIN}
              WHERE r.stand=?
              AND s.connection_id=?
              AND s.airbyte_claimed=1
              AND s.status NOT IN ({TERMINAL})
              LIMIT 1"
                ),
                vec![stand.into(), req.connection_id.clone().into()],
            ))
            .await?;
        if other.is_some() {
            return Err(WriteError::Conflict);
        }
        tx.execute_raw(sql(
            "UPDATE ingestion_stage_attempts
              SET airbyte_claimed=1, airbyte_sender=?
              WHERE sync_id=?
              AND stage=?
              AND attempt=?",
            [vec![sender.into()], params].concat(),
        ))
        .await?;
        ("send", None)
    };
    tx.commit().await?;
    Ok(Claim {
        decision,
        job_id: job,
    })
}

pub(crate) async fn poll_airbyte(
    db: &DatabaseConnection,
    stand: &str,
    tenant: &str,
    req: &Request,
    job: u64,
) -> Result<StageRow, WriteError> {
    let mut params = vec![
        stand.into(),
        tenant.into(),
        req.connector.clone().into(),
        req.source_id.clone().into(),
        req.workflow_name.clone().into(),
        req.connection_id.clone().into(),
        job.to_string().into(),
    ];
    params.extend(key(req));
    let record = StageRow::find_by_statement(sql(
        format!(
            "SELECT {FIELDS} {JOIN}
        WHERE r.stand=? AND r.tenant=? AND r.connector=? AND r.source_id=? AND r.workflow_name=?
        AND s.connection_id=? AND s.airbyte_job_id=? AND s.sync_id=? AND s.stage=? AND s.attempt=?"
        ),
        params,
    ))
    .one(db)
    .await?
    .ok_or(WriteError::Conflict)?;
    Ok(record)
}

pub(crate) async fn retry_bronze(
    db: &DatabaseConnection,
    stand: &str,
    tenant: &str,
    req: &Request,
    mode_safe: bool,
    capacity: u64,
) -> Result<Claim, WriteError> {
    let tx = locked(db, stand).await?;
    if req.stage != "bronze" || req.attempt != 1 {
        return Err(WriteError::Conflict);
    }
    let mut params = vec![
        stand.into(),
        tenant.into(),
        req.source_id.clone().into(),
        req.connector.clone().into(),
        req.workflow_name.clone().into(),
        req.connection_id.clone().into(),
    ];
    params.extend(key(req));
    let record=tx.query_one_raw(sql(format!("SELECT r.status AS run_status,s.status,s.reason,s.airbyte_job_id,s.bronze_replay_safe,s.retry_allowed,s.cold,s.peak_bytes,s.estimated_bytes,s.source_oom_limit_bytes
              {JOIN}
              WHERE r.stand=?
              AND r.tenant=?
              AND r.source_id=?
              AND r.connector=?
              AND r.workflow_name=?
              AND s.connection_id=?
              AND s.sync_id=?
              AND s.stage=?
              AND s.attempt=?"),params)).await?.ok_or(WriteError::Conflict)?;
    let status = record.try_get::<String>("", "status")?;
    let run = record.try_get::<Option<String>>("", "run_status")?;
    let reason = record.try_get::<Option<String>>("", "reason")?;
    let peak = record
        .try_get::<Option<u64>>("", "peak_bytes")?
        .unwrap_or_default();
    let fixable = (reason.as_deref() == Some("source_pod_oom")
        && record
            .try_get::<Option<u64>>("", "source_oom_limit_bytes")?
            .is_some_and(|n| n > 0))
        || (reason.as_deref() == Some("clickhouse_server_memory_pressure")
            && capacity > record.try_get::<u64>("", "estimated_bytes")?
            && peak > 0
            && capacity >= margin(peak));
    let decision = if run.is_some() || !mode_safe {
        "stop"
    } else if record.try_get::<bool>("", "retry_allowed")? {
        "retry"
    } else if status != "failed" {
        if matches!(
            status.as_str(),
            "unknown" | "checking_start" | "succeeded" | "cancelled" | "wait_timeout"
        ) {
            "stop"
        } else {
            "verify"
        }
    } else if record.try_get::<bool>("", "cold")?
        && record
            .try_get::<Option<String>>("", "airbyte_job_id")?
            .is_some()
        && record.try_get::<bool>("", "bronze_replay_safe")?
        && fixable
    {
        tx.execute_raw(sql("UPDATE ingestion_stage_attempts SET retry_allowed=1 WHERE sync_id=? AND stage=? AND attempt=?",key(req))).await?;
        "retry"
    } else {
        "stop"
    };
    tx.commit().await?;
    Ok(Claim {
        decision,
        job_id: None,
    })
}

#[cfg(test)]
mod tests;
