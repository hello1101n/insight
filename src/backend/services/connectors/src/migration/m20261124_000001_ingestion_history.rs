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
                tenant VARCHAR(64) NOT NULL,
                connector VARCHAR(64) NOT NULL,
                source_id VARCHAR(64) NOT NULL,
                workflow_name VARCHAR(253) NOT NULL,
                started_at DATETIME(3) NOT NULL,
                execution DATETIME(3) NOT NULL,
                finished_at DATETIME(3),
                ready_at DATETIME(3),
                status VARCHAR(32)
            ) ENGINE=InnoDB",
            "ALTER TABLE ingestion_runs
                ADD INDEX IF NOT EXISTS instance_runs (stand, tenant, connector, source_id, started_at),
                ADD INDEX IF NOT EXISTS active_runs (stand, finished_at)",
            "CREATE TABLE IF NOT EXISTS ingestion_stage_attempts (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                sync_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                stage VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                attempt INT UNSIGNED NOT NULL,
                status VARCHAR(32) NOT NULL,
                queued_at DATETIME(3) NOT NULL,
                started_at DATETIME(3),
                finished_at DATETIME(3),
                waits JSON NOT NULL,
                connection_id VARCHAR(64),
                airbyte_job_id VARCHAR(64),
                records_reported BIGINT UNSIGNED,
                reason VARCHAR(255),
                query_pod CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
                execution_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
            ) ENGINE=InnoDB",
            "ALTER TABLE ingestion_stage_attempts
                ADD COLUMN IF NOT EXISTS resources JSON,
                ADD COLUMN IF NOT EXISTS peak_query_memory_bytes BIGINT UNSIGNED,
                ADD COLUMN IF NOT EXISTS query_memory_settled BOOLEAN NOT NULL DEFAULT FALSE,
                ADD UNIQUE INDEX IF NOT EXISTS stage_key (sync_id, stage, execution_key),
                ADD UNIQUE INDEX IF NOT EXISTS stage_attempt (sync_id, stage, attempt),
                ADD INDEX IF NOT EXISTS recent_stage_status (status, finished_at),
                ADD INDEX IF NOT EXISTS pending_query_memory (query_memory_settled, finished_at),
                ADD CONSTRAINT ingestion_stage_attempts_ibfk_1
                    FOREIGN KEY IF NOT EXISTS (sync_id) REFERENCES ingestion_runs (sync_id)",
            "ALTER TABLE connector_schedules
                ADD COLUMN IF NOT EXISTS resources JSON CHECK (resources IS NULL OR JSON_TYPE(resources) = 'OBJECT'),
                ADD COLUMN IF NOT EXISTS has_schedule_revision BOOLEAN NOT NULL DEFAULT TRUE",
            "CREATE SQL SECURITY DEFINER VIEW IF NOT EXISTS connector_schedule_requests_v2 AS
                SELECT connector, source_id, revision, crons, resources FROM connector_schedules",
        ] {
            manager.get_connection().execute_unprepared(ddl).await?;
        }

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for ddl in [
            "DROP VIEW IF EXISTS connector_schedule_requests_v2",
            "ALTER TABLE connector_schedules
                DROP COLUMN IF EXISTS resources,
                DROP COLUMN IF EXISTS has_schedule_revision",
            "DROP TABLE IF EXISTS ingestion_stage_attempts",
            "DROP TABLE IF EXISTS ingestion_runs",
        ] {
            manager.get_connection().execute_unprepared(ddl).await?;
        }

        Ok(())
    }
}
