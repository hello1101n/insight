use sea_orm_migration::prelude::*;

#[derive(Debug, DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE ingestion_stage_attempts
            ADD COLUMN IF NOT EXISTS resource_scope VARCHAR(16) NOT NULL DEFAULT 'pod',
            ADD COLUMN IF NOT EXISTS source_oom_limit_bytes BIGINT UNSIGNED,
            ADD INDEX IF NOT EXISTS ingestion_connection_activity(stand,connection_id,status)",
        )
        .await?;
        db.execute_unprepared(
            "UPDATE ingestion_stage_attempts
            SET pod_cpu=pod_cpu-LEAST(pod_cpu,1000),
                pod_memory=pod_memory-LEAST(pod_memory,2147483648),resource_scope='airbyte_source'
            WHERE stage='bronze' AND resource_scope='pod'",
        )
        .await?;
        Ok(())
    }
    async fn down(&self, _: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom("we have only forward migrations".to_owned()))
    }
}
