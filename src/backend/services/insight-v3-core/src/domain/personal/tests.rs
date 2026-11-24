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

fn mark(person: &str, value: &str) -> PersonalMark {
    PersonalMark {
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
fn a_mark_needs_a_person_field() {
    let metric = per_reviewer(&summed());
    let declaration = reviews();

    assert_eq!(
        mark("author", "comments").check(&metric, Some(&declaration)),
        Err(MarkError::NoPersonField("author".to_owned()))
    );
    assert_eq!(
        mark("repository", "comments").check(&metric, Some(&declaration)),
        Err(MarkError::NoPersonHandle("repository".to_owned()))
    );
}

#[test]
fn a_person_handle_may_come_from_the_dataset_declaration() {
    let metric = per_reviewer(&summed());

    assert_eq!(
        mark("reviewer", "comments").check(&metric, Some(&reviews())),
        Ok(Calculation::Sum)
    );
    assert_eq!(
        mark("reviewer", "comments").check(&metric, None),
        Err(MarkError::NoPersonHandle("reviewer".to_owned())),
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
        mark("reviewer", "reviews").check(&metric, None),
        Ok(Calculation::Count)
    );
    assert_eq!(
        mark("repository", "reviews").check(&metric, None),
        Err(MarkError::NoPersonHandle("repository".to_owned()))
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
        mark("reviewers", "comments").check(&metric, Some(&reviews())),
        Err(MarkError::AggregatedPerson("reviewers".to_owned()))
    );
}

#[test]
fn a_mark_needs_an_aggregated_number() {
    let declaration = reviews();
    let plain = per_reviewer(&json!({ "field": "comments", "type": "int", "as_name": "comments" }));
    let latest = per_reviewer(
        &json!({ "field": "repository", "type": "string", "agg": "max", "as_name": "latest" }),
    );
    let latest_day = per_reviewer(
        &json!({ "field": "reviewed_at", "type": "string", "agg": "max", "as_name": "latest" }),
    );

    assert_eq!(
        mark("reviewer", "comments").check(&plain, Some(&declaration)),
        Err(MarkError::NotAggregated("comments".to_owned()))
    );
    assert_eq!(
        mark("reviewer", "latest").check(&latest, Some(&declaration)),
        Err(MarkError::NotANumber("latest".to_owned()))
    );
    assert_eq!(
        mark("reviewer", "latest").check(&latest_day, Some(&declaration)),
        Err(MarkError::NotANumber("latest".to_owned()))
    );
    assert_eq!(
        mark("reviewer", "absent").check(&plain, Some(&declaration)),
        Err(MarkError::NoValueField("absent".to_owned()))
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
        mark("reviewer", "per_review").check(&ratio(false), Some(&declaration)),
        Ok(Calculation::Ratio)
    );
    assert_eq!(
        mark("reviewer", "per_review").check(&ratio(true), Some(&declaration)),
        Ok(Calculation::Percent)
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
            mark("reviewer", "comments").check(&metric, Some(&declaration)),
            Ok(calculation),
            "{agg}"
        );
    }
}

#[test]
fn a_mark_reads_its_format_and_direction_in_snake_case() {
    let read: PersonalMark = serde_json::from_value(json!({
        "person_field": "reviewer",
        "value_field": "hours",
        "unit": "h",
        "format": "duration",
        "direction": "lower_is_better",
        "description": "Hours to the first review"
    }))
    .unwrap_or_else(|error| panic!("a full mark reads: {error}"));

    assert_eq!(
        read,
        PersonalMark {
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
fn a_mark_refuses_a_key_it_does_not_know() {
    let read = serde_json::from_value::<PersonalMark>(json!({
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
    async fn a_marked_metric_is_listed_with_its_name_and_body_until_unmarked() -> R {
        let store = MemoryDefinitions::new();
        let marked = a_metric(&store, "marked").await;
        a_metric(&store, "plain").await;

        assert!(
            store
                .mark(&marked, Some(&mark("reviewer", "comments")))
                .await?
        );

        assert_eq!(
            store.marked().await?,
            vec![Marked {
                id: "marked".to_owned(),
                name: "marked".to_owned(),
                mark: mark("reviewer", "comments"),
                body: json!({ "dataset": "reviews", "fields": [] }),
            }]
        );
        assert_eq!(
            store.mark_of(&marked).await?,
            Some(mark("reviewer", "comments"))
        );

        assert!(store.mark(&marked, None).await?);
        assert!(store.marked().await?.is_empty());
        assert_eq!(store.mark_of(&marked).await?, None);

        Ok(())
    }

    #[tokio::test]
    async fn a_metric_nobody_holds_cannot_be_marked() -> R {
        let store = MemoryDefinitions::new();

        assert!(
            !store
                .mark(&id("nowhere"), Some(&mark("reviewer", "comments")))
                .await?
        );
        assert!(store.marked().await?.is_empty());

        Ok(())
    }

    #[tokio::test]
    async fn a_deleted_metric_takes_its_mark_with_it() -> R {
        let store = MemoryDefinitions::new();
        let marked = a_metric(&store, "marked").await;
        store
            .mark(&marked, Some(&mark("reviewer", "comments")))
            .await?;

        store.delete(DefinitionKind::Metric, &marked).await?;
        a_metric(&store, "marked").await;

        assert_eq!(store.mark_of(&marked).await?, None);
        assert!(store.marked().await?.is_empty());

        Ok(())
    }
}
