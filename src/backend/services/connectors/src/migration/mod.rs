pub(crate) mod m20261110_000001_connector_schedules;

mod m20261120_000001_ingestion_runs;
mod m20261120_000002_ingestion_readiness;
mod m20261120_000003_source_resources;
mod m20261121_000001_admission_indexes;
mod m20261121_000002_airbyte_sender;
mod m20261121_000003_custom_selection;

mod m20261123_000001_placement_waits;
mod m20261123_000002_airbyte_previous_job;
mod m20261123_000003_admission_launch_and_exclusivity;
mod m20261123_000004_admission_idle_memory;
mod m20261123_000005_admission_idle_samples;

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
            Box::new(m20261121_000001_admission_indexes::Migration),
            Box::new(m20261121_000002_airbyte_sender::Migration),
            Box::new(m20261121_000003_custom_selection::Migration),
            Box::new(m20261123_000001_placement_waits::Migration),
            Box::new(m20261123_000002_airbyte_previous_job::Migration),
            Box::new(m20261123_000003_admission_launch_and_exclusivity::Migration),
            Box::new(m20261123_000004_admission_idle_memory::Migration),
            Box::new(m20261123_000005_admission_idle_samples::Migration),
        ]
    }
}

pub(crate) const REQUIRED_CHECKS_BY_TABLE: &[(&str, &[&str])] = &[(
    "connector_schedules",
    m20261110_000001_connector_schedules::REQUIRED_CHECKS,
)];
