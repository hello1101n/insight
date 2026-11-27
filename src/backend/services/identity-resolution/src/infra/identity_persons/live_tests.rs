// INVARIANT: never `#[ignore]` these; CI runs `cargo test` without `--include-ignored`.

use std::time::Duration;

use super::*;
use crate::domain::sync_service::{
    LayoutChange, PersonsLogReader, SyncJournal, SyncOutcome, TenantResult, publish_layout,
    sync_tenants,
};

type R = anyhow::Result<()>;

const URL_VAR: &str = "INTEGRATION_TESTS_CLICKHOUSE_URL";
const MACRO: &str =
    include_str!("../../../../../../ingestion/dbt/macros/create_identity_persons.sql");
const TIMEOUT: Duration = Duration::from_mins(1);

const UNPARTITIONED: &str = "CREATE TABLE identity.{table} (
    id UInt64, value_type String, insight_source_type String, insight_source_id UUID,
    insight_tenant_id UUID, value_id Nullable(String), value_full_text Nullable(String),
    value Nullable(String), value_effective Nullable(String), person_id UUID,
    author_person_id UUID, reason Nullable(String), created_at DateTime64(6, 'UTC'),
    _synced_at DateTime64(3, 'UTC')
) ENGINE = MergeTree ORDER BY id";

struct Live {
    writer: ClickHouseIdentityPersonsWriter,
}

impl Live {
    fn connect() -> Option<Self> {
        let url = std::env::var(URL_VAR).unwrap_or_default();
        if url.is_empty() {
            eprintln!("skip: set {URL_VAR} to run");
            return None;
        }
        let user = std::env::var("INTEGRATION_TESTS_CLICKHOUSE_USER").unwrap_or_default();
        let password = std::env::var("INTEGRATION_TESTS_CLICKHOUSE_PASSWORD").unwrap_or_default();
        let mut writer =
            ClickHouseIdentityPersonsWriter::connect(&url, &user, &password, Topology::Standalone);
        writer.target = format!("identity_persons_live_{}", Uuid::now_v7().simple());
        Some(Self { writer })
    }

    fn table(&self) -> &str {
        &self.writer.target
    }

    async fn run(&self, sql: &str) -> R {
        self.writer
            .client
            .query(&sql.replace("{table}", self.table()))
            .execute()
            .await?;
        Ok(())
    }

    async fn create_as_dbt_does(&self) -> R {
        let start = MACRO
            .find("CREATE TABLE")
            .ok_or_else(|| anyhow::anyhow!("no CREATE"))?;
        let end = MACRO[start..]
            .find("\")")
            .ok_or_else(|| anyhow::anyhow!("no end of the CREATE"))?;
        let ddl = MACRO[start..start + end]
            .replace(
                "identity.identity_persons",
                &format!("identity.{}", self.table()),
            )
            .replace("\" ~ engine ~ \"", "MergeTree");
        self.run(&ddl).await
    }

    async fn partition_dump(&self, tenant: Uuid) -> anyhow::Result<(String, Vec<String>)> {
        let rows: String = self
            .writer
            .client
            .query(&format!(
                "SELECT arrayStringConcat(groupArray(formatRow('TSV', *)), '') \
                 FROM (SELECT * FROM identity.`{}` WHERE insight_tenant_id = ? ORDER BY id)",
                self.table()
            ))
            .bind(tenant)
            .fetch_one()
            .await?;
        let parts: Vec<String> = self
            .writer
            .client
            .query(
                "SELECT name FROM system.parts \
                 WHERE database = 'identity' AND table = ? AND active AND partition = ? \
                 ORDER BY name",
            )
            .bind(self.table())
            .bind(tenant.to_string())
            .fetch_all()
            .await?;
        Ok((rows, parts))
    }

    async fn ids(&self, tenant: Uuid) -> anyhow::Result<Vec<u64>> {
        Ok(self
            .writer
            .client
            .query(&format!(
                "SELECT id FROM identity.`{}` WHERE insight_tenant_id = ? ORDER BY id",
                self.table()
            ))
            .bind(tenant)
            .fetch_all()
            .await?)
    }

    async fn drop(self) -> R {
        self.run("DROP TABLE IF EXISTS identity.{table}").await
    }
}

fn row(tenant: Uuid, id: u64) -> PersonsLogRow {
    PersonsLogRow {
        id,
        value_type: "email".to_owned(),
        insight_source_type: "bamboohr".to_owned(),
        insight_source_id: Uuid::from_u128(1),
        insight_tenant_id: tenant,
        value_id: Some(format!("user{id}@example.com")),
        value_full_text: None,
        value: None,
        value_effective: Some(format!("user{id}@example.com")),
        person_id: Uuid::from_u128(u128::from(id)),
        author_person_id: Uuid::nil(),
        reason: None,
        created_at: chrono::DateTime::UNIX_EPOCH.naive_utc(),
    }
}

fn now() -> DateTime {
    Utc::now().naive_utc()
}

struct Log {
    rows: Vec<PersonsLogRow>,
    unreadable: Option<Uuid>,
}

#[async_trait]
impl PersonsLogReader for Log {
    async fn tenants(&self) -> anyhow::Result<Vec<Uuid>> {
        let mut tenants: Vec<Uuid> = self.rows.iter().map(|r| r.insight_tenant_id).collect();
        tenants.sort_unstable();
        tenants.dedup();
        Ok(tenants)
    }
    async fn read_all(&self) -> anyhow::Result<Vec<PersonsLogRow>> {
        Ok(self.rows.clone())
    }
    async fn read_tenant(&self, tenant: Uuid) -> anyhow::Result<Vec<PersonsLogRow>> {
        anyhow::ensure!(
            self.unreadable != Some(tenant),
            "the log of the tenant is unreadable"
        );
        Ok(self
            .rows
            .iter()
            .filter(|r| r.insight_tenant_id == tenant)
            .cloned()
            .collect())
    }
    async fn latest_id(&self, tenant: Uuid) -> anyhow::Result<Option<u64>> {
        Ok(self
            .rows
            .iter()
            .filter(|r| r.insight_tenant_id == tenant)
            .map(|r| r.id)
            .max())
    }
}

struct NoJournal;

#[async_trait]
impl SyncJournal for NoJournal {
    async fn open(&self, _: Uuid) -> anyhow::Result<Uuid> {
        Ok(Uuid::now_v7())
    }
    async fn close(&self, _: Uuid, _: Uuid, _: &TenantResult) {}
}

#[tokio::test]
async fn the_table_dbt_creates_takes_a_partition_replace() -> R {
    let Some(live) = Live::connect() else {
        return Ok(());
    };
    live.create_as_dbt_does().await?;

    let layout = live.writer.layout().await?;

    live.drop().await?;
    assert_eq!(layout, Layout::Partitioned);
    Ok(())
}

#[tokio::test]
async fn a_tenant_sync_leaves_the_other_partition_byte_identical() -> R {
    let Some(live) = Live::connect() else {
        return Ok(());
    };
    live.create_as_dbt_does().await?;
    let (a, b) = (Uuid::now_v7(), Uuid::now_v7());
    live.writer
        .replace_tenant(a, &[row(a, 1), row(a, 2)], now())
        .await?;
    live.writer.replace_tenant(b, &[row(b, 3)], now()).await?;
    let before = live.partition_dump(b).await?;

    live.writer
        .replace_tenant(a, &[row(a, 1), row(a, 2), row(a, 4)], now())
        .await?;

    let after = live.partition_dump(b).await?;
    let a_ids = live.ids(a).await?;
    live.drop().await?;
    assert_eq!(a_ids, vec![1, 2, 4], "the changed tenant republishes");
    assert!(!before.1.is_empty(), "the other tenant must hold a part");
    assert_eq!(
        after, before,
        "the other partition keeps its rows and its parts"
    );
    Ok(())
}

#[tokio::test]
async fn a_failed_tenant_keeps_its_partition_and_the_other_publishes() -> R {
    let Some(live) = Live::connect() else {
        return Ok(());
    };
    live.create_as_dbt_does().await?;
    let (a, b) = (Uuid::now_v7(), Uuid::now_v7());
    live.writer.replace_tenant(a, &[row(a, 1)], now()).await?;
    let before = live.partition_dump(a).await?;
    let log = Log {
        rows: vec![row(a, 1), row(a, 2), row(b, 3)],
        unreadable: Some(a),
    };

    let reports = sync_tenants(&log, &live.writer, &NoJournal, &[a, b], now, false, TIMEOUT).await;

    let after = live.partition_dump(a).await?;
    let b_ids = live.ids(b).await?;
    live.drop().await?;
    assert!(matches!(reports[0].result, TenantResult::Failed(_)));
    assert!(matches!(
        reports[1].result,
        TenantResult::Synced(SyncOutcome::Published(_))
    ));
    assert_eq!(after, before, "the failed tenant keeps its partition");
    assert_eq!(b_ids, vec![3], "the other tenant publishes");
    Ok(())
}

#[tokio::test]
async fn an_unpartitioned_table_is_republished_whole_then_replaced_by_partition() -> R {
    let Some(live) = Live::connect() else {
        return Ok(());
    };
    live.run(UNPARTITIONED).await?;
    let (a, b) = (Uuid::now_v7(), Uuid::now_v7());
    let log = Log {
        rows: vec![row(a, 1), row(b, 2)],
        unreadable: None,
    };

    let stale = live.writer.layout().await?;
    let change = publish_layout(&log, &live.writer, now())
        .await
        .map_err(|_| anyhow::anyhow!("the layout publish failed"))?;
    let upgraded = live.writer.layout().await?;
    live.writer
        .replace_tenant(a, &[row(a, 1), row(a, 5)], now())
        .await?;

    let a_ids = live.ids(a).await?;
    let b_ids = live.ids(b).await?;
    live.drop().await?;
    assert_eq!(stale, Layout::Stale);
    assert_eq!(change, LayoutChange::Republished { rows: 2 });
    assert_eq!(upgraded, Layout::Partitioned);
    assert_eq!((a_ids, b_ids), (vec![1, 5], vec![2]));
    Ok(())
}

#[tokio::test]
async fn a_missing_table_is_created_by_the_layout_publish() -> R {
    let Some(live) = Live::connect() else {
        return Ok(());
    };
    let a = Uuid::now_v7();
    let log = Log {
        rows: vec![row(a, 1)],
        unreadable: None,
    };

    publish_layout(&log, &live.writer, now())
        .await
        .map_err(|_| anyhow::anyhow!("the layout publish failed"))?;

    let layout = live.writer.layout().await?;
    let ids = live.ids(a).await?;
    live.drop().await?;
    assert_eq!(layout, Layout::Partitioned);
    assert_eq!(ids, vec![1]);
    Ok(())
}
