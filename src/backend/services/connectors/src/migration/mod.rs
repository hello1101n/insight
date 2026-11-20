pub(crate) mod m20261110_000001_connector_schedules;

mod m20261120_000001_ingestion_runs;
mod m20261120_000002_ingestion_readiness;
mod m20261120_000003_source_resources;

use sea_orm_migration::prelude::*;

#[derive(Debug)]
pub(crate) struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20261110_000001_connector_schedules::Migration),
            Box::new(m20261120_000001_ingestion_runs::Migration),
            Box::new(m20261120_000002_ingestion_readiness::Migration),
            Box::new(m20261120_000003_source_resources::Migration),
        ]
    }
}

pub(crate) const REQUIRED_CHECKS_BY_TABLE: &[(&str, &[&str])] = &[(
    "connector_schedules",
    m20261110_000001_connector_schedules::REQUIRED_CHECKS,
)];
