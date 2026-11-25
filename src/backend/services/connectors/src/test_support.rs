use std::sync::LazyLock;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Deserialize;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::domain::connector_schedules::resources::Resources;

static PROCESS_TOKEN: LazyLock<String> =
    LazyLock::new(|| Uuid::new_v4().simple().to_string()[..8].to_owned());
static NEXT_CONNECTOR: AtomicU64 = AtomicU64::new(0);

// INVARIANT: Live tests hold this lock across all reads and changes to ingestion_history.sync_events.
pub(crate) static SYNC_EVENTS_LOCK: Mutex<()> = Mutex::const_new(());

pub(crate) fn connector_name() -> String {
    let sequence = NEXT_CONNECTOR.fetch_add(1, Ordering::Relaxed);
    format!("test-{}-{sequence:x}", *PROCESS_TOKEN)
}

#[derive(Debug, Deserialize)]
pub(crate) struct ResourceParameterFixture {
    pub(crate) parameters: ResourceParameterNames,
    pub(crate) cases: Vec<ResourceParameterCase>,
}

impl ResourceParameterFixture {
    pub(crate) fn load() -> serde_json::Result<Self> {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../tests/fixtures/connector-resource-parameters.json"
        )))
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct ResourceParameterNames {
    pub(crate) sync: String,
    pub(crate) dbt: String,
    pub(crate) identity: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ResourceParameterCase {
    pub(crate) name: String,
    pub(crate) requested: Resources,
    pub(crate) defaults: Resources,
    pub(crate) sync_resources: String,
    pub(crate) dbt_pod_patch: String,
    pub(crate) identity_pod_patch: String,
}
