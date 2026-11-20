use sea_orm_migration::prelude::*;

#[derive(Debug, DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for ddl in [
            "CREATE TABLE IF NOT EXISTS ingestion_stands (
                stand VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY
            ) ENGINE=InnoDB",
            "CREATE TABLE IF NOT EXISTS ingestion_runs (
                sync_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
                stand VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                tenant VARCHAR(64) NOT NULL, connector VARCHAR(64) NOT NULL, source_id VARCHAR(64) NOT NULL,
                workflow_name VARCHAR(253) NOT NULL, started_at DATETIME(3) NOT NULL,
                finished_at DATETIME(3), status VARCHAR(32),
                INDEX instance_runs(stand,tenant,connector,source_id,started_at),
                INDEX successful_runs(stand,tenant,connector,source_id,status,started_at)
            ) ENGINE=InnoDB",
            "CREATE TABLE IF NOT EXISTS ingestion_stage_attempts (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                stand VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                sync_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                stage VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, attempt INT UNSIGNED NOT NULL,
                decision VARCHAR(16) NOT NULL, status VARCHAR(32) NOT NULL,
                queued_at DATETIME(3) NOT NULL, granted_at DATETIME(3), started_at DATETIME(3), finished_at DATETIME(3),
                connection_id VARCHAR(64), airbyte_job_id VARCHAR(64), airbyte_claimed BOOLEAN NOT NULL DEFAULT FALSE,
                estimated_bytes BIGINT UNSIGNED NOT NULL, cold BOOLEAN NOT NULL, input_volume_bytes BIGINT UNSIGNED,
                bronze_replay_safe BOOLEAN NOT NULL DEFAULT FALSE, retry_allowed BOOLEAN NOT NULL DEFAULT FALSE,
                pod_cpu INT UNSIGNED NOT NULL, pod_memory BIGINT UNSIGNED NOT NULL,
                pod_cpu_millis BIGINT UNSIGNED,pod_peak_bytes BIGINT UNSIGNED,
                source_cpu_millis BIGINT UNSIGNED,source_peak_bytes BIGINT UNSIGNED,
                peak_bytes BIGINT UNSIGNED, volume_bytes BIGINT UNSIGNED, cpu_millis BIGINT UNSIGNED,
                records_reported BIGINT UNSIGNED, reason VARCHAR(255),
                UNIQUE KEY stage_key(sync_id,stage,attempt), UNIQUE KEY airbyte_job(stand,airbyte_job_id),
                FOREIGN KEY (sync_id) REFERENCES ingestion_runs(sync_id), INDEX queue(status,queued_at,id)
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
