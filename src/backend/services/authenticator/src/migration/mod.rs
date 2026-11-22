mod m20261122_000001_sql_api_tokens;
pub(crate) mod sql_token_schema;

use sea_orm_migration::prelude::*;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![Box::new(m20261122_000001_sql_api_tokens::Migration)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_table_is_the_first_migration() {
        let migrations = Migrator::migrations();
        let names: Vec<&str> = migrations.iter().map(|m| m.name()).collect();

        assert_eq!(names, ["m20261122_000001_sql_api_tokens"]);
    }
}
