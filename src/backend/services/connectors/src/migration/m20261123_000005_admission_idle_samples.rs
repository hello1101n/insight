use sea_orm_migration::prelude::*;

#[derive(Debug, DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE ingestion_stands ADD COLUMN IF NOT EXISTS last_stage_release_at DATETIME(3) NULL",
        )
        .await?;
        db.execute_unprepared(
            "CREATE TABLE IF NOT EXISTS ingestion_idle_memory_samples (
                stand VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                sampled_at DATETIME(3) NOT NULL,
                node VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                used_bytes BIGINT UNSIGNED NOT NULL,
                PRIMARY KEY (stand,sampled_at,node)
            ) ENGINE=InnoDB",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, _: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom("we have only forward migrations".to_owned()))
    }
}
