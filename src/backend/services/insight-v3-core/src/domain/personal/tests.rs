use std::error::Error;

use serde_json::json;

use super::*;
use crate::domain::definition::{Change, DefinitionKind, DefinitionLabel, Definitions as _};
use crate::store::definitions::memory::MemoryDefinitions;

type R = Result<(), Box<dyn Error>>;

fn query(value: serde_json::Value) -> MetricQuery {
    serde_json::from_value(value).unwrap_or_else(|error| panic!("valid metric: {error}"))
}

fn reviews() -> Declaration {
    serde_json::from_value(json!({
        "title": "Reviews",
        "fields": [
            { "name": "reviewer", "path": "reviewer", "type": "string", "person": "email" },
            { "name": "repository", "path": "repository", "type": "string" },
            { "name": "comments", "path": "comments", "type": "int" },
            { "name": "reviewed_at", "path": "reviewed_at", "type": "datetime" }
        ]
    }))
    .unwrap_or_else(|error| panic!("valid declaration: {error}"))
}

fn settings(person: &str, value: &str) -> PersonalSettings {
    PersonalSettings {
        person_field: person.to_owned(),
        value_field: value.to_owned(),
        unit: None,
        format: MetricFormat::Number,
        direction: Direction::HigherIsBetter,
        description: "Reviews left in the period".to_owned(),
    }
}

fn per_reviewer(value: &serde_json::Value) -> MetricQuery {
    query(json!({
        "dataset": "reviews",
        "fields": [
            { "field": "reviewer", "type": "string", "as_name": "reviewer" },
            { "field": "repository", "type": "string", "as_name": "repository" },
            value
        ],
        "group_by": ["reviewer", "repository"]
    }))
}

fn summed() -> serde_json::Value {
    json!({ "field": "comments", "type": "int", "agg": "sum", "as_name": "comments" })
}

#[test]
fn settings_need_a_person_field() {
    let metric = per_reviewer(&summed());
    let declaration = reviews();

    assert_eq!(
        settings("author", "comments").check(&metric, Some(&declaration)),
        Err(SettingsError::NoPersonField("author".to_owned()))
    );
    assert_eq!(
        settings("repository", "comments").check(&metric, Some(&declaration)),
        Err(SettingsError::NoPersonHandle("repository".to_owned()))
    );
}

#[test]
fn a_person_handle_may_come_from_the_dataset_declaration() {
    let metric = per_reviewer(&summed());

    assert_eq!(
        settings("reviewer", "comments").check(&metric, Some(&reviews())),
        Ok(Calculation::Sum)
    );
    assert_eq!(
        settings("reviewer", "comments").check(&metric, None),
        Err(SettingsError::NoPersonHandle("reviewer".to_owned())),
        "a dataset metric gets its handle from the declaration only"
    );
}

#[test]
fn a_person_handle_may_come_from_person_on_a_table_field() {
    let metric = query(json!({
        "table": "reviews",
        "fields": [
            { "column": "reviewer_email", "type": "string", "person": "email", "as_name": "reviewer" },
            { "column": "repository", "type": "string", "as_name": "repository" },
            { "type": "int", "agg": "count", "as_name": "reviews" }
        ],
        "group_by": ["reviewer", "repository"]
    }));

    assert_eq!(
        settings("reviewer", "reviews").check(&metric, None),
        Ok(Calculation::Count)
    );
    assert_eq!(
        settings("repository", "reviews").check(&metric, None),
        Err(SettingsError::NoPersonHandle("repository".to_owned()))
    );
}

#[test]
fn an_aggregated_person_field_names_no_one_person() {
    let metric = query(json!({
        "dataset": "reviews",
        "fields": [
            { "field": "repository", "type": "string", "as_name": "repository" },
            { "field": "reviewer", "type": "string", "agg": "count", "as_name": "reviewers" },
            summed()
        ],
        "group_by": ["repository"]
    }));

    assert_eq!(
        settings("reviewers", "comments").check(&metric, Some(&reviews())),
        Err(SettingsError::AggregatedPerson("reviewers".to_owned()))
    );
}

#[test]
fn settings_need_an_aggregated_number() {
    let declaration = reviews();
    let plain = per_reviewer(&json!({ "field": "comments", "type": "int", "as_name": "comments" }));
    let latest = per_reviewer(
        &json!({ "field": "repository", "type": "string", "agg": "max", "as_name": "latest" }),
    );
    let latest_day = per_reviewer(
        &json!({ "field": "reviewed_at", "type": "string", "agg": "max", "as_name": "latest" }),
    );

    assert_eq!(
        settings("reviewer", "comments").check(&plain, Some(&declaration)),
        Err(SettingsError::NotAggregated("comments".to_owned()))
    );
    assert_eq!(
        settings("reviewer", "latest").check(&latest, Some(&declaration)),
        Err(SettingsError::NotANumber("latest".to_owned()))
    );
    assert_eq!(
        settings("reviewer", "latest").check(&latest_day, Some(&declaration)),
        Err(SettingsError::NotANumber("latest".to_owned()))
    );
    assert_eq!(
        settings("reviewer", "absent").check(&plain, Some(&declaration)),
        Err(SettingsError::NoValueField("absent".to_owned()))
    );
}

#[test]
fn a_ratio_field_is_calculation_ratio() {
    let ratio = |percent: bool| {
        query(json!({
            "dataset": "reviews",
            "fields": [
                { "field": "reviewer", "type": "string", "as_name": "reviewer" },
                summed(),
                { "type": "int", "agg": "count", "as_name": "reviews" },
                {
                    "type": "float",
                    "divide": ["comments", "reviews"],
                    "percent": percent,
                    "as_name": "per_review"
                }
            ],
            "group_by": ["reviewer"]
        }))
    };
    let declaration = reviews();

    assert_eq!(
        settings("reviewer", "per_review").check(&ratio(false), Some(&declaration)),
        Ok(Calculation::Ratio)
    );
    assert_eq!(
        settings("reviewer", "per_review").check(&ratio(true), Some(&declaration)),
        Ok(Calculation::Percent)
    );
}

#[test]
fn a_ratio_needs_aggregated_sides() {
    let metric = query(json!({
        "dataset": "reviews",
        "fields": [
            { "field": "reviewer", "type": "string", "as_name": "reviewer" },
            { "field": "comments", "type": "int", "as_name": "comments" },
            { "type": "int", "agg": "count", "as_name": "reviews" },
            { "type": "float", "divide": ["comments", "reviews"], "as_name": "per_review" }
        ],
        "group_by": ["reviewer", "comments"]
    }));

    assert_eq!(
        settings("reviewer", "per_review").check(&metric, Some(&reviews())),
        Err(SettingsError::UnaggregatedRatio("per_review".to_owned()))
    );
}

#[test]
fn each_aggregate_is_its_own_calculation() {
    let declaration = reviews();

    for (agg, calculation) in [
        ("count", Calculation::Count),
        ("sum", Calculation::Sum),
        ("avg", Calculation::Avg),
        ("min", Calculation::Min),
        ("max", Calculation::Max),
    ] {
        let metric = per_reviewer(
            &json!({ "field": "comments", "type": "int", "agg": agg, "as_name": "comments" }),
        );

        assert_eq!(
            settings("reviewer", "comments").check(&metric, Some(&declaration)),
            Ok(calculation),
            "{agg}"
        );
    }
}

#[test]
fn settings_refuse_a_metric_with_a_name_the_service_keeps_for_itself() {
    let declaration = reviews();

    for kept in ["__rows", "__person_id", "__p0", "__drilldown_key"] {
        let metric = query(json!({
            "dataset": "reviews",
            "fields": [
                { "field": "reviewer", "type": "string", "as_name": "reviewer" },
                { "field": "comments", "type": "int", "agg": "sum", "as_name": kept },
                { "field": "comments", "type": "int", "agg": "sum", "as_name": "comments" }
            ],
            "group_by": ["reviewer"]
        }));

        assert_eq!(
            settings("reviewer", "comments").check(&metric, Some(&declaration)),
            Err(SettingsError::ReservedName(kept.to_owned())),
            "{kept}"
        );
    }
}

#[test]
fn a_personal_metric_needs_a_time_source() {
    let clocked: Declaration = serde_json::from_value(json!({
        "title": "Reviews",
        "fields": [
            { "name": "reviewer", "path": "reviewer", "type": "string", "person": "email" },
            { "name": "repository", "path": "repository", "type": "string" },
            { "name": "comments", "path": "comments", "type": "int" },
            { "name": "reviewed_at", "path": "reviewed_at", "type": "datetime",
              "default_clock": true }
        ]
    }))
    .unwrap_or_else(|error| panic!("valid declaration: {error}"));
    let clockless = per_reviewer(&summed());
    let own_clock = query(json!({
        "dataset": "reviews",
        "time": { "field": "reviewed_at" },
        "fields": [
            { "field": "reviewer", "type": "string", "as_name": "reviewer" },
            summed()
        ],
        "group_by": ["reviewer"]
    }));
    let table = query(json!({
        "table": "reviews",
        "fields": [
            { "column": "reviewer_email", "type": "string", "person": "email", "as_name": "reviewer" },
            { "type": "int", "agg": "count", "as_name": "reviews" }
        ],
        "group_by": ["reviewer"]
    }));

    assert_eq!(
        settings("reviewer", "comments").check_timed(&clockless, Some(&reviews())),
        Err(SettingsError::Clockless)
    );
    assert_eq!(
        settings("reviewer", "comments").check_timed(&clockless, Some(&clocked)),
        Ok(Calculation::Sum)
    );
    assert_eq!(
        settings("reviewer", "comments").check_timed(&own_clock, Some(&reviews())),
        Ok(Calculation::Sum)
    );
    assert_eq!(
        settings("reviewer", "reviews").check_timed(&table, None),
        Err(SettingsError::Clockless)
    );
    assert_eq!(
        settings("author", "comments").check_timed(&clockless, Some(&reviews())),
        Err(SettingsError::NoPersonField("author".to_owned())),
        "settings that do not fit say so before the clock"
    );
}

#[test]
fn settings_read_format_and_direction_in_snake_case() {
    let read: PersonalSettings = serde_json::from_value(json!({
        "person_field": "reviewer",
        "value_field": "hours",
        "unit": "h",
        "format": "duration",
        "direction": "lower_is_better",
        "description": "Hours to the first review"
    }))
    .unwrap_or_else(|error| panic!("full settings read: {error}"));

    assert_eq!(
        read,
        PersonalSettings {
            person_field: "reviewer".to_owned(),
            value_field: "hours".to_owned(),
            unit: Some("h".to_owned()),
            format: MetricFormat::Duration,
            direction: Direction::LowerIsBetter,
            description: "Hours to the first review".to_owned(),
        }
    );
    assert_eq!(
        serde_json::to_value(Calculation::Percent).ok(),
        Some(json!("percent"))
    );
}

#[test]
fn settings_refuse_a_key_they_do_not_know() {
    let read = serde_json::from_value::<PersonalSettings>(json!({
        "person_field": "reviewer",
        "value_field": "comments",
        "format": "number",
        "direction": "neutral",
        "description": "Comments",
        "colour": "green"
    }));

    assert!(read.is_err(), "{read:?}");
}

mod the_store {
    use super::*;

    fn id(value: &str) -> DefinitionId {
        DefinitionId::parse(value).unwrap_or_else(|error| panic!("{error}"))
    }

    async fn a_metric(store: &MemoryDefinitions, named: &str) -> DefinitionId {
        let metric = id(named);
        store
            .apply(&[Change::Create(
                DefinitionKind::Metric,
                metric.clone(),
                DefinitionLabel::of_id(&metric),
                json!({ "dataset": "reviews", "fields": [] }),
            )])
            .await
            .unwrap_or_else(|error| panic!("`{named}` must store: {error}"));

        metric
    }

    #[tokio::test]
    async fn a_personal_metric_is_listed_with_its_name_and_body_until_made_not_personal() -> R {
        let store = MemoryDefinitions::new();
        let personal_metric = a_metric(&store, "personal_metric").await;
        a_metric(&store, "plain").await;

        assert!(
            store
                .set_personal(&personal_metric, Some(&settings("reviewer", "comments")))
                .await?
        );

        assert_eq!(
            store.personal_metrics().await?,
            vec![PersonalMetric {
                id: "personal_metric".to_owned(),
                name: "personal_metric".to_owned(),
                settings: settings("reviewer", "comments"),
                body: json!({ "dataset": "reviews", "fields": [] }),
            }]
        );
        assert_eq!(
            store.personal_of(&personal_metric).await?,
            Some(settings("reviewer", "comments"))
        );

        assert!(store.set_personal(&personal_metric, None).await?);
        assert!(store.personal_metrics().await?.is_empty());
        assert_eq!(store.personal_of(&personal_metric).await?, None);

        Ok(())
    }

    #[tokio::test]
    async fn a_metric_nobody_holds_cannot_be_made_personal() -> R {
        let store = MemoryDefinitions::new();

        assert!(
            !store
                .set_personal(&id("nowhere"), Some(&settings("reviewer", "comments")))
                .await?
        );
        assert!(store.personal_metrics().await?.is_empty());

        Ok(())
    }

    #[tokio::test]
    async fn a_deleted_metric_takes_its_personal_settings_with_it() -> R {
        let store = MemoryDefinitions::new();
        let personal_metric = a_metric(&store, "personal_metric").await;
        store
            .set_personal(&personal_metric, Some(&settings("reviewer", "comments")))
            .await?;

        store
            .delete(DefinitionKind::Metric, &personal_metric)
            .await?;
        a_metric(&store, "personal_metric").await;

        assert_eq!(store.personal_of(&personal_metric).await?, None);
        assert!(store.personal_metrics().await?.is_empty());

        Ok(())
    }
}
