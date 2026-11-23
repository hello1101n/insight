use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sea_orm::{ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbErr};

use super::{TERMINAL, locked, sql};

pub(in crate::domain::admission) type IdleMemory = HashMap<String, u64>;

pub(super) async fn record_release(tx: &DatabaseTransaction, stand: &str) -> Result<(), DbErr> {
    tx.execute_raw(sql(
        "UPDATE ingestion_stands SET last_stage_release_at=UTC_TIMESTAMP(3) WHERE stand=?",
        vec![stand.into()],
    ))
    .await?;
    Ok(())
}

pub(in crate::domain::admission) async fn settled_at(
    db: &impl ConnectionTrait,
    stand: &str,
    settle_secs: u32,
    sampled_at: Option<DateTime<Utc>>,
) -> Result<Option<DateTime<Utc>>, DbErr> {
    db.query_one_raw(sql(
        format!(
            "SELECT UTC_TIMESTAMP(3) AS sampled_at
            WHERE NOT EXISTS (
                SELECT 1 FROM ingestion_stage_attempts
                WHERE stand=? AND granted_at IS NOT NULL AND finished_at IS NULL
                AND status NOT IN ({TERMINAL})
            ) AND COALESCE(
                (SELECT last_stage_release_at FROM ingestion_stands WHERE stand=?),
                (SELECT MAX(finished_at) FROM ingestion_stage_attempts
                 WHERE stand=? AND granted_at IS NOT NULL),
                CAST('1970-01-01' AS DATETIME)
            ) <= TIMESTAMPADD(SECOND, -CAST(? AS SIGNED), COALESCE(?,UTC_TIMESTAMP(3)))"
        ),
        vec![
            stand.into(),
            stand.into(),
            stand.into(),
            settle_secs.into(),
            sampled_at.into(),
        ],
    ))
    .await?
    .map(|row| row.try_get("", "sampled_at"))
    .transpose()
}

pub(in crate::domain::admission) async fn save(
    db: &DatabaseConnection,
    stand: &str,
    sampled_at: DateTime<Utc>,
    settle_secs: u32,
    window_secs: u32,
    memory: &IdleMemory,
) -> anyhow::Result<()> {
    let tx = locked(db, stand).await?;
    if settled_at(&tx, stand, settle_secs, Some(sampled_at))
        .await?
        .is_some()
    {
        for (node, bytes) in memory {
            tx.execute_raw(sql(
                "INSERT INTO ingestion_idle_memory_samples(stand,sampled_at,node,used_bytes)
                 VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE used_bytes=LEAST(used_bytes,VALUES(used_bytes))",
                vec![stand.into(), sampled_at.into(), node.clone().into(), (*bytes).into()],
            ))
            .await?;
        }
        tx.execute_raw(sql(
            "DELETE FROM ingestion_idle_memory_samples WHERE stand=?
             AND sampled_at<TIMESTAMPADD(SECOND,-CAST(? AS SIGNED),?)",
            vec![stand.into(), window_secs.into(), sampled_at.into()],
        ))
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub(in crate::domain::admission) async fn baseline(
    db: &DatabaseConnection,
    stand: &str,
    window_secs: u32,
    max_age_secs: u32,
) -> Result<IdleMemory, DbErr> {
    let age_secs = window_secs.min(max_age_secs);
    let rows = db
        .query_all_raw(sql(
            "SELECT node, MIN(used_bytes) AS used_bytes FROM ingestion_idle_memory_samples
             WHERE stand=?
             AND sampled_at>=TIMESTAMPADD(SECOND,-CAST(? AS SIGNED),UTC_TIMESTAMP(3))
             GROUP BY node",
            vec![stand.into(), age_secs.into()],
        ))
        .await?;
    rows.into_iter()
        .map(|r| Ok((r.try_get("", "node")?, r.try_get("", "used_bytes")?)))
        .collect()
}
