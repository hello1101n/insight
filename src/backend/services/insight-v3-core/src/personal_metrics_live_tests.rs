use sea_orm::{ConnectionTrait as _, DatabaseConnection, DbBackend, FromQueryResult, Statement};

use crate::live_mariadb::{database_or_skip, unique};

#[derive(Debug, FromQueryResult)]
struct TotalRow {
    total: i64,
}

async fn run(db: &DatabaseConnection, sql: &str) {
    db.execute_unprepared(sql)
        .await
        .unwrap_or_else(|error| panic!("{sql}: {error}"));
}

async fn counted(db: &DatabaseConnection, sql: &str) -> i64 {
    TotalRow::find_by_statement(Statement::from_string(DbBackend::MySql, sql))
        .one(db)
        .await
        .unwrap_or_else(|error| panic!("{sql}: {error}"))
        .map_or(0, |row| row.total)
}

#[tokio::test]
async fn a_metric_holds_a_personal_mark_and_its_grants_go_with_it() {
    let Some(db) = database_or_skip().await else {
        return;
    };

    let column = counted(
        &db,
        "SELECT COUNT(*) AS total FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'metrics' AND column_name = 'personal' AND is_nullable = 'YES'",
    )
    .await;
    let table = counted(
        &db,
        "SELECT COUNT(*) AS total FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'metric_grants'",
    )
    .await;
    assert_eq!(column, 1, "metrics.personal is missing");
    assert_eq!(table, 1, "metric_grants is missing");

    let metric = unique("personal");
    run(
        &db,
        &format!(
            "INSERT INTO metrics (id, name, body, updated_at) VALUES ('{metric}', '{metric}', '{{}}', UTC_TIMESTAMP(6))"
        ),
    )
    .await;
    run(
        &db,
        &format!(
            "INSERT INTO metric_grants (metric, grantee, level, granted_by, created_at) VALUES ('{metric}', '00000000-0000-0000-0000-000000000001', 'view', '00000000-0000-0000-0000-000000000002', UTC_TIMESTAMP(6))"
        ),
    )
    .await;
    let held = counted(
        &db,
        &format!("SELECT COUNT(*) AS total FROM metric_grants WHERE metric = '{metric}'"),
    )
    .await;
    assert_eq!(held, 1);

    run(&db, &format!("DELETE FROM metrics WHERE id = '{metric}'")).await;

    let left = counted(
        &db,
        &format!("SELECT COUNT(*) AS total FROM metric_grants WHERE metric = '{metric}'"),
    )
    .await;
    assert_eq!(left, 0, "a deleted metric must take its grants with it");
}
