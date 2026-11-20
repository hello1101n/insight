use sea_orm_migration::prelude::*;

#[derive(Debug, DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE ingestion_runs
            ADD COLUMN IF NOT EXISTS ready_at DATETIME(3),
            ADD COLUMN IF NOT EXISTS mode_signature CHAR(64) CHARACTER SET ascii COLLATE ascii_bin",
        )
        .await?;
        db.execute_unprepared(
            "UPDATE ingestion_runs r JOIN ingestion_stage_attempts s ON s.sync_id=r.sync_id
            SET r.ready_at=s.finished_at WHERE r.ready_at IS NULL AND s.status='succeeded'
            AND s.stage=IF(r.connector='jira','transform-jira-silver','transform-legacy')",
        )
        .await?;
        Ok(())
    }
    async fn down(&self, _: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom("we have only forward migrations".to_owned()))
    }
}
