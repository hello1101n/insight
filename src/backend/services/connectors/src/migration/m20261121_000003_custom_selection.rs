use sea_orm_migration::prelude::*;

#[derive(Debug, DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("ALTER TABLE ingestion_stage_attempts ADD COLUMN IF NOT EXISTS custom_selection BOOLEAN NULL").await?;
        Ok(())
    }
    async fn down(&self, _: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom("we have only forward migrations".to_owned()))
    }
}
