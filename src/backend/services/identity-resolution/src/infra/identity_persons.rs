use std::collections::BTreeMap;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use clickhouse::Row;
use insight_clickhouse::{
    Client, Config, Ddl, Error as ChError, InactiveReplicasPending, ReplicaNotInQuorum, TableSpec,
    Topology,
};
use sea_orm::prelude::DateTime;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::domain::sync_service::{IdentityPersonsWriter, Layout, PersonsLogRow};

const WRITE_TIMEOUT: Duration = Duration::from_mins(5);

const DATABASE: &str = "identity";
const TARGET: &str = "identity_persons";
const STAGING_PREFIX: &str = "identity_persons_staging_";
const STAGING_GC_AGE_SECONDS: u32 = 3600;
const REPLACE_ATTEMPTS: u32 = 2;

const COLUMNS: [(&str, &str); 14] = [
    ("id", "UInt64"),
    ("value_type", "String"),
    ("insight_source_type", "String"),
    ("insight_source_id", "UUID"),
    ("insight_tenant_id", "UUID"),
    ("value_id", "Nullable(String)"),
    ("value_full_text", "Nullable(String)"),
    ("value", "Nullable(String)"),
    ("value_effective", "Nullable(String)"),
    ("person_id", "UUID"),
    ("author_person_id", "UUID"),
    ("reason", "Nullable(String)"),
    ("created_at", "DateTime64(6, 'UTC')"),
    ("_synced_at", "DateTime64(3, 'UTC')"),
];
const PARTITION_KEY: &str = "insight_tenant_id";
const SORT_KEY: [&str; 2] = ["insight_tenant_id", "id"];

#[derive(Debug, Row, Serialize)]
struct WireRow {
    id: u64,
    value_type: String,
    insight_source_type: String,
    #[serde(with = "clickhouse::serde::uuid")]
    insight_source_id: Uuid,
    #[serde(with = "clickhouse::serde::uuid")]
    insight_tenant_id: Uuid,
    value_id: Option<String>,
    value_full_text: Option<String>,
    value: Option<String>,
    value_effective: Option<String>,
    #[serde(with = "clickhouse::serde::uuid")]
    person_id: Uuid,
    #[serde(with = "clickhouse::serde::uuid")]
    author_person_id: Uuid,
    reason: Option<String>,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    created_at: chrono::DateTime<Utc>,
    #[serde(
        rename = "_synced_at",
        with = "clickhouse::serde::chrono::datetime64::millis"
    )]
    synced_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Row, Deserialize)]
struct TableKeys {
    partition_key: String,
    sorting_key: String,
}

#[derive(Debug, Row, Deserialize)]
struct TableColumn {
    name: String,
    #[serde(rename = "type")]
    data_type: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Target {
    Published,
    Absent,
}

fn staging_spec(staging: &str) -> Ddl {
    Ddl::create_table(
        TableSpec::merge_tree(DATABASE, staging, &COLUMNS, &SORT_KEY).partition_by(PARTITION_KEY),
    )
}

fn swap_ddl(staging: &str, target: &str, state: Target) -> Ddl {
    match state {
        Target::Published => Ddl::exchange_tables(DATABASE, staging, target),
        Target::Absent => Ddl::rename_table(DATABASE, staging, target),
    }
}

fn layout_of(keys: &TableKeys, columns: &[TableColumn]) -> Layout {
    let same_keys = keys.partition_key == PARTITION_KEY && keys.sorting_key == SORT_KEY.join(", ");
    let same_columns = columns.len() == COLUMNS.len()
        && columns
            .iter()
            .zip(COLUMNS)
            .all(|(found, (name, data_type))| found.name == name && found.data_type == data_type);
    if same_keys && same_columns {
        Layout::Partitioned
    } else {
        Layout::Stale
    }
}

pub struct ClickHouseIdentityPersonsWriter {
    client: Client,
    target: String,
}

impl ClickHouseIdentityPersonsWriter {
    #[must_use]
    pub fn new(client: Client) -> Self {
        Self {
            client,
            target: TARGET.to_owned(),
        }
    }

    #[must_use]
    pub fn connect(url: &str, user: &str, password: &str, topology: Topology) -> Self {
        let mut config = Config::new(url, DATABASE)
            .with_query_timeout(WRITE_TIMEOUT)
            .with_topology(topology);
        if !user.is_empty() {
            config = config.with_auth(user, password);
        }
        Self::new(Client::new(config))
    }

    async fn target_state(&self) -> anyhow::Result<Target> {
        let created: u64 = self
            .client
            .query("SELECT count() FROM system.tables WHERE database = ? AND name = ?")
            .bind(DATABASE)
            .bind(&self.target)
            .fetch_one()
            .await?;
        Ok(if created == 0 {
            Target::Absent
        } else {
            Target::Published
        })
    }

    async fn read_layout(&self) -> anyhow::Result<Layout> {
        let keys: Option<TableKeys> = self
            .client
            .query(
                "SELECT partition_key, sorting_key FROM system.tables \
                 WHERE database = ? AND name = ?",
            )
            .bind(DATABASE)
            .bind(&self.target)
            .fetch_optional()
            .await?;
        let Some(keys) = keys else {
            return Ok(Layout::Stale);
        };

        let columns: Vec<TableColumn> = self
            .client
            .query(
                "SELECT name, type FROM system.columns \
                 WHERE database = ? AND table = ? ORDER BY position",
            )
            .bind(DATABASE)
            .bind(&self.target)
            .fetch_all()
            .await?;
        if layout_of(&keys, &columns) == Layout::Stale {
            return Ok(Layout::Stale);
        }

        // INVARIANT: dbt reads with select_sequential_consistency on a cluster.
        // Code 289 means a stale quorum record.
        let probe = self
            .client
            .consistent_query(&format!("SELECT count() FROM {DATABASE}.`{}`", self.target))
            .fetch_one::<u64>()
            .await;
        match probe {
            Ok(_) => Ok(Layout::Partitioned),
            Err(e) if ReplicaNotInQuorum::from_error(&e).is_some() => {
                tracing::warn!(
                    error = %e,
                    "persons-sync: the quorum record of the live table names a missing part. \
                     The sync publishes a full snapshot"
                );
                Ok(Layout::Stale)
            }
            Err(e) => Err(e.into()),
        }
    }

    async fn guard_watermark(
        &self,
        tenant: Option<Uuid>,
        synced_at: chrono::DateTime<Utc>,
    ) -> anyhow::Result<()> {
        let select = format!(
            "SELECT toUnixTimestamp64Milli(max(_synced_at)) FROM {DATABASE}.`{}`",
            self.target
        );
        let published_ms: i64 = match tenant {
            Some(tenant) => {
                self.client
                    .query(&format!("{select} WHERE insight_tenant_id = ?"))
                    .bind(tenant)
                    .fetch_one()
                    .await?
            }
            None => self.client.query(&select).fetch_one().await?,
        };
        anyhow::ensure!(
            published_ms <= synced_at.timestamp_millis(),
            "a newer snapshot (_synced_at={published_ms}ms) is already published; \
             discarding this run's older snapshot ({}ms)",
            synced_at.timestamp_millis()
        );
        Ok(())
    }

    async fn drop_stale_stagings(&self) {
        let stale: Result<Vec<String>, _> = self
            .client
            .query(
                "SELECT name FROM system.tables \
                 WHERE database = ? AND name LIKE ? \
                   AND metadata_modification_time < now() - INTERVAL ? SECOND",
            )
            .bind(DATABASE)
            .bind(format!("{STAGING_PREFIX}%"))
            .bind(STAGING_GC_AGE_SECONDS)
            .fetch_all()
            .await;
        let stale = match stale {
            Ok(names) => names,
            Err(e) => {
                tracing::warn!(error = %e, "persons-sync: staging GC listing failed (skipped)");
                return;
            }
        };
        for name in stale {
            let Some(suffix) = name.strip_prefix(STAGING_PREFIX) else {
                continue;
            };
            if suffix.len() != 32 || !suffix.bytes().all(|b| b.is_ascii_hexdigit()) {
                continue;
            }
            match self
                .client
                .execute_ddl(&Ddl::drop_table(DATABASE, &name))
                .await
            {
                Ok(()) => tracing::info!(table = %name, "persons-sync: dropped orphaned staging"),
                Err(e) => {
                    tracing::warn!(error = %e, table = %name, "persons-sync: staging GC drop failed");
                }
            }
        }
    }

    async fn fill(
        &self,
        staging: &str,
        rows: &[&PersonsLogRow],
        synced_at: chrono::DateTime<Utc>,
    ) -> anyhow::Result<()> {
        let mut insert = self
            .client
            .insert_on_every_active_replica::<WireRow>(staging)
            .await?;
        for row in rows {
            insert.write(&to_wire_row(row, synced_at)).await?;
        }
        insert.end().await?;

        let count: u64 = self
            .client
            .consistent_query(&format!("SELECT count() FROM {DATABASE}.`{staging}`"))
            .fetch_one()
            .await?;
        let expected = rows.len() as u64;
        anyhow::ensure!(
            count == expected,
            "staging count mismatch: inserted {expected}, staging holds {count}; \
             aborting publish (live table left untouched)"
        );
        Ok(())
    }

    // INVARIANT: a table that readers query never takes a quorum insert. A replace
    // leaves its quorum record stale, and each sequentially consistent read fails.
    async fn replace_partition(
        &self,
        table: &str,
        tenant: Uuid,
        rows: &[&PersonsLogRow],
        synced_at: chrono::DateTime<Utc>,
    ) -> anyhow::Result<()> {
        self.with_staging(async |staging: &str| {
            self.fill(staging, rows, synced_at).await?;

            let replace = Ddl::replace_partition(DATABASE, table, tenant, staging);
            match self.client.execute_ddl(&replace).await {
                Ok(()) => Ok(()),
                Err(ChError::Clickhouse(e))
                    if InactiveReplicasPending::from_error(&e).is_some() =>
                {
                    tracing::warn!(
                        %tenant,
                        error = %e,
                        "persons-sync: the active replicas replaced the partition. The inactive \
                         replicas replace it from the replication log on return"
                    );
                    Ok(())
                }
                Err(e) => Err(e.into()),
            }
        })
        .await
    }

    async fn publish_whole(
        &self,
        table: &str,
        rows: &[PersonsLogRow],
        synced_at: chrono::DateTime<Utc>,
    ) -> anyhow::Result<()> {
        let mut by_tenant: BTreeMap<Uuid, Vec<&PersonsLogRow>> = BTreeMap::new();
        for row in rows {
            by_tenant
                .entry(row.insight_tenant_id)
                .or_default()
                .push(row);
        }
        for (tenant, tenant_rows) in &by_tenant {
            self.replace_partition(table, *tenant, tenant_rows, synced_at)
                .await?;
        }

        let count: u64 = self
            .client
            .consistent_query(&format!("SELECT count() FROM {DATABASE}.`{table}`"))
            .fetch_one()
            .await?;
        let expected = rows.len() as u64;
        anyhow::ensure!(
            count == expected,
            "snapshot count mismatch: published {expected}, the new table holds {count}; \
             aborting swap (live table left untouched)"
        );

        let state = self.target_state().await?;
        match state {
            Target::Published => self.guard_watermark(None, synced_at).await?,
            Target::Absent => {}
        }

        self.client
            .execute_ddl(&swap_ddl(table, &self.target, state))
            .await?;
        Ok(())
    }

    async fn with_staging<F>(&self, publish: F) -> anyhow::Result<()>
    where
        F: AsyncFnOnce(&str) -> anyhow::Result<()>,
    {
        let staging = format!("{STAGING_PREFIX}{}", Uuid::now_v7().simple());

        self.client.execute_ddl(&staging_spec(&staging)).await?;

        let result = publish(&staging).await;

        if let Err(e) = self
            .client
            .execute_ddl(&Ddl::drop_table(DATABASE, &staging))
            .await
        {
            tracing::warn!(error = %e, table = %staging, "persons-sync: dropping own staging failed");
        }
        result
    }

    async fn prepare(&self) -> anyhow::Result<()> {
        self.client.assert_database_topology(DATABASE).await?;
        self.drop_stale_stagings().await;
        Ok(())
    }

    async fn partition_count(&self, tenant: Uuid) -> anyhow::Result<u64> {
        Ok(self
            .client
            .query(&format!(
                "SELECT count() FROM {DATABASE}.`{}` WHERE insight_tenant_id = ?",
                self.target
            ))
            .bind(tenant)
            .fetch_one()
            .await?)
    }

    async fn probe_published_max_id(&self, tenant: Uuid) -> anyhow::Result<Option<u64>> {
        let probed: Result<Vec<Option<u64>>, _> = self
            .client
            .query(&format!(
                "SELECT if(count() = 0, NULL, max(id)) FROM {DATABASE}.`{}` \
                 WHERE insight_tenant_id = ?",
                self.target
            ))
            .bind(tenant)
            .fetch_all()
            .await;
        match probed {
            Ok(rows) => Ok(rows.into_iter().next().flatten()),
            Err(e) => {
                tracing::warn!(error = %e, "identity_persons probe failed; publishing");
                Ok(None)
            }
        }
    }
}

#[async_trait]
impl IdentityPersonsWriter for ClickHouseIdentityPersonsWriter {
    async fn layout(&self) -> anyhow::Result<Layout> {
        self.read_layout().await
    }

    async fn replace_all(&self, rows: &[PersonsLogRow], synced_at: DateTime) -> anyhow::Result<()> {
        let synced_at = synced_at.and_utc();
        self.prepare().await?;
        self.with_staging(async |table: &str| self.publish_whole(table, rows, synced_at).await)
            .await
    }

    async fn replace_tenant(
        &self,
        tenant: Uuid,
        rows: &[PersonsLogRow],
        synced_at: DateTime,
    ) -> anyhow::Result<()> {
        // SAFETY: a row of another tenant would vanish and the count check would pass.
        anyhow::ensure!(
            rows.iter().all(|r| r.insight_tenant_id == tenant),
            "persons-sync: the rows of tenant {tenant} include rows of another tenant"
        );
        let synced_at = synced_at.and_utc();
        let rows: Vec<&PersonsLogRow> = rows.iter().collect();
        self.prepare().await?;
        self.guard_watermark(Some(tenant), synced_at).await?;

        // INVARIANT: a replica that returned during the insert can replace
        // from incomplete staging parts.
        let mut published = 0;
        for _ in 0..REPLACE_ATTEMPTS {
            self.replace_partition(&self.target, tenant, &rows, synced_at)
                .await?;
            published = self.partition_count(tenant).await?;
            if published == rows.len() as u64 {
                return Ok(());
            }
        }
        anyhow::bail!(
            "partition count mismatch for tenant {tenant}: replaced with {} rows, \
             the partition holds {published}",
            rows.len()
        )
    }

    async fn published_max_id(&self, tenant: Uuid) -> anyhow::Result<Option<u64>> {
        self.probe_published_max_id(tenant).await
    }
}

fn to_wire_row(r: &PersonsLogRow, synced_at: chrono::DateTime<Utc>) -> WireRow {
    WireRow {
        id: r.id,
        value_type: r.value_type.clone(),
        insight_source_type: r.insight_source_type.clone(),
        insight_source_id: r.insight_source_id,
        insight_tenant_id: r.insight_tenant_id,
        value_id: r.value_id.clone(),
        value_full_text: r.value_full_text.clone(),
        value: r.value.clone(),
        value_effective: r.value_effective.clone(),
        person_id: r.person_id,
        author_person_id: r.author_person_id,
        reason: r.reason.clone(),
        // MariaDB `TIMESTAMP(6)` comes back naive; the pool session runs in
        // UTC, so re-attaching Utc is a re-labeling, not a conversion.
        created_at: r.created_at.and_utc(),
        synced_at,
    }
}

#[cfg(test)]
mod live_tests;
#[cfg(test)]
mod tests;
