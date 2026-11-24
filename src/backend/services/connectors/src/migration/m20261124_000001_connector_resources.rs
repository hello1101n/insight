use sea_orm_migration::prelude::*;

#[derive(Debug, DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for ddl in [
            "ALTER TABLE connector_schedules
                ADD COLUMN IF NOT EXISTS resources JSON CHECK (resources IS NULL OR JSON_TYPE(resources) = 'OBJECT'),
                ADD COLUMN IF NOT EXISTS has_schedule_revision BOOLEAN NOT NULL DEFAULT TRUE",
            "CREATE OR REPLACE SQL SECURITY DEFINER VIEW connector_schedule_requests_v2 AS
                SELECT connector, source_id, revision, crons, resources FROM connector_schedules",
        ] {
            manager.get_connection().execute_unprepared(ddl).await?;
        }
        Ok(())
    }

    async fn down(&self, _: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom("we have only forward migrations".to_owned()))
    }
}
