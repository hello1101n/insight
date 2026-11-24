use sea_orm_migration::prelude::*;

#[derive(Debug, DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE ingestion_stage_attempts
                ADD COLUMN IF NOT EXISTS query_memory_settled BOOLEAN NOT NULL DEFAULT FALSE,
                ADD INDEX IF NOT EXISTS pending_query_memory (query_memory_settled, finished_at)",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, _: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom("we have only forward migrations".to_owned()))
    }
}
