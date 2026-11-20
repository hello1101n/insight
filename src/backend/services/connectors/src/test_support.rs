use std::sync::LazyLock;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::Mutex;
use uuid::Uuid;

static PROCESS_TOKEN: LazyLock<String> =
    LazyLock::new(|| Uuid::new_v4().simple().to_string()[..8].to_owned());
static NEXT_CONNECTOR: AtomicU64 = AtomicU64::new(0);

// INVARIANT: Live tests hold this lock across all reads and changes to ingestion_history.sync_events.
pub(crate) static SYNC_EVENTS_LOCK: Mutex<()> = Mutex::const_new(());

pub(crate) fn connector_name() -> String {
    let sequence = NEXT_CONNECTOR.fetch_add(1, Ordering::Relaxed);
    format!("test-{}-{sequence:x}", *PROCESS_TOKEN)
}
