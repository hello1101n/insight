pub(crate) mod m20261110_000001_connector_schedules;

mod m20261120_000001_ingestion_runs;
mod m20261124_000001_connector_resources;
mod m20261124_000002_stage_resources;
mod m20261124_000003_settle_stage_query_memory;

use sea_orm_migration::prelude::*;

#[derive(Debug)]
pub(crate) struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20261110_000001_connector_schedules::Migration),
            Box::new(m20261120_000001_ingestion_runs::Migration),
            Box::new(m20261124_000001_connector_resources::Migration),
            Box::new(m20261124_000002_stage_resources::Migration),
            Box::new(m20261124_000003_settle_stage_query_memory::Migration),
        ]
    }
}

pub(crate) const REQUIRED_CHECKS_BY_TABLE: &[(&str, &[&str])] = &[(
    "connector_schedules",
    m20261110_000001_connector_schedules::REQUIRED_CHECKS,
)];
