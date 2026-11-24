use std::error::Error;

use sea_orm::{ConnectionTrait as _, DatabaseConnection, DbBackend, FromQueryResult, Statement};
use serde_json::json;

use crate::domain::definition::{
    Change, DefinitionId, DefinitionKind, DefinitionLabel, Definitions as _,
};
use crate::domain::personal::{Direction, Marked, Marks as _, MetricFormat, PersonalMark};
use crate::live_mariadb::{database_or_skip, store_or_skip, unique};
use crate::store::definitions::MariaDefinitions;

type R = Result<(), Box<dyn Error>>;

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

fn a_mark() -> PersonalMark {
    PersonalMark {
        person_field: "reviewer".to_owned(),
        value_field: "comments".to_owned(),
        unit: Some("comments".to_owned()),
        format: MetricFormat::Number,
        direction: Direction::HigherIsBetter,
        description: "Review comments left in the period".to_owned(),
    }
}

fn per_reviewer() -> serde_json::Value {
    json!({
        "dataset": "reviews",
        "fields": [
            { "field": "reviewer", "type": "string", "as_name": "reviewer" },
            { "field": "comments", "type": "int", "agg": "sum", "as_name": "comments" }
        ],
        "group_by": ["reviewer"]
    })
}

async fn a_metric(store: &MariaDefinitions, prefix: &str) -> Result<DefinitionId, Box<dyn Error>> {
    let metric = DefinitionId::parse(&unique(prefix))?;
    store
        .create(
            DefinitionKind::Metric,
            &metric,
            &DefinitionLabel::of_id(&metric),
            &per_reviewer(),
        )
        .await?;

    Ok(metric)
}

async fn listed(
    store: &MariaDefinitions,
    metric: &DefinitionId,
) -> Result<Vec<Marked>, Box<dyn Error>> {
    Ok(store
        .marked()
        .await?
        .into_iter()
        .filter(|marked| marked.id == metric.as_str())
        .collect())
}

#[tokio::test]
async fn a_mark_is_kept_read_back_and_dropped() -> R {
    let Some(store) = store_or_skip().await else {
        return Ok(());
    };
    let metric = a_metric(&store, "marked").await?;

    assert!(store.mark(&metric, Some(&a_mark())).await?);
    assert!(
        store.mark(&metric, Some(&a_mark())).await?,
        "a mark that changes nothing still finds its metric"
    );
    assert_eq!(store.mark_of(&metric).await?, Some(a_mark()));
    assert_eq!(
        listed(&store, &metric).await?,
        vec![Marked {
            id: metric.as_str().to_owned(),
            name: metric.as_str().to_owned(),
            mark: a_mark(),
            body: per_reviewer(),
        }]
    );

    assert!(store.mark(&metric, None).await?);
    assert_eq!(store.mark_of(&metric).await?, None);
    assert!(listed(&store, &metric).await?.is_empty());

    let nowhere = DefinitionId::parse(&unique("nowhere"))?;
    assert!(!store.mark(&nowhere, Some(&a_mark())).await?);
    assert_eq!(store.mark_of(&nowhere).await?, None);

    store.delete(DefinitionKind::Metric, &metric).await?;

    Ok(())
}

#[tokio::test]
async fn a_replace_keeps_the_mark() -> R {
    let Some(store) = store_or_skip().await else {
        return Ok(());
    };
    let metric = a_metric(&store, "replaced").await?;
    store.mark(&metric, Some(&a_mark())).await?;
    let label = DefinitionLabel::parse("Comments per reviewer")?;
    let wider = json!({
        "dataset": "reviews",
        "fields": [
            { "field": "reviewer", "type": "string", "as_name": "reviewer" },
            { "field": "comments", "type": "int", "agg": "avg", "as_name": "comments" }
        ],
        "group_by": ["reviewer"]
    });

    store
        .replace(DefinitionKind::Metric, &metric, &label, &wider)
        .await?;
    store
        .apply(&[Change::Replace(
            DefinitionKind::Metric,
            metric.clone(),
            label,
            wider.clone(),
        )])
        .await?;

    assert_eq!(store.mark_of(&metric).await?, Some(a_mark()));
    let kept = listed(&store, &metric).await?;
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(
        (kept[0].name.as_str(), &kept[0].body),
        ("Comments per reviewer", &wider)
    );

    store.delete(DefinitionKind::Metric, &metric).await?;

    Ok(())
}
