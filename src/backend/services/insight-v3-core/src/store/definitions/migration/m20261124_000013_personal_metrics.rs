use sea_orm::DbErr;
use sea_orm_migration::prelude::*;

const STEPS: [&str; 2] = [
    "ALTER TABLE metrics ADD COLUMN IF NOT EXISTS personal JSON NULL",
    "CREATE TABLE IF NOT EXISTS metric_grants (
    metric VARCHAR(128) NOT NULL,
    grantee VARCHAR(36) NOT NULL,
    level VARCHAR(8) NOT NULL,
    granted_by CHAR(36) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (metric, grantee),
    KEY metric_grants_grantee (grantee, metric),
    CONSTRAINT metric_grants_metric FOREIGN KEY (metric)
        REFERENCES metrics (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &'static str {
        "m20261124_000013_personal_metrics"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        for step in STEPS {
            db.execute_unprepared(step).await?;
        }

        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom(
            "dropping the personal settings would publish every personal metric to everyone"
                .to_owned(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::STEPS;

    #[test]
    fn every_step_is_one_that_runs_again_without_change() {
        assert!(!STEPS.is_empty());
        for statement in STEPS {
            assert!(
                statement.contains("IF NOT EXISTS"),
                "should be guarded: {statement}"
            );
        }
    }

    #[test]
    fn a_metric_carries_nullable_personal_settings() {
        assert!(
            STEPS.contains(&"ALTER TABLE metrics ADD COLUMN IF NOT EXISTS personal JSON NULL"),
            "{STEPS:#?}"
        );
    }

    #[test]
    fn metric_grants_go_with_their_metric() {
        let created = STEPS
            .iter()
            .find(|step| step.contains("CREATE TABLE IF NOT EXISTS metric_grants"))
            .unwrap_or_else(|| panic!("no step creates metric_grants"));

        for part in [
            "metric VARCHAR(128) NOT NULL",
            "grantee VARCHAR(36) NOT NULL",
            "level VARCHAR(8) NOT NULL",
            "granted_by CHAR(36) NOT NULL",
            "created_at DATETIME(6) NOT NULL",
            "PRIMARY KEY (metric, grantee)",
            "KEY metric_grants_grantee (grantee, metric)",
            "REFERENCES metrics (id) ON DELETE CASCADE",
        ] {
            assert!(created.contains(part), "{part} is missing: {created}");
        }
    }
}
