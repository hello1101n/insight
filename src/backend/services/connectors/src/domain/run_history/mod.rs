pub(crate) mod history;
pub(crate) mod observer;
mod store;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WaitKind {
    Lock,
    SyncSlot,
    Placement,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub(crate) struct StageWait {
    pub kind: WaitKind,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub holder: Option<String>,
}

#[derive(Debug)]
struct RunSnapshot {
    uid: String,
    name: String,
    connector: String,
    tenant: String,
    source: String,
    created_at: DateTime<Utc>,
    execution: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
    status: Option<&'static str>,
    stages: Vec<StageSnapshot>,
}

#[derive(Debug)]
struct StageSnapshot {
    stage: &'static str,
    attempt: u32,
    status: &'static str,
    queued_at: DateTime<Utc>,
    started_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
    wait: Option<StageWait>,
    reason: Option<String>,
    connection: Option<String>,
    job: Option<u64>,
    records: Option<u64>,
    query_pod: Option<uuid::Uuid>,
}

impl StageSnapshot {
    fn key(&self) -> String {
        if self.stage == "bronze" {
            self.attempt.to_string()
        } else {
            format!("{}:{}", self.attempt, self.queued_at.timestamp_millis())
        }
    }

    fn new(stage: &'static str, attempt: u32, queued_at: DateTime<Utc>) -> Self {
        Self {
            stage,
            attempt,
            status: "starting",
            queued_at,
            started_at: None,
            finished_at: None,
            wait: None,
            reason: None,
            connection: None,
            job: None,
            records: None,
            query_pod: None,
        }
    }
}
