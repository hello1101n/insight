use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use chrono::Utc;
use serde_json::{Value, json};
use tower::ServiceExt as _;
use uuid::Uuid;

use crate::api::AppState;
use crate::chat::ChatClient;
use crate::domain::access::PersonId;
use crate::domain::definition::{DefinitionId, DefinitionKind, DefinitionLabel, Definitions as _};
use crate::domain::personal::{Direction, Marks as _, MetricFormat, PersonalMark};
use crate::domain::query::metric_query::{
    MetricQuery, MetricRunner, People, RunResult, TableEngine,
};
use crate::domain::query::time_window::{RequestedRange, Window};
use crate::store::definitions::memory::MemoryDefinitions;
use crate::store::identity::IdentityClient;

const URL_VAR: &str = "INTEGRATION_TESTS_CLICKHOUSE_URL";

struct Stand {
    runner: MetricRunner,
    client: insight_clickhouse::Client,
    database: String,
}

async fn stand_or_skip() -> Option<Stand> {
    let url = std::env::var(URL_VAR).unwrap_or_default();
    if url.is_empty() {
        eprintln!("skipping: {URL_VAR} not set");
        return None;
    }

    let mut config = insight_clickhouse::Config::new(url, "default".to_owned());
    let user = std::env::var("INTEGRATION_TESTS_CLICKHOUSE_USER").unwrap_or_default();
    let password = std::env::var("INTEGRATION_TESTS_CLICKHOUSE_PASSWORD").unwrap_or_default();
    assert_eq!(
        user.is_empty(),
        password.is_empty(),
        "set both INTEGRATION_TESTS_CLICKHOUSE_USER and _PASSWORD, or neither"
    );
    if !user.is_empty() {
        config = config.with_auth(user, password);
    }

    let client = insight_clickhouse::Client::new(config);
    let database = format!("personal_{}", Uuid::now_v7().simple());
    execute(&client, &format!("CREATE DATABASE {database}")).await;
    execute(
        &client,
        &format!(
            "CREATE TABLE {database}.identity_persons (value_type String, \
             value_effective Nullable(String), person_id UUID, \
             created_at DateTime64(6, 'UTC')) ENGINE = MergeTree ORDER BY person_id"
        ),
    )
    .await;
    execute(
        &client,
        &format!(
            "CREATE TABLE {database}.observations (author_email String, \
             author_person_id String, measure_key String, value Int64, branch String, \
             observed_at DateTime) ENGINE = MergeTree ORDER BY observed_at"
        ),
    )
    .await;

    Some(Stand {
        runner: MetricRunner::new(
            insight_clickhouse::Client::new(client.config().clone()),
            People::new(database.clone()),
        ),
        client,
        database,
    })
}

impl Stand {
    async fn seed(&self) {
        let mut persons = Vec::new();
        for (seed, name) in [(1, "alice"), (2, "bob"), (3, "carol"), (4, "dave")] {
            persons.push(format!(
                "('display_name', '{} Example', toUUID('{}'), now64(6))",
                capitalized(name),
                person(seed)
            ));
        }
        for (seed, name) in [
            (1, "alice"),
            (2, "bob"),
            (3, "carol"),
            (4, "dave"),
            (5, "erin"),
        ] {
            persons.push(format!(
                "('email', '{name}@example.com', toUUID('{}'), now64(6))",
                person(seed)
            ));
        }
        execute(
            &self.client,
            &format!(
                "INSERT INTO {}.identity_persons \
                 (value_type, value_effective, person_id, created_at) VALUES {}",
                self.database,
                persons.join(", ")
            ),
        )
        .await;

        let observations: Vec<String> = [
            (1, "alice", "lines", 10, "main", "2026-09-02 10:00:00"),
            (1, "alice", "lines", 5, "main", "2026-09-03 10:00:00"),
            (1, "alice", "lines", 100, "dev", "2026-09-03 11:00:00"),
            (1, "alice", "lines", 1000, "main", "2026-08-01 10:00:00"),
            (1, "alice", "gate_passed", 3, "main", "2026-09-04 10:00:00"),
            (1, "alice", "gate_runs", 4, "main", "2026-09-04 10:00:00"),
            (2, "bob", "lines", 7, "main", "2026-09-05 10:00:00"),
            (2, "bob", "gate_passed", 1, "main", "2026-09-05 10:00:00"),
            (2, "bob", "gate_runs", 2, "main", "2026-09-05 10:00:00"),
            (3, "carol", "lines", 50, "main", "2026-09-05 10:00:00"),
            (5, "erin", "lines", 9, "main", "2026-09-06 10:00:00"),
        ]
        .iter()
        .map(|(seed, name, measure, value, branch, at)| {
            format!(
                "('{name}@example.com', '{}', '{measure}', {value}, '{branch}', '{at}')",
                person(*seed)
            )
        })
        .collect();
        execute(
            &self.client,
            &format!(
                "INSERT INTO {}.observations (author_email, author_person_id, measure_key, \
                 value, branch, observed_at) VALUES {}",
                self.database,
                observations.join(", ")
            ),
        )
        .await;
    }

    fn metric(&self, value_fields: &Value) -> MetricQuery {
        self.metric_by(
            json!({
                "column": "author_email", "type": "string", "as_name": "author", "person": "email"
            }),
            value_fields,
        )
    }

    fn metric_by(&self, person_field: Value, value_fields: &Value) -> MetricQuery {
        serde_json::from_value(self.body_by(person_field, value_fields))
            .unwrap_or_else(|error| panic!("the fixture metric parses: {error}"))
    }

    fn body_by(&self, person_field: Value, value_fields: &Value) -> Value {
        let mut fields = vec![person_field];
        fields.extend(value_fields.as_array().cloned().unwrap_or_default());

        json!({
            "database": self.database,
            "table": "observations",
            "time": { "column": "observed_at", "type": "datetime" },
            "fields": fields,
            "group_by": ["author"],
            "filters": [{ "column": "branch", "type": "string", "op": "eq", "value": "main" }]
        })
    }

    async fn served(&self, metric: &str, body: &Value) -> Router {
        let definitions = Arc::new(MemoryDefinitions::new());
        let id = DefinitionId::parse(metric)
            .unwrap_or_else(|error| panic!("`{metric}` is an id: {error}"));
        let label = DefinitionLabel::parse("Lines merged")
            .unwrap_or_else(|error| panic!("the label parses: {error}"));
        definitions
            .create(DefinitionKind::Metric, &id, &label, body)
            .await
            .unwrap_or_else(|error| panic!("the metric is stored: {error}"));
        definitions
            .mark(&id, Some(&marked("lines")))
            .await
            .unwrap_or_else(|error| panic!("the mark is stored: {error}"));

        let state = Arc::new(AppState::new(
            MetricRunner::new(
                insight_clickhouse::Client::new(self.client.config().clone()),
                People::new(self.database.clone()),
            ),
            definitions,
            ChatClient::keyless(),
            IdentityClient::fixed(true),
            crate::api::Datasets::offline("http://offline.invalid"),
            crate::store::catalog::Catalog::fixed(Vec::new()),
        ));

        crate::api::personal_metrics::register_routes(
            Router::new(),
            &toolkit::api::OpenApiRegistryImpl::new(),
            &state,
        )
    }

    async fn run(&self, compiled: &crate::domain::query::metric_query::CompiledQuery) -> RunResult {
        self.runner
            .run(compiled)
            .await
            .unwrap_or_else(|error| panic!("the personal query runs: {error}"))
    }

    async fn drop_database(&self) {
        execute(
            &self.client,
            &format!("DROP DATABASE IF EXISTS {}", self.database),
        )
        .await;
    }
}

async fn execute(client: &insight_clickhouse::Client, sql: &str) {
    client
        .query(sql)
        .execute()
        .await
        .unwrap_or_else(|error| panic!("`{sql}` runs: {error}"));
}

fn person(seed: u128) -> PersonId {
    PersonId::new(Uuid::from_u128(seed))
}

fn capitalized(name: &str) -> String {
    let mut letters = name.chars();

    letters
        .next()
        .map(|first| first.to_uppercase().chain(letters).collect())
        .unwrap_or_default()
}

fn marked(value_field: &str) -> PersonalMark {
    PersonalMark {
        person_field: "author".to_owned(),
        value_field: value_field.to_owned(),
        unit: None,
        format: MetricFormat::Number,
        direction: Direction::HigherIsBetter,
        description: "Lines merged in the period".to_owned(),
    }
}

fn september_week() -> Window {
    RequestedRange::parse("2026-09-01/2026-09-08")
        .and_then(|range| range.resolve(Utc::now()))
        .unwrap_or_else(|error| panic!("the window resolves: {error}"))
        .unbucketed()
}

fn lines() -> Value {
    json!([{
        "column": "value", "type": "int", "agg": "sum", "as_name": "lines",
        "when": [{ "column": "measure_key", "type": "string", "op": "eq", "value": "lines" }]
    }])
}

fn pass_rate() -> Value {
    json!([
        { "column": "value", "type": "int", "agg": "sum", "as_name": "passed",
          "when": [{ "column": "measure_key", "type": "string", "op": "eq",
                     "value": "gate_passed" }] },
        { "column": "value", "type": "int", "agg": "sum", "as_name": "runs",
          "when": [{ "column": "measure_key", "type": "string", "op": "eq",
                     "value": "gate_runs" }] },
        { "divide": ["passed", "runs"], "percent": true, "type": "float", "as_name": "pass_rate" }
    ])
}

fn by_person(result: &RunResult) -> Vec<(String, Value)> {
    assert_eq!(result.columns, ["person_id", "value"]);

    let mut rows: Vec<(String, Value)> = result
        .rows
        .iter()
        .map(|row| match row.as_slice() {
            [Value::String(id), value] => (id.clone(), value.clone()),
            other => panic!("a personal row is a person id and a value: {other:?}"),
        })
        .collect();
    rows.sort_by(|left, right| left.0.cmp(&right.0));

    rows
}

fn only_value(result: &RunResult) -> Value {
    assert_eq!(result.columns, ["value"]);

    match result.rows.as_slice() {
        [row] => row.first().cloned().unwrap_or(Value::Null),
        other => panic!("a team value is one row: {other:?}"),
    }
}

#[tokio::test]
async fn personal_values_answer_only_the_persons_asked_for() {
    let Some(stand) = stand_or_skip().await else {
        return;
    };
    stand.seed().await;
    let metric = stand.metric(&lines());

    let compiled = metric
        .personal_values(
            &marked("lines"),
            &[person(1), person(2), person(4)],
            &september_week(),
            stand.runner.people(),
            TableEngine::MergeTree,
            None,
        )
        .unwrap_or_else(|error| panic!("the personal values compile: {error}"));
    let result = stand.run(&compiled).await;

    assert_eq!(
        by_person(&result),
        vec![
            (person(1).to_string(), json!(15)),
            (person(2).to_string(), json!(7)),
        ]
    );

    stand.drop_database().await;
}

#[tokio::test]
async fn a_team_value_is_one_total_over_its_persons() {
    let Some(stand) = stand_or_skip().await else {
        return;
    };
    stand.seed().await;
    let metric = stand.metric(&lines());

    let compiled = metric
        .team_value(
            &marked("lines"),
            &[person(1), person(2)],
            &september_week(),
            stand.runner.people(),
            TableEngine::MergeTree,
            None,
        )
        .unwrap_or_else(|error| panic!("the team value compiles: {error}"));
    let result = stand.run(&compiled).await;

    assert_eq!(only_value(&result), json!(22));

    stand.drop_database().await;
}

#[tokio::test]
async fn a_ratio_value_divides_each_persons_own_sums() {
    let Some(stand) = stand_or_skip().await else {
        return;
    };
    stand.seed().await;
    let metric = stand.metric(&pass_rate());

    let personal = metric
        .personal_values(
            &marked("pass_rate"),
            &[person(1), person(2)],
            &september_week(),
            stand.runner.people(),
            TableEngine::MergeTree,
            None,
        )
        .unwrap_or_else(|error| panic!("the personal ratio compiles: {error}"));
    let team = metric
        .team_value(
            &marked("pass_rate"),
            &[person(1), person(2)],
            &september_week(),
            stand.runner.people(),
            TableEngine::MergeTree,
            None,
        )
        .unwrap_or_else(|error| panic!("the team ratio compiles: {error}"));

    assert_eq!(
        by_person(&stand.run(&personal).await),
        vec![
            (person(1).to_string(), json!(75)),
            (person(2).to_string(), json!(50)),
        ]
    );
    let together = only_value(&stand.run(&team).await)
        .as_f64()
        .unwrap_or_else(|| panic!("the team ratio is a number"));
    assert!((together - 400.0 / 6.0).abs() < 1e-9, "{together}");

    stand.drop_database().await;
}

#[tokio::test]
async fn personal_records_list_the_rows_behind_one_persons_value() {
    let Some(stand) = stand_or_skip().await else {
        return;
    };
    stand.seed().await;
    let metric = stand.metric(&lines());

    let compiled = metric
        .personal_records(
            &marked("lines"),
            person(1),
            &september_week(),
            stand.runner.people(),
            TableEngine::MergeTree,
            None,
        )
        .unwrap_or_else(|error| panic!("the personal records compile: {error}"));
    let result = stand.run(&compiled).await;

    assert_eq!(result.columns, ["time", "author", "lines"]);
    let mut rows = result.rows.clone();
    rows.sort_by_key(|row| row.first().map(Value::to_string));
    assert_eq!(
        rows,
        vec![
            vec![
                json!("2026-09-02 10:00:00"),
                json!("Alice Example"),
                json!(10)
            ],
            vec![
                json!("2026-09-03 10:00:00"),
                json!("Alice Example"),
                json!(5)
            ],
        ]
    );

    stand.drop_database().await;
}

#[tokio::test]
async fn a_person_without_a_display_name_still_has_a_value() {
    let Some(stand) = stand_or_skip().await else {
        return;
    };
    stand.seed().await;
    let by_email = stand.metric(&lines());
    let by_id = stand.metric_by(
        json!({
            "column": "author_person_id", "type": "string", "as_name": "author", "person": "id"
        }),
        &lines(),
    );

    for metric in [&by_email, &by_id] {
        let compiled = metric
            .personal_values(
                &marked("lines"),
                &[person(5)],
                &september_week(),
                stand.runner.people(),
                TableEngine::MergeTree,
                None,
            )
            .unwrap_or_else(|error| panic!("the personal values compile: {error}"));

        assert_eq!(
            by_person(&stand.run(&compiled).await),
            vec![(person(5).to_string(), json!(9))]
        );
    }

    let records = by_email
        .personal_records(
            &marked("lines"),
            person(5),
            &september_week(),
            stand.runner.people(),
            TableEngine::MergeTree,
            None,
        )
        .unwrap_or_else(|error| panic!("the personal records compile: {error}"));
    assert_eq!(
        stand.run(&records).await.rows,
        vec![vec![
            json!("2026-09-06 10:00:00"),
            json!("erin@example.com"),
            json!(9)
        ]]
    );

    stand.drop_database().await;
}

#[tokio::test]
async fn a_team_with_no_rows_answers_null_for_every_aggregate() {
    let Some(stand) = stand_or_skip().await else {
        return;
    };
    stand.seed().await;
    let mut fields = vec![json!({ "agg": "count", "type": "int", "as_name": "counted" })];
    for agg in ["sum", "min", "max", "avg"] {
        fields.push(json!({ "column": "value", "type": "int", "agg": agg, "as_name": agg }));
    }
    fields.extend(pass_rate().as_array().cloned().unwrap_or_default());
    let metric = stand.metric(&Value::Array(fields));

    for value_field in ["counted", "sum", "min", "max", "avg", "pass_rate"] {
        let compiled = metric
            .team_value(
                &marked(value_field),
                &[person(4)],
                &september_week(),
                stand.runner.people(),
                TableEngine::MergeTree,
                None,
            )
            .unwrap_or_else(|error| panic!("the team value compiles: {error}"));

        assert_eq!(
            only_value(&stand.run(&compiled).await),
            Value::Null,
            "{value_field}"
        );
    }

    stand.drop_database().await;
}

#[tokio::test]
async fn the_values_route_answers_each_person_and_team_from_the_rows() {
    let Some(stand) = stand_or_skip().await else {
        return;
    };
    stand.seed().await;
    let body = stand.body_by(
        json!({
            "column": "author_email", "type": "string", "as_name": "author", "person": "email"
        }),
        &lines(),
    );
    let router = stand.served("lines_merged", &body).await;
    let asked = json!({
        "metrics": ["lines_merged"],
        "person_ids": [person(1).to_string(), person(2).to_string(), person(4).to_string()],
        "teams": [{ "id": "pair", "person_ids": [person(1).to_string(), person(2).to_string()] }],
        "from": "2026-09-01",
        "to": "2026-09-08"
    });
    let request = Request::builder()
        .method("POST")
        .uri("/v1/personal-metrics/values")
        .header(header::AUTHORIZATION, format!("Bearer {}", person(9)))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(asked.to_string()))
        .unwrap_or_else(|error| panic!("the request is valid: {error}"));

    let response = router
        .oneshot(request)
        .await
        .unwrap_or_else(|error| panic!("the route answers: {error}"));
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 64 * 1024)
        .await
        .unwrap_or_else(|error| panic!("the answer is readable: {error}"));
    let answer: Value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|error| panic!("the answer is JSON: {error}"));

    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(
        answer,
        json!({
            "values": [
                { "metric": "lines_merged", "person_id": person(1).to_string(), "value": 15 },
                { "metric": "lines_merged", "person_id": person(2).to_string(), "value": 7 },
                { "metric": "lines_merged", "person_id": person(4).to_string(), "value": null }
            ],
            "teams": [{ "metric": "lines_merged", "team": "pair", "value": 22 }]
        })
    );

    stand.drop_database().await;
}
