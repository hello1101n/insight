pub(crate) mod history;
pub(crate) mod observer;
mod store;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use super::connector_schedules::resources::Resources;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WaitKind {
    Lock,
    Placement,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub(crate) struct StageWait {
    pub kind: WaitKind,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub holder: Option<String>,
}

fn stored_waits(json: &str) -> serde_json::Result<Vec<StageWait>> {
    let entries: Vec<Value> = serde_json::from_str(json)?;
    entries
        .into_iter()
        .filter(|entry| {
            let kind = &entry["kind"];
            !kind.is_string() || WaitKind::deserialize(kind).is_ok()
        })
        .map(serde_json::from_value)
        .collect()
}

#[test]
fn stored_waits_preserve_current_kinds_alongside_retired_kinds() -> anyhow::Result<()> {
    let entries = serde_json::json!([
        {"kind": "retired", "started_at": DateTime::<Utc>::UNIX_EPOCH},
        {"kind": "placement", "started_at": DateTime::<Utc>::UNIX_EPOCH}
    ]);
    let waits = stored_waits(&entries.to_string())?;
    assert_eq!(waits.len(), 1);
    assert_eq!(waits[0].kind, WaitKind::Placement);
    Ok(())
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

impl RunSnapshot {
    fn successful_gold_attempts(&self) -> impl Iterator<Item = &StageSnapshot> {
        let ready_stage = if self.connector == "jira" {
            "transform-jira-silver"
        } else {
            "transform-legacy"
        };
        self.stages
            .iter()
            .filter(move |stage| stage.stage == ready_stage && stage.status == "succeeded")
    }

    fn ready_at(&self) -> Option<DateTime<Utc>> {
        self.successful_gold_attempts()
            .filter_map(|stage| stage.finished_at)
            .min()
    }
}

#[derive(Debug)]
struct StageSnapshot {
    stage: &'static str,
    attempt: u32,
    bronze_execution: Option<DateTime<Utc>>,
    bronze_is_provisional: bool,
    status: &'static str,
    queued_at: DateTime<Utc>,
    started_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
    wait: Option<StageWait>,
    capacity_wait: Option<StageWait>,
    reason: Option<String>,
    connection: Option<String>,
    job: Option<u64>,
    records: Option<u64>,
    query_pod: Option<uuid::Uuid>,
    resources: Option<Resources>,
    actual_resources: Option<Resources>,
}

impl StageSnapshot {
    fn key(&self) -> String {
        if self.stage == "bronze" {
            self.bronze_execution.map_or_else(
                || "bronze:pending".to_owned(),
                |execution| format!("bronze:{}", execution.timestamp_millis()),
            )
        } else {
            format!("{}:{}", self.attempt, self.queued_at.timestamp_millis())
        }
    }

    fn new(stage: &'static str, attempt: u32, queued_at: DateTime<Utc>) -> Self {
        Self {
            stage,
            attempt,
            bronze_execution: None,
            bronze_is_provisional: false,
            status: "starting",
            queued_at,
            started_at: None,
            finished_at: None,
            wait: None,
            capacity_wait: None,
            reason: None,
            connection: None,
            job: None,
            records: None,
            query_pod: None,
            resources: None,
            actual_resources: None,
        }
    }
}
