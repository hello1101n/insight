use sea_orm_migration::prelude::*;

#[derive(Debug, DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for ddl in [
            "CREATE TABLE IF NOT EXISTS ingestion_runs (
                sync_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
                stand VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                tenant VARCHAR(64) NOT NULL, connector VARCHAR(64) NOT NULL, source_id VARCHAR(64) NOT NULL,
                workflow_name VARCHAR(253) NOT NULL, started_at DATETIME(3) NOT NULL,
                execution DATETIME(3) NOT NULL, finished_at DATETIME(3), ready_at DATETIME(3), status VARCHAR(32),
                INDEX instance_runs(stand,tenant,connector,source_id,started_at),
                INDEX active_runs(stand,finished_at)
            ) ENGINE=InnoDB",
            "CREATE TABLE IF NOT EXISTS ingestion_stage_attempts (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                sync_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                stage VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                attempt INT UNSIGNED NOT NULL, status VARCHAR(32) NOT NULL,
                queued_at DATETIME(3) NOT NULL, started_at DATETIME(3), finished_at DATETIME(3),
                waits JSON NOT NULL,
                connection_id VARCHAR(64), airbyte_job_id VARCHAR(64),
                records_reported BIGINT UNSIGNED, reason VARCHAR(255),
                query_pod CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
                execution_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                UNIQUE KEY stage_key(sync_id,stage,execution_key),
                UNIQUE KEY stage_attempt(sync_id,stage,attempt),
                INDEX recent_stage_status(status,finished_at),
                FOREIGN KEY (sync_id) REFERENCES ingestion_runs(sync_id)
            ) ENGINE=InnoDB",
        ] {
            manager.get_connection().execute_unprepared(ddl).await?;
        }
        Ok(())
    }

    async fn down(&self, _: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom("we have only forward migrations".to_owned()))
    }
}
