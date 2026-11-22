use sea_orm_migration::prelude::*;

const CREATE: &str = "CREATE TABLE IF NOT EXISTS sql_api_tokens (
    id BINARY(16) NOT NULL PRIMARY KEY,
    insight_tenant_id BINARY(16) NOT NULL,
    token_hash BINARY(32) NOT NULL,
    person_id BINARY(16) NOT NULL,
    label VARCHAR(255) NOT NULL,
    created_by BINARY(16) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    UNIQUE KEY uq_sql_api_tokens_hash (token_hash),
    KEY idx_sql_api_tokens_tenant_created (insight_tenant_id, created_at)
)";

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(CREATE).await?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom("we have only forward migrations".to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::CREATE;
    use crate::migration::sql_token_schema;

    #[test]
    fn the_label_column_holds_the_label_budget() {
        let column = format!("label VARCHAR({})", sql_token_schema::LABEL_CHARS);

        assert!(CREATE.contains(&column), "missing `{column}` in {CREATE}");
    }
}
