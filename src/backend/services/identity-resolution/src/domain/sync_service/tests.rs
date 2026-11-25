use tokio::sync::Mutex;

use super::*;

const TENANT: Uuid = Uuid::from_u128(2);
const OTHER: Uuid = Uuid::from_u128(5);
const TIMEOUT: Duration = Duration::from_secs(60);

fn row(id: u64, created_at: &str) -> anyhow::Result<PersonsLogRow> {
    row_of(TENANT, id, created_at)
}

fn row_of(tenant: Uuid, id: u64, created_at: &str) -> anyhow::Result<PersonsLogRow> {
    Ok(PersonsLogRow {
        id,
        value_type: "email".to_owned(),
        insight_source_type: "bamboohr".to_owned(),
        insight_source_id: Uuid::from_u128(1),
        insight_tenant_id: tenant,
        value_id: Some("a@example.com".to_owned()),
        value_full_text: None,
        value: None,
        value_effective: Some("a@example.com".to_owned()),
        person_id: Uuid::from_u128(3),
        author_person_id: Uuid::from_u128(4),
        reason: None,
        created_at: parse(created_at)?,
    })
}

fn parse(s: &str) -> anyhow::Result<DateTime> {
    Ok(DateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")?)
}

fn of_tenant(rows: &[PersonsLogRow], tenant: Uuid) -> Vec<PersonsLogRow> {
    rows.iter()
        .filter(|r| r.insight_tenant_id == tenant)
        .cloned()
        .collect()
}

fn tenants_of(rows: &[PersonsLogRow]) -> Vec<Uuid> {
    let mut tenants: Vec<Uuid> = rows.iter().map(|r| r.insight_tenant_id).collect();
    tenants.sort_unstable();
    tenants.dedup();
    tenants
}

struct FakeReader(Vec<PersonsLogRow>);
#[async_trait]
impl PersonsLogReader for FakeReader {
    async fn tenants(&self) -> anyhow::Result<Vec<Uuid>> {
        Ok(tenants_of(&self.0))
    }
    async fn read_all(&self) -> anyhow::Result<Vec<PersonsLogRow>> {
        Ok(self.0.clone())
    }
    async fn read_tenant(&self, tenant: Uuid) -> anyhow::Result<Vec<PersonsLogRow>> {
        Ok(of_tenant(&self.0, tenant))
    }
    async fn latest_id(&self, tenant: Uuid) -> anyhow::Result<Option<u64>> {
        Ok(of_tenant(&self.0, tenant).iter().map(|r| r.id).max())
    }
}

struct FakeWriter {
    layout: Mutex<Layout>,
    full_publishes: Mutex<Vec<usize>>,
    replaces: Mutex<Vec<(Uuid, usize, DateTime)>>,
    published: Mutex<Option<u64>>,
    failing_tenant: Option<Uuid>,
}
impl Default for FakeWriter {
    fn default() -> Self {
        Self {
            layout: Mutex::new(Layout::Partitioned),
            full_publishes: Mutex::default(),
            replaces: Mutex::default(),
            published: Mutex::default(),
            failing_tenant: None,
        }
    }
}
impl FakeWriter {
    async fn with_published(self, max_id: u64) -> Self {
        *self.published.lock().await = Some(max_id);
        self
    }
    async fn stale(self) -> Self {
        *self.layout.lock().await = Layout::Stale;
        self
    }
    fn failing_for(mut self, tenant: Uuid) -> Self {
        self.failing_tenant = Some(tenant);
        self
    }
    async fn replace_count(&self) -> usize {
        self.replaces.lock().await.len()
    }
    async fn replaced_tenants(&self) -> Vec<Uuid> {
        self.replaces
            .lock()
            .await
            .iter()
            .map(|(t, _, _)| *t)
            .collect()
    }
    async fn synced_ats(&self) -> Vec<DateTime> {
        self.replaces
            .lock()
            .await
            .iter()
            .map(|(_, _, at)| *at)
            .collect()
    }
    async fn last(&self) -> Option<(usize, DateTime)> {
        self.replaces
            .lock()
            .await
            .last()
            .map(|(_, rows, at)| (*rows, *at))
    }
}
#[async_trait]
impl IdentityPersonsWriter for FakeWriter {
    async fn layout(&self) -> anyhow::Result<Layout> {
        Ok(*self.layout.lock().await)
    }
    async fn replace_all(&self, rows: &[PersonsLogRow], _: DateTime) -> anyhow::Result<()> {
        self.full_publishes.lock().await.push(rows.len());
        *self.layout.lock().await = Layout::Partitioned;
        Ok(())
    }
    async fn replace_tenant(
        &self,
        tenant: Uuid,
        rows: &[PersonsLogRow],
        synced_at: DateTime,
    ) -> anyhow::Result<()> {
        if self.failing_tenant == Some(tenant) {
            anyhow::bail!("clickhouse refused the replace");
        }
        self.replaces
            .lock()
            .await
            .push((tenant, rows.len(), synced_at));
        Ok(())
    }
    async fn published_max_id(&self, _: Uuid) -> anyhow::Result<Option<u64>> {
        Ok(*self.published.lock().await)
    }
}

#[derive(Default)]
struct FakeJournal {
    closed: Mutex<Vec<(Uuid, &'static str)>>,
}
#[async_trait]
impl SyncJournal for FakeJournal {
    async fn open(&self, _: Uuid) -> anyhow::Result<Uuid> {
        Ok(Uuid::now_v7())
    }
    async fn close(&self, _: Uuid, tenant: Uuid, result: &TenantResult) {
        let status = match result {
            TenantResult::Synced(_) => "completed",
            TenantResult::Refused(_) | TenantResult::Failed(_) => "failed",
        };
        self.closed.lock().await.push((tenant, status));
    }
}

struct GrowingReader {
    versions: Mutex<Vec<Vec<PersonsLogRow>>>,
}
impl GrowingReader {
    fn new(versions: Vec<Vec<PersonsLogRow>>) -> Self {
        Self {
            versions: Mutex::new(versions),
        }
    }
}
#[async_trait]
impl PersonsLogReader for GrowingReader {
    async fn tenants(&self) -> anyhow::Result<Vec<Uuid>> {
        Ok(tenants_of(&self.versions.lock().await[0]))
    }
    async fn read_all(&self) -> anyhow::Result<Vec<PersonsLogRow>> {
        Ok(self.versions.lock().await[0].clone())
    }
    async fn read_tenant(&self, tenant: Uuid) -> anyhow::Result<Vec<PersonsLogRow>> {
        let mut versions = self.versions.lock().await;
        if versions.len() > 1 {
            Ok(of_tenant(&versions.remove(0), tenant))
        } else {
            Ok(of_tenant(&versions[0], tenant))
        }
    }
    async fn latest_id(&self, tenant: Uuid) -> anyhow::Result<Option<u64>> {
        let versions = self.versions.lock().await;
        Ok(of_tenant(&versions[0], tenant).iter().map(|r| r.id).max())
    }
}

fn ticking_clock(start: &str) -> anyhow::Result<impl FnMut() -> DateTime + Send> {
    let mut t = parse(start)?;
    Ok(move || {
        t += chrono::Duration::seconds(1);
        t
    })
}

fn into_anyhow(e: SyncError) -> anyhow::Error {
    match e {
        SyncError::EmptyLog(msg) => anyhow::anyhow!(msg),
        SyncError::Failed(e) => e,
    }
}

async fn until_quiescent(
    reader: &dyn PersonsLogReader,
    writer: &dyn IdentityPersonsWriter,
    force: bool,
) -> anyhow::Result<SyncOutcome> {
    run_sync_until_quiescent(
        reader,
        writer,
        TENANT,
        ticking_clock("2026-07-29 12:00:00")?,
        force,
    )
    .await
    .map_err(into_anyhow)
}

#[tokio::test]
async fn a_quiet_log_publishes_exactly_once() -> anyhow::Result<()> {
    let reader = GrowingReader::new(vec![vec![row(7, "2026-07-01 10:00:00")?]]);
    let writer = FakeWriter::default();

    let outcome = until_quiescent(&reader, &writer, false).await?;

    let SyncOutcome::Published(summary) = outcome else {
        anyhow::bail!("a stale snapshot must be republished");
    };
    assert_eq!(summary.max_id, Some(7));
    assert_eq!(writer.replace_count().await, 1);
    Ok(())
}

#[tokio::test]
async fn a_current_snapshot_skips_the_copy_entirely() -> anyhow::Result<()> {
    let reader = GrowingReader::new(vec![vec![row(7, "2026-07-01 10:00:00")?]]);
    let writer = FakeWriter::default().with_published(7).await;

    let outcome = until_quiescent(&reader, &writer, false).await?;

    assert_eq!(outcome, SyncOutcome::AlreadyCurrent { max_id: Some(7) });
    assert_eq!(writer.replace_count().await, 0);
    Ok(())
}

#[tokio::test]
async fn a_snapshot_behind_the_log_is_republished() -> anyhow::Result<()> {
    let reader = GrowingReader::new(vec![vec![
        row(7, "2026-07-01 10:00:00")?,
        row(9, "2026-07-02 08:00:00")?,
    ]]);
    let writer = FakeWriter::default().with_published(7).await;

    until_quiescent(&reader, &writer, false).await?;

    assert_eq!(writer.replace_count().await, 1);
    Ok(())
}

#[tokio::test]
async fn force_republishes_a_current_snapshot() -> anyhow::Result<()> {
    let reader = GrowingReader::new(vec![vec![row(7, "2026-07-01 10:00:00")?]]);
    let writer = FakeWriter::default().with_published(7).await;

    until_quiescent(&reader, &writer, true).await?;

    assert_eq!(
        writer.replace_count().await,
        1,
        "--force republishes deliberately"
    );
    Ok(())
}

#[tokio::test]
async fn rows_landing_during_a_pass_are_published_by_the_next_one() -> anyhow::Result<()> {
    let v1 = vec![row(7, "2026-07-01 10:00:00")?];
    let v2 = vec![
        row(7, "2026-07-01 10:00:00")?,
        row(9, "2026-07-02 08:00:00")?,
    ];
    let reader = GrowingReader::new(vec![v1, v2]);
    let writer = FakeWriter::default();

    let outcome = until_quiescent(&reader, &writer, false).await?;

    let SyncOutcome::Published(summary) = outcome else {
        anyhow::bail!("late rows must be republished");
    };
    assert_eq!(
        summary.max_id,
        Some(9),
        "the snapshot carries the late rows"
    );
    assert_eq!(writer.replace_count().await, 2);
    Ok(())
}

#[tokio::test]
async fn a_log_that_never_settles_stops_at_the_pass_cap() -> anyhow::Result<()> {
    let versions: Vec<Vec<PersonsLogRow>> = (0..10)
        .map(|n| {
            (0..=n)
                .map(|id| row(id + 1, "2026-07-01 10:00:00"))
                .collect()
        })
        .collect::<anyhow::Result<_>>()?;
    let reader = GrowingReader::new(versions);
    let writer = FakeWriter::default();

    until_quiescent(&reader, &writer, false).await?;

    assert_eq!(
        writer.replace_count().await,
        1 + MAX_QUIESCENCE_PASSES as usize,
        "extra passes beyond the first are capped"
    );
    Ok(())
}

#[tokio::test]
async fn each_pass_stamps_a_fresh_synced_at() -> anyhow::Result<()> {
    let v1 = vec![row(1, "2026-07-01 10:00:00")?];
    let v2 = vec![
        row(1, "2026-07-01 10:00:00")?,
        row(2, "2026-07-02 08:00:00")?,
    ];
    let reader = GrowingReader::new(vec![v1, v2]);
    let writer = FakeWriter::default();

    until_quiescent(&reader, &writer, false).await?;

    let stamps = writer.synced_ats().await;
    assert_eq!(stamps.len(), 2);
    assert!(stamps[1] > stamps[0], "the watermark must move forward");
    Ok(())
}

#[tokio::test]
async fn an_empty_tenant_log_refusal_ends_the_loop_immediately() -> anyhow::Result<()> {
    let reader = GrowingReader::new(vec![Vec::new(), vec![row(1, "2026-07-01 10:00:00")?]]);
    let writer = FakeWriter::default();

    let result = run_sync_until_quiescent(
        &reader,
        &writer,
        TENANT,
        ticking_clock("2026-07-29 12:00:00")?,
        false,
    )
    .await;

    assert!(matches!(result, Err(SyncError::EmptyLog(_))));
    assert_eq!(writer.replace_count().await, 0);
    Ok(())
}

#[tokio::test]
async fn an_empty_tenant_log_is_refused_without_writing_anything() -> anyhow::Result<()> {
    let writer = FakeWriter::default();

    let result = run_sync(
        &FakeReader(Vec::new()),
        &writer,
        TENANT,
        parse("2026-07-29 12:00:00")?,
        false,
    )
    .await;

    let Err(SyncError::EmptyLog(msg)) = result else {
        anyhow::bail!("an empty log must be refused");
    };
    assert!(msg.contains("--force"), "{msg}");
    assert_eq!(writer.replace_count().await, 0);
    Ok(())
}

#[tokio::test]
async fn force_empties_the_partition_of_a_tenant_with_no_rows() -> anyhow::Result<()> {
    let writer = FakeWriter::default();

    let summary = run_sync(
        &FakeReader(Vec::new()),
        &writer,
        TENANT,
        parse("2026-07-29 12:00:00")?,
        true,
    )
    .await
    .map_err(into_anyhow)?;

    assert_eq!(summary.rows, 0);
    assert_eq!(summary.max_id, None);
    assert_eq!(summary.max_created_at, None);
    assert_eq!(writer.last().await.map(|(rows, _)| rows), Some(0));
    Ok(())
}

#[tokio::test]
async fn summarizes_rows_and_watermarks() -> anyhow::Result<()> {
    let reader = FakeReader(vec![
        row(7, "2026-07-01 10:00:00")?,
        row(3, "2026-07-20 09:30:00")?,
    ]);
    let writer = FakeWriter::default();
    let now = parse("2026-07-29 12:00:00")?;

    let summary = run_sync(&reader, &writer, TENANT, now, false)
        .await
        .map_err(into_anyhow)?;

    assert_eq!(summary.rows, 2);
    assert_eq!(summary.max_id, Some(7));
    assert_eq!(
        summary.max_created_at.as_deref(),
        Some("2026-07-20T09:30:00.000000")
    );
    assert_eq!(summary.synced_at, "2026-07-29T12:00:00.000000");
    assert_eq!(writer.last().await, Some((2, now)));
    Ok(())
}

#[tokio::test]
async fn a_sync_reads_and_replaces_only_its_own_tenant() -> anyhow::Result<()> {
    let reader = FakeReader(vec![
        row_of(TENANT, 1, "2026-07-01 10:00:00")?,
        row_of(OTHER, 2, "2026-07-01 10:00:00")?,
        row_of(OTHER, 3, "2026-07-01 10:00:00")?,
    ]);
    let writer = FakeWriter::default();

    let summary = run_sync(
        &reader,
        &writer,
        OTHER,
        parse("2026-07-29 12:00:00")?,
        false,
    )
    .await
    .map_err(into_anyhow)?;

    assert_eq!(summary.rows, 2);
    assert_eq!(writer.replaced_tenants().await, vec![OTHER]);
    Ok(())
}

#[tokio::test]
async fn an_empty_log_is_refused_before_any_tenant_runs() -> anyhow::Result<()> {
    let refused = tenants_to_sync(&FakeReader(Vec::new()), false).await;
    let forced = tenants_to_sync(&FakeReader(Vec::new()), true).await;

    assert!(matches!(refused, Err(SyncError::EmptyLog(_))));
    assert!(matches!(forced, Ok(ref t) if t.is_empty()));
    Ok(())
}

#[tokio::test]
async fn a_stale_layout_is_republished_whole_once() -> anyhow::Result<()> {
    let reader = FakeReader(vec![
        row_of(TENANT, 1, "2026-07-01 10:00:00")?,
        row_of(OTHER, 2, "2026-07-01 10:00:00")?,
    ]);
    let writer = FakeWriter::default().stale().await;
    let now = parse("2026-07-29 12:00:00")?;

    let first = publish_layout(&reader, &writer, now)
        .await
        .map_err(into_anyhow)?;
    let second = publish_layout(&reader, &writer, now)
        .await
        .map_err(into_anyhow)?;

    assert_eq!(first, LayoutChange::Republished { rows: 2 });
    assert_eq!(second, LayoutChange::Kept);
    assert_eq!(*writer.full_publishes.lock().await, vec![2]);
    Ok(())
}

#[tokio::test]
async fn a_failed_tenant_does_not_stop_the_others() -> anyhow::Result<()> {
    let reader = FakeReader(vec![
        row_of(TENANT, 1, "2026-07-01 10:00:00")?,
        row_of(OTHER, 2, "2026-07-01 10:00:00")?,
    ]);
    let writer = FakeWriter::default().failing_for(TENANT);
    let journal = FakeJournal::default();

    let reports = sync_tenants(
        &reader,
        &writer,
        &journal,
        &[TENANT, OTHER],
        ticking_clock("2026-07-29 12:00:00")?,
        false,
        TIMEOUT,
    )
    .await;

    assert!(matches!(reports[0].result, TenantResult::Failed(_)));
    assert!(matches!(
        reports[1].result,
        TenantResult::Synced(SyncOutcome::Published(_))
    ));
    assert_eq!(writer.replaced_tenants().await, vec![OTHER]);
    assert_eq!(
        *journal.closed.lock().await,
        vec![(TENANT, "failed"), (OTHER, "completed")],
        "each tenant records its own operation"
    );
    Ok(())
}
