use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use uuid::Uuid;

use super::*;
use crate::domain::access::Level;
use crate::domain::personal::{Direction, MetricFormat, PersonalSettings};

fn person(seed: u128) -> PersonId {
    PersonId::new(Uuid::from_u128(seed))
}

fn personal_metric() -> PersonalMetric {
    PersonalMetric {
        id: "lines_merged".to_owned(),
        name: "Lines merged".to_owned(),
        settings: PersonalSettings {
            person_field: "author".to_owned(),
            value_field: "lines".to_owned(),
            unit: None,
            format: MetricFormat::Number,
            direction: Direction::Neutral,
            description: "Lines merged in the period".to_owned(),
        },
        body: json!({}),
    }
}

fn granted(grantee: Grantee, by: u128, at: i64) -> Grant {
    Grant {
        grantee,
        level: Level::Viewer,
        granted_by: person(by),
        created_at: DateTime::<Utc>::from_timestamp(at, 0)
            .unwrap_or_else(|| panic!("{at} is a time")),
    }
}

#[test]
fn a_member_is_shown_the_grant_to_them_before_the_grant_to_everyone() {
    let member = Caller::member(person(1));
    let grants = vec![
        granted(Grantee::Everyone, 8, 10),
        granted(Grantee::Person(person(1)), 9, 20),
    ];

    let shown = shown(member, personal_metric(), grants).map(|shown| shown.shared_by);

    assert_eq!(
        shown,
        Some(Some(granted(Grantee::Person(person(1)), 9, 20)))
    );
}

#[test]
fn a_member_is_not_shown_a_metric_granted_to_someone_else() {
    let member = Caller::member(person(1));
    let grants = vec![granted(Grantee::Person(person(2)), 9, 20)];

    assert!(shown(member, personal_metric(), grants).is_none());
}

#[test]
fn an_admin_is_shown_the_latest_grant() {
    let admin = Caller::administrator(person(1));
    let grants = vec![
        granted(Grantee::Person(person(2)), 8, 30),
        granted(Grantee::Everyone, 9, 10),
    ];

    let shown = shown(admin, personal_metric(), grants).map(|shown| shown.shared_by);

    assert_eq!(
        shown,
        Some(Some(granted(Grantee::Person(person(2)), 8, 30)))
    );
}

#[test]
fn an_admin_is_shown_an_unshared_metric() {
    let admin = Caller::administrator(person(1));

    let shown = shown(admin, personal_metric(), Vec::new()).map(|shown| shown.shared_by);

    assert_eq!(shown, Some(None));
}

#[test]
fn a_decimal_text_value_answers_a_number() {
    assert_eq!(
        number(&json!("12.50")),
        Some(Number::from_f64(12.5).unwrap_or_else(|| panic!("finite")))
    );
    assert_eq!(number(&json!(7)), Some(Number::from(7)));
}

#[test]
fn a_whole_number_above_2_pow_53_keeps_every_digit() {
    assert_eq!(
        number(&json!("9007199254740993")),
        Some(Number::from(9_007_199_254_740_993_i64))
    );
    assert_eq!(
        number(&json!("-9007199254740993")),
        Some(Number::from(-9_007_199_254_740_993_i64))
    );
    assert_eq!(
        number(&json!("18446744073709551615")),
        Some(Number::from(u64::MAX))
    );
}

#[test]
fn a_value_that_is_not_a_finite_number_answers_null() {
    for value in [
        json!("nan"),
        json!("inf"),
        json!("text"),
        Value::Null,
        json!(true),
    ] {
        assert_eq!(number(&value), None, "{value}");
    }
}

#[test]
fn rows_map_each_person_to_its_value() {
    let result = RunResult {
        columns: vec!["person_id".to_owned(), "value".to_owned()],
        rows: vec![
            vec![json!(person(1).to_string()), json!(15)],
            vec![json!(person(2).to_string()), Value::Null],
        ],
        percents: Vec::new(),
        units: std::collections::BTreeMap::new(),
        undated: None,
        clock: None,
    };

    let found = by_person(&result);

    assert_eq!(found.get(&person(1)), Some(&Some(Number::from(15))));
    assert_eq!(found.get(&person(2)), Some(&None));
    assert_eq!(found.len(), 2);
}
