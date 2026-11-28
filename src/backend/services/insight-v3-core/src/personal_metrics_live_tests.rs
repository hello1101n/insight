use std::error::Error;

use sea_orm::{ConnectionTrait as _, DatabaseConnection, DbBackend, FromQueryResult, Statement};
use serde_json::json;
use uuid::Uuid;

use crate::domain::access::{Grantee, Level, PersonId};
use crate::domain::definition::{
    Change, DefinitionId, DefinitionKind, DefinitionLabel, DefinitionStoreError, Definitions as _,
};
use crate::domain::personal::{
    Direction, MetricFormat, PersonalMetric, PersonalSettings, PersonalSettingsStore as _,
};
use crate::domain::sharing::{Granting, Grants as _, Shared, Withdrawal};
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
async fn a_metric_holds_personal_settings_and_its_grants_go_with_it() {
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

fn some_settings() -> PersonalSettings {
    PersonalSettings {
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
) -> Result<Vec<PersonalMetric>, Box<dyn Error>> {
    Ok(store
        .personal_metrics()
        .await?
        .into_iter()
        .filter(|personal_metric| personal_metric.id == metric.as_str())
        .collect())
}

#[tokio::test]
async fn personal_settings_are_kept_read_back_and_dropped() -> R {
    let Some(store) = store_or_skip().await else {
        return Ok(());
    };
    let metric = a_metric(&store, "personal_metric").await?;

    assert!(store.set_personal(&metric, Some(&some_settings())).await?);
    assert!(
        store.set_personal(&metric, Some(&some_settings())).await?,
        "settings that change nothing still find their metric"
    );
    assert_eq!(store.personal_of(&metric).await?, Some(some_settings()));
    assert_eq!(
        listed(&store, &metric).await?,
        vec![PersonalMetric {
            id: metric.as_str().to_owned(),
            name: metric.as_str().to_owned(),
            settings: some_settings(),
            body: per_reviewer(),
        }]
    );

    assert!(store.set_personal(&metric, None).await?);
    assert_eq!(store.personal_of(&metric).await?, None);
    assert!(listed(&store, &metric).await?.is_empty());

    let nowhere = DefinitionId::parse(&unique("nowhere"))?;
    assert!(!store.set_personal(&nowhere, Some(&some_settings())).await?);
    assert_eq!(store.personal_of(&nowhere).await?, None);

    store.delete(DefinitionKind::Metric, &metric).await?;

    Ok(())
}

#[tokio::test]
async fn a_replace_keeps_the_personal_settings() -> R {
    let Some(store) = store_or_skip().await else {
        return Ok(());
    };
    let metric = a_metric(&store, "replaced").await?;
    store.set_personal(&metric, Some(&some_settings())).await?;
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

    assert_eq!(store.personal_of(&metric).await?, Some(some_settings()));
    let kept = listed(&store, &metric).await?;
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(
        (kept[0].name.as_str(), &kept[0].body),
        ("Comments per reviewer", &wider)
    );

    store.delete(DefinitionKind::Metric, &metric).await?;

    Ok(())
}

#[tokio::test]
async fn a_metric_grant_round_trips_and_goes_with_its_metric() -> R {
    let Some(store) = store_or_skip().await else {
        return Ok(());
    };
    let metric = a_metric(&store, "granted").await?;
    let nowhere = DefinitionId::parse(&unique("nowhere"))?;
    let admin = PersonId::new(Uuid::from_u128(1));
    let member = PersonId::new(Uuid::from_u128(2));

    let to_person = store
        .grant(
            Shared::Metric(&metric),
            Grantee::Person(member),
            Level::Viewer,
            admin,
        )
        .await?;
    let to_everyone = store
        .grant(
            Shared::Metric(&metric),
            Grantee::Everyone,
            Level::Viewer,
            admin,
        )
        .await?;
    let again = store
        .grant(
            Shared::Metric(&metric),
            Grantee::Person(member),
            Level::Viewer,
            admin,
        )
        .await?;

    assert_eq!(
        [to_person, to_everyone, again],
        [Granting::Done, Granting::Done, Granting::Done]
    );
    let held = store.grants_of(Shared::Metric(&metric)).await?;
    assert_eq!(held.len(), 2, "{held:?}");
    let person = held
        .iter()
        .find(|grant| grant.grantee == Grantee::Person(member))
        .ok_or("the person grant is listed")?;
    assert_eq!(person.level, Level::Viewer);
    assert_eq!(person.granted_by, admin);
    assert!(held.iter().any(|grant| grant.grantee == Grantee::Everyone));

    let withdrawn = store
        .withdraw(Shared::Metric(&metric), Grantee::Everyone, admin)
        .await?;
    assert_eq!(withdrawn, Withdrawal::Done);
    assert_eq!(store.grants_of(Shared::Metric(&metric)).await?.len(), 1);

    let missing = store
        .grant(
            Shared::Metric(&nowhere),
            Grantee::Everyone,
            Level::Viewer,
            admin,
        )
        .await;
    assert!(
        matches!(missing, Err(DefinitionStoreError::Missing(_))),
        "{missing:?}"
    );

    store.delete(DefinitionKind::Metric, &metric).await?;

    assert!(store.grants_of(Shared::Metric(&metric)).await?.is_empty());

    Ok(())
}
