pub(crate) mod capacity;
pub(crate) mod history;
pub(crate) mod reconcile;
pub(crate) mod store;
pub(crate) mod workload;

use chrono::{DateTime, Utc};
use serde::Deserialize;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct BronzeVolume {
    pub job_id: u64,
    pub bytes: u64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Request {
    pub sync_id: uuid::Uuid,
    pub workflow_name: String,
    #[serde(skip)]
    pub custom_selection: bool,
    #[serde(skip)]
    pub bronze_volume: Option<BronzeVolume>,
    pub mode_signature: Option<String>,
    pub connector: String,
    pub source_id: String,
    pub stage: String,
    pub attempt: u32,
    pub connection_id: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct Observation {
    pub status: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub run_finished_at: Option<DateTime<Utc>>,
    pub run_status: Option<String>,
    pub reason: Option<String>,
    pub airbyte_job_id: Option<String>,
    pub peak_bytes: Option<u64>,
    pub bronze_replay_safe: Option<bool>,
    pub records_reported: Option<u64>,
    pub volume_bytes: Option<u64>,
    pub cpu_millis: Option<u64>,
    pub pod_cpu_millis: Option<u64>,
    pub pod_peak_bytes: Option<u64>,
    pub source_peak_bytes: Option<u64>,
    pub source_oom_limit_bytes: Option<u64>,
    pub source_cpu_millis: Option<u64>,
}

#[derive(Clone, Debug, sea_orm::FromQueryResult)]
pub(crate) struct StageRow {
    pub id: u64,
    pub sync_id: String,
    pub workflow_name: String,
    pub connector: String,
    pub source_id: String,
    pub stage: String,
    pub attempt: u32,
    pub status: String,
    pub decision: String,
    pub estimated_bytes: u64,
    pub reason: Option<String>,
    pub cold: bool,
    pub queued_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub granted_at: Option<DateTime<Utc>>,
    pub airbyte_job_id: Option<String>,
    pub connection_id: Option<String>,
    pub airbyte_claimed: bool,
}
