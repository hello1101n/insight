use sea_orm_migration::prelude::*;

#[derive(Debug, DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        change_foreign_key(
            manager,
            "ingestion_stage_attempts_ibfk_1",
            "ingestion_stage_attempt_run",
            " ON DELETE CASCADE",
        )
        .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        change_foreign_key(
            manager,
            "ingestion_stage_attempt_run",
            "ingestion_stage_attempts_ibfk_1",
            "",
        )
        .await
    }
}

async fn change_foreign_key(
    manager: &SchemaManager<'_>,
    previous: &str,
    current: &str,
    action: &str,
) -> Result<(), DbErr> {
    manager
        .get_connection()
        .execute_unprepared(&format!(
            "ALTER TABLE ingestion_stage_attempts
                DROP FOREIGN KEY IF EXISTS {previous},
                ADD CONSTRAINT {current}
                    FOREIGN KEY IF NOT EXISTS (sync_id) REFERENCES ingestion_runs (sync_id){action}"
        ))
        .await?;
    Ok(())
}
