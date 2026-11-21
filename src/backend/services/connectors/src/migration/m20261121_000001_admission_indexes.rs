use sea_orm_migration::prelude::*;

#[derive(Debug, DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE ingestion_runs
            ADD INDEX IF NOT EXISTS ingestion_unfinished_runs(stand,status,sync_id)",
        )
        .await?;
        db.execute_unprepared(
            "ALTER TABLE ingestion_stage_attempts
            ADD INDEX IF NOT EXISTS ingestion_queue_head(stand,status,queued_at,id),
            ADD INDEX IF NOT EXISTS ingestion_active(stand,finished_at,granted_at)",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, _: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom("we have only forward migrations".into()))
    }
}
