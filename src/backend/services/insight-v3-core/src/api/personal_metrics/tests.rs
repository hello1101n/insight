use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use axum::routing::post;
use axum::{Json, http};
use chrono::SecondsFormat;
use serde_json::{Value, json};
use toolkit::api::OpenApiRegistryImpl;
use tower::ServiceExt as _;
use uuid::Uuid;

use crate::api::AppState;
use crate::chat::ChatClient;
use crate::domain::access::{Grantee, Level, PersonId};
use crate::domain::definition::{DefinitionId, DefinitionKind, DefinitionLabel, Definitions as _};
use crate::domain::personal::{Direction, Marks as _, MetricFormat, PersonalMark};
use crate::domain::query::metric_query::{MetricRunner, People};
use crate::domain::sharing::{Grant, Grants as _, Shared};
use crate::store::definitions::memory::MemoryDefinitions;
use crate::store::identity::IdentityClient;

const ADMIN: &str = "0192a1b2-0000-7000-8000-0000000000a1";
const LATER_ADMIN: &str = "0192a1b2-0000-7000-8000-0000000000a2";
const MEMBER: &str = "0192a1b2-0000-7000-8000-0000000000b1";
const OTHER_MEMBER: &str = "0192a1b2-0000-7000-8000-0000000000b2";
const ALICE: &str = "0192a1b2-0000-7000-8000-0000000000c1";
const BOB: &str = "0192a1b2-0000-7000-8000-0000000000c2";
const HIDDEN: &str = "0192a1b2-0000-7000-8000-0000000000d1";

const PERIOD_FROM: &str = "2026-09-01";
const PERIOD_TO: &str = "2026-09-08";

fn uuid(raw: &str) -> Uuid {
    Uuid::parse_str(raw).unwrap_or_else(|error| panic!("`{raw}` is a uuid: {error}"))
}

fn person(raw: &str) -> PersonId {
    PersonId::new(uuid(raw))
}

fn id(raw: &str) -> DefinitionId {
    DefinitionId::parse(raw).unwrap_or_else(|error| panic!("`{raw}` is an id: {error}"))
}

fn commits() -> Value {
    json!({
        "title": "Commits",
        "fields": [
            { "name": "occurred_at", "path": "occurred_at", "type": "datetime" },
            { "name": "author", "path": "author", "type": "string", "person": "email" },
            { "name": "lines", "path": "lines", "type": "int" }
        ]
    })
}

fn lines_metric() -> Value {
    json!({
        "dataset": "commits",
        "time": { "field": "occurred_at" },
        "fields": [
            { "field": "author", "type": "string", "as_name": "author" },
            { "field": "lines", "type": "int", "agg": "sum", "as_name": "lines" }
        ],
        "group_by": ["author"]
    })
}

fn lines_mark() -> PersonalMark {
    PersonalMark {
        person_field: "author".to_owned(),
        value_field: "lines".to_owned(),
        unit: Some("lines".to_owned()),
        format: MetricFormat::Number,
        direction: Direction::HigherIsBetter,
        description: "Lines merged in the period".to_owned(),
    }
}

#[derive(Debug, Clone, Copy)]
enum Upstream {
    Answering,
    Failing,
}

type Seen = Arc<std::sync::Mutex<Vec<String>>>;

const FIRST_PAGE_ROWS: usize = 101;

fn record_rows(count: usize) -> Vec<Value> {
    (0..count)
        .map(|index| {
            let time = format!(
                "2026-09-07 {:02}:{:02}:00",
                23 - index / 60,
                59 - index % 60
            );
            let record = format!("record-{index}");

            json!({
                "time": time,
                "author": "Alice Example",
                "lines": "3",
                "__drilldown_record": record,
                "__drilldown_flag": 1,
                "__drilldown_key": time,
                "__drilldown_tie0": time,
                "__drilldown_tie1": "Alice Example",
                "__drilldown_tie2": "3",
                "__drilldown_tie3": record
            })
        })
        .collect()
}

fn record_page(sql: &str) -> Value {
    let count = if sql.contains(" WHERE tuple(") {
        1
    } else {
        FIRST_PAGE_ROWS
    };

    json!({
        "meta": [
            { "name": "time", "type": "String" },
            { "name": "author", "type": "String" },
            { "name": "lines", "type": "Int64" }
        ],
        "data": record_rows(count)
    })
}

async fn clickhouse(upstream: Upstream, seen: Seen) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap_or_else(|error| panic!("the upstream must bind: {error}"));
    let address = listener
        .local_addr()
        .unwrap_or_else(|error| panic!("the upstream must have an address: {error}"));
    let answering = Router::new().route(
        "/",
        post(move |sql: String| async move {
            if let Ok(mut seen) = seen.lock() {
                seen.push(sql.clone());
            }
            if matches!(upstream, Upstream::Failing) {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "exception": "synthetic failure" })),
                );
            }
            if sql.contains("`__drilldown_flag`") {
                return (StatusCode::OK, Json(record_page(&sql)));
            }
            if sql.contains("`__rows`") {
                return (
                    StatusCode::OK,
                    Json(json!({
                        "meta": [{ "name": "value", "type": "Nullable(Int64)" }],
                        "data": [{ "value": "22" }]
                    })),
                );
            }

            (
                StatusCode::OK,
                Json(json!({
                    "meta": [
                        { "name": "person_id", "type": "String" },
                        { "name": "value", "type": "Int64" }
                    ],
                    "data": [{ "person_id": ALICE, "value": "15" }]
                })),
            )
        }),
    );
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, answering).await;
    });

    (format!("http://{address}"), server)
}

struct Harness {
    router: Router,
    definitions: Arc<MemoryDefinitions>,
    state: Arc<AppState>,
    seen: Seen,
    upstream: tokio::task::JoinHandle<()>,
}

#[derive(Debug)]
struct Answer {
    status: StatusCode,
    body: Value,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.upstream.abort();
    }
}

impl Harness {
    async fn new() -> Self {
        Self::build(Upstream::Answering, identity()).await
    }

    async fn failing() -> Self {
        Self::build(Upstream::Failing, identity()).await
    }

    async fn build(upstream: Upstream, identity: IdentityClient) -> Self {
        let seen = Seen::default();
        let (url, upstream) = clickhouse(upstream, Arc::clone(&seen)).await;
        let openapi = OpenApiRegistryImpl::new();
        let definitions = Arc::new(MemoryDefinitions::new());
        let state = Arc::new(AppState::new(
            MetricRunner::new(
                insight_clickhouse::Client::new(insight_clickhouse::Config::new(&url, "insight")),
                People::new("identity"),
            ),
            definitions.clone(),
            ChatClient::keyless(),
            identity,
            crate::api::Datasets::holding(&url, &[("commits", commits())]),
            crate::store::catalog::Catalog::fixed(Vec::new()),
        ));
        let router = super::register_routes(Router::new(), &openapi, &state);

        Self {
            router,
            definitions,
            state,
            seen,
            upstream,
        }
    }

    async fn metric(&self, raw: &str, label: &str, body: &Value) {
        let label = DefinitionLabel::parse(label)
            .unwrap_or_else(|error| panic!("`{label}` is a label: {error}"));
        self.definitions
            .create(DefinitionKind::Metric, &id(raw), &label, body)
            .await
            .unwrap_or_else(|error| panic!("the metric is stored: {error}"));
    }

    async fn marked(&self, raw: &str, label: &str) {
        self.marked_as(raw, label, &lines_metric()).await;
    }

    async fn marked_as(&self, raw: &str, label: &str, body: &Value) {
        self.metric(raw, label, body).await;
        let marked = self
            .definitions
            .mark(&id(raw), Some(&lines_mark()))
            .await
            .unwrap_or_else(|error| panic!("the mark is stored: {error}"));
        assert!(marked, "`{raw}` is a stored metric");
    }

    async fn grant(&self, raw: &str, grantee: &str, by: &str) {
        let grantee = Grantee::parse(grantee).unwrap_or_else(|| panic!("`{grantee}` is a grantee"));
        self.definitions
            .grant(Shared::Metric(&id(raw)), grantee, Level::Viewer, person(by))
            .await
            .unwrap_or_else(|error| panic!("the grant is stored: {error}"));
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }

    async fn grants(&self, raw: &str) -> Vec<Grant> {
        self.definitions
            .grants_of(Shared::Metric(&id(raw)))
            .await
            .unwrap_or_else(|error| panic!("the grants are read: {error}"))
    }

    async fn send(&self, caller: &str, method: &str, path: &str, body: Option<Value>) -> Answer {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(http::header::AUTHORIZATION, format!("Bearer {caller}"));
        let request = match body {
            Some(body) => request
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        }
        .unwrap_or_else(|error| panic!("test request must be valid: {error}"));

        let response = self
            .router
            .clone()
            .oneshot(request)
            .await
            .unwrap_or_else(|error| panic!("router must respond: {error}"));
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap_or_else(|error| panic!("response body must be readable: {error}"));
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|error| panic!("response body must be JSON: {error}"))
        };

        Answer { status, body }
    }

    async fn listed(&self, caller: &str) -> Vec<Value> {
        let answer = self.send(caller, "GET", "/v1/personal-metrics", None).await;
        assert_eq!(answer.status, StatusCode::OK, "{}", answer.body);

        answer.body["metrics"]
            .as_array()
            .cloned()
            .unwrap_or_else(|| panic!("the listing has metrics: {}", answer.body))
    }

    async fn values(&self, caller: &str, body: Value) -> Answer {
        self.send(caller, "POST", "/v1/personal-metrics/values", Some(body))
            .await
    }

    async fn records(&self, caller: &str, metric: &str, body: Value) -> Answer {
        self.send(
            caller,
            "POST",
            &format!("/v1/personal-metrics/{metric}/records"),
            Some(body),
        )
        .await
    }

    fn last_sql(&self) -> String {
        self.seen
            .lock()
            .ok()
            .and_then(|seen| seen.last().cloned())
            .unwrap_or_default()
    }
}

fn identity() -> IdentityClient {
    IdentityClient::fixed(true)
        .with_members(&[uuid(MEMBER), uuid(OTHER_MEMBER)])
        .with_strangers(&[uuid(HIDDEN)])
        .with_names(&[
            (uuid(ADMIN), "Ada Example"),
            (uuid(LATER_ADMIN), "Lin Example"),
        ])
}

fn asked(metrics: &[&str], persons: &[&str]) -> Value {
    json!({
        "metrics": metrics,
        "person_ids": persons,
        "from": PERIOD_FROM,
        "to": PERIOD_TO
    })
}

fn records_of(person: &str) -> Value {
    json!({ "person_id": person, "from": PERIOD_FROM, "to": PERIOD_TO })
}

fn rows_of(answer: &Answer) -> Vec<Value> {
    answer.body["rows"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| panic!("the page has rows: {}", answer.body))
}

fn ids_of(listed: &[Value]) -> Vec<&str> {
    listed
        .iter()
        .map(|metric| metric["id"].as_str().unwrap_or_default())
        .collect()
}

fn at(grant: &Grant) -> String {
    grant
        .created_at
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn field_of(answer: &Answer) -> Value {
    answer.body["context"]["field_violations"][0]["field"].clone()
}

#[tokio::test]
async fn a_member_lists_only_shared_metrics() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;
    harness.marked("lines_everyone", "Lines for everyone").await;
    harness.marked("lines_other", "Lines for another").await;
    harness
        .metric("lines_unmarked", "Lines unmarked", &lines_metric())
        .await;
    harness.grant("lines_merged", "everyone", LATER_ADMIN).await;
    harness.grant("lines_merged", MEMBER, ADMIN).await;
    harness
        .grant("lines_everyone", "everyone", LATER_ADMIN)
        .await;
    harness.grant("lines_other", OTHER_MEMBER, ADMIN).await;
    harness.grant("lines_unmarked", MEMBER, ADMIN).await;

    let listed = harness.listed(MEMBER).await;

    assert_eq!(ids_of(&listed), ["lines_everyone", "lines_merged"]);
    let to_member = harness
        .grants("lines_merged")
        .await
        .into_iter()
        .find(|grant| grant.grantee == Grantee::Person(person(MEMBER)))
        .unwrap_or_else(|| panic!("the member grant is stored"));
    assert_eq!(
        listed[1],
        json!({
            "id": "lines_merged",
            "label": "Lines merged",
            "unit": "lines",
            "format": "number",
            "direction": "higher_is_better",
            "description": "Lines merged in the period",
            "calculation": "sum",
            "shared_by": { "person_id": ADMIN, "name": "Ada Example", "at": at(&to_member) }
        })
    );
    assert_eq!(listed[0]["shared_by"]["person_id"], json!(LATER_ADMIN));
}

#[tokio::test]
async fn an_admin_lists_every_marked_metric() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;
    harness.marked("lines_unshared", "Lines unshared").await;
    harness
        .metric("lines_unmarked", "Lines unmarked", &lines_metric())
        .await;
    harness.grant("lines_merged", MEMBER, ADMIN).await;
    harness.grant("lines_merged", "everyone", LATER_ADMIN).await;

    let listed = harness.listed(ADMIN).await;

    assert_eq!(ids_of(&listed), ["lines_merged", "lines_unshared"]);
    let latest = harness
        .grants("lines_merged")
        .await
        .into_iter()
        .max_by_key(|grant| grant.created_at)
        .unwrap_or_else(|| panic!("the grants are stored"));
    assert_eq!(
        listed[0]["shared_by"],
        json!({ "person_id": LATER_ADMIN, "name": "Lin Example", "at": at(&latest) })
    );
    assert_eq!(listed[1]["shared_by"], Value::Null);
    assert_eq!(listed[1]["calculation"], json!("sum"));
}

#[tokio::test]
async fn a_metric_whose_dataset_is_not_ready_is_left_out_of_the_listing() {
    let harness = Harness::new().await;
    let mut unready = lines_metric();
    unready["dataset"] = json!("absent");
    harness.marked("lines_merged", "Lines merged").await;
    harness
        .marked_as("lines_unready", "Lines unready", &unready)
        .await;

    let listed = harness.listed(ADMIN).await;

    assert_eq!(ids_of(&listed), ["lines_merged"]);
}

#[tokio::test]
async fn values_refuse_a_person_the_caller_cannot_see() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;
    harness.grant("lines_merged", MEMBER, ADMIN).await;

    let refused = harness
        .values(MEMBER, asked(&["lines_merged"], &[ALICE, HIDDEN]))
        .await;

    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.body);
    assert!(
        refused
            .body
            .to_string()
            .contains(super::PERSONS_NOT_VISIBLE),
        "{}",
        refused.body
    );
}

#[tokio::test]
async fn values_refuse_a_team_member_the_caller_cannot_see() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;
    harness.grant("lines_merged", MEMBER, ADMIN).await;

    let refused = harness
        .values(
            MEMBER,
            json!({
                "metrics": ["lines_merged"],
                "person_ids": [ALICE],
                "teams": [{ "id": "platform", "person_ids": [BOB, HIDDEN] }],
                "from": PERIOD_FROM,
                "to": PERIOD_TO
            }),
        )
        .await;

    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.body);
    assert!(
        refused
            .body
            .to_string()
            .contains(super::PERSONS_NOT_VISIBLE),
        "{}",
        refused.body
    );
}

#[tokio::test]
async fn values_answer_null_for_a_person_without_rows() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;
    harness.grant("lines_merged", "everyone", ADMIN).await;

    let answer = harness
        .values(MEMBER, asked(&["lines_merged"], &[ALICE, BOB]))
        .await;

    assert_eq!(answer.status, StatusCode::OK, "{}", answer.body);
    assert_eq!(
        answer.body,
        json!({
            "values": [
                { "metric": "lines_merged", "person_id": ALICE, "value": 15 },
                { "metric": "lines_merged", "person_id": BOB, "value": null }
            ],
            "teams": []
        })
    );
}

#[tokio::test]
async fn values_answer_one_value_per_team() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;

    let answer = harness
        .values(
            ADMIN,
            json!({
                "metrics": ["lines_merged"],
                "person_ids": [],
                "teams": [
                    { "id": "platform", "person_ids": [ALICE, BOB] },
                    { "id": "nobody", "person_ids": [] }
                ],
                "from": PERIOD_FROM,
                "to": PERIOD_TO
            }),
        )
        .await;

    assert_eq!(answer.status, StatusCode::OK, "{}", answer.body);
    assert_eq!(
        answer.body,
        json!({
            "values": [],
            "teams": [
                { "metric": "lines_merged", "team": "platform", "value": 22 },
                { "metric": "lines_merged", "team": "nobody", "value": null }
            ]
        })
    );
}

#[tokio::test]
async fn values_refuse_1001_persons() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;
    let persons: Vec<String> = (1..=1001_u128)
        .map(|seed| Uuid::from_u128(seed).to_string())
        .collect();
    let persons: Vec<&str> = persons.iter().map(String::as_str).collect();

    let refused = harness
        .values(ADMIN, asked(&["lines_merged"], &persons))
        .await;

    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    assert_eq!(field_of(&refused), json!("person_ids"));
}

#[tokio::test]
async fn values_count_team_members_toward_the_persons_limit() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;
    let persons: Vec<String> = (1..=1001_u128)
        .map(|seed| Uuid::from_u128(seed).to_string())
        .collect();
    let (asked_alone, in_teams) = persons.split_at(500);

    let refused = harness
        .values(
            ADMIN,
            json!({
                "metrics": ["lines_merged"],
                "person_ids": asked_alone,
                "teams": [{ "id": "everyone_else", "person_ids": in_teams }],
                "from": PERIOD_FROM,
                "to": PERIOD_TO
            }),
        )
        .await;

    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
}

#[tokio::test]
async fn values_refuse_51_metrics() {
    let harness = Harness::new().await;
    let metrics: Vec<String> = (1..=51).map(|index| format!("metric_{index}")).collect();
    let metrics: Vec<&str> = metrics.iter().map(String::as_str).collect();

    let refused = harness.values(ADMIN, asked(&metrics, &[ALICE])).await;

    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    assert_eq!(field_of(&refused), json!("metrics"));
}

#[tokio::test]
async fn values_refuse_an_empty_metric_list() {
    let harness = Harness::new().await;

    let refused = harness.values(ADMIN, asked(&[], &[ALICE])).await;

    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    assert_eq!(field_of(&refused), json!("metrics"));
}

#[tokio::test]
async fn values_need_persons_or_teams() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;

    let refused = harness.values(ADMIN, asked(&["lines_merged"], &[])).await;

    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    assert_eq!(field_of(&refused), json!("person_ids"));
}

#[tokio::test]
async fn values_refuse_a_period_that_does_not_move_forward() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;

    let refused = harness
        .values(
            ADMIN,
            json!({
                "metrics": ["lines_merged"],
                "person_ids": [ALICE],
                "from": PERIOD_TO,
                "to": PERIOD_TO
            }),
        )
        .await;

    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    assert_eq!(field_of(&refused), json!("to"));
}

#[tokio::test]
async fn values_refuse_a_date_that_is_not_a_day() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;

    let refused = harness
        .values(
            ADMIN,
            json!({
                "metrics": ["lines_merged"],
                "person_ids": [ALICE],
                "from": "P30D",
                "to": PERIOD_TO
            }),
        )
        .await;

    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    assert_eq!(field_of(&refused), json!("from"));
}

#[tokio::test]
async fn values_refuse_a_period_longer_than_the_metric_allows() {
    let harness = Harness::new().await;
    let mut capped = lines_metric();
    capped["max_range"] = json!("P30D");
    harness
        .marked_as("lines_capped", "Lines capped", &capped)
        .await;

    let refused = harness
        .values(
            ADMIN,
            json!({
                "metrics": ["lines_capped"],
                "person_ids": [ALICE],
                "from": "2026-01-01",
                "to": "2026-03-01"
            }),
        )
        .await;

    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    let said = refused.body.to_string();
    assert!(said.contains("lines_capped"), "{said}");
    assert!(said.contains("exceeds maximum `P30D`"), "{said}");
}

#[tokio::test]
async fn values_refuse_a_member_a_period_longer_than_the_metric_allows() {
    let harness = Harness::new().await;
    let mut capped = lines_metric();
    capped["max_range"] = json!("P30D");
    harness
        .marked_as("lines_capped", "Lines capped", &capped)
        .await;
    harness.grant("lines_capped", "everyone", ADMIN).await;

    let refused = harness
        .values(
            MEMBER,
            json!({
                "metrics": ["lines_capped"],
                "person_ids": [ALICE],
                "from": "2026-01-01",
                "to": "2026-03-01"
            }),
        )
        .await;

    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    assert_eq!(field_of(&refused), json!("metrics"));
}

#[tokio::test]
async fn values_fail_on_the_server_when_a_stored_body_does_not_parse() {
    let harness = Harness::new().await;
    harness
        .marked_as(
            "lines_broken",
            "Lines broken",
            &json!({ "dataset": "commits", "fields": "not a list" }),
        )
        .await;

    let failed = harness
        .values(ADMIN, asked(&["lines_broken"], &[ALICE]))
        .await;

    assert_eq!(
        failed.status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "{}",
        failed.body
    );
}

#[tokio::test]
async fn values_fail_on_the_server_when_a_stored_metric_does_not_compile() {
    let harness = Harness::new().await;
    let mut broken = lines_metric();
    broken["max_range"] = json!("P1W");
    harness
        .marked_as("lines_broken", "Lines broken", &broken)
        .await;

    let failed = harness
        .values(ADMIN, asked(&["lines_broken"], &[ALICE]))
        .await;

    assert_eq!(
        failed.status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "{}",
        failed.body
    );
}

#[tokio::test]
async fn values_tell_an_admin_which_dataset_is_not_ready() {
    let harness = Harness::new().await;
    let mut unready = lines_metric();
    unready["dataset"] = json!("absent");
    harness
        .marked_as("lines_unready", "Lines unready", &unready)
        .await;

    let refused = harness
        .values(ADMIN, asked(&["lines_unready"], &[ALICE]))
        .await;

    assert_eq!(refused.status, StatusCode::NOT_FOUND, "{}", refused.body);
    assert!(
        refused.body.to_string().contains("absent"),
        "{}",
        refused.body
    );
}

#[tokio::test]
async fn values_hide_from_a_member_why_a_metric_cannot_be_read() {
    let harness = Harness::new().await;
    let mut unready = lines_metric();
    unready["dataset"] = json!("absent");
    harness
        .marked_as("lines_unready", "Lines unready", &unready)
        .await;
    harness.grant("lines_unready", "everyone", ADMIN).await;

    let failed = harness
        .values(MEMBER, asked(&["lines_unready"], &[ALICE]))
        .await;

    assert_eq!(
        failed.status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "{}",
        failed.body
    );
    assert!(
        !failed.body.to_string().contains("absent"),
        "{}",
        failed.body
    );
}

#[tokio::test]
async fn values_hide_a_metric_not_shared_with_the_caller() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;
    harness.marked("lines_other", "Lines for another").await;
    harness
        .metric("lines_unmarked", "Lines unmarked", &lines_metric())
        .await;
    harness.grant("lines_merged", MEMBER, ADMIN).await;
    harness.grant("lines_other", OTHER_MEMBER, ADMIN).await;
    harness.grant("lines_unmarked", MEMBER, ADMIN).await;

    let shown = harness
        .values(MEMBER, asked(&["lines_merged"], &[ALICE]))
        .await;

    assert_eq!(shown.status, StatusCode::OK, "{}", shown.body);
    for hidden in ["lines_other", "lines_unmarked", "no_such_metric"] {
        let refused = harness
            .values(MEMBER, asked(&["lines_merged", hidden], &[ALICE]))
            .await;

        assert_eq!(refused.status, StatusCode::NOT_FOUND, "{}", refused.body);
    }
}

#[tokio::test]
async fn values_fail_when_one_metric_run_fails() {
    let harness = Harness::failing().await;
    harness.marked("lines_merged", "Lines merged").await;

    let failed = harness
        .values(ADMIN, asked(&["lines_merged"], &[ALICE]))
        .await;

    assert_eq!(
        failed.status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "{}",
        failed.body
    );
}

#[tokio::test]
async fn values_wait_for_the_shared_run_slots() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;
    let taken = Arc::clone(harness.state.widget_run_slots())
        .acquire_many_owned(
            u32::try_from(crate::api::dashboard_widgets::MAX_CONCURRENT_WIDGET_RUNS)
                .unwrap_or_else(|error| panic!("the slot count fits: {error}")),
        )
        .await
        .unwrap_or_else(|error| panic!("the slots are taken: {error}"));

    let busy = harness
        .values(ADMIN, asked(&["lines_merged"], &[ALICE]))
        .await;
    drop(taken);
    let served = harness
        .values(ADMIN, asked(&["lines_merged"], &[ALICE]))
        .await;

    assert_eq!(busy.status, StatusCode::TOO_MANY_REQUESTS, "{}", busy.body);
    assert_eq!(served.status, StatusCode::OK, "{}", served.body);
}

#[tokio::test]
async fn an_unidentified_caller_reads_nothing() {
    let harness = Harness::build(Upstream::Answering, IdentityClient::unidentified()).await;
    harness.marked("lines_merged", "Lines merged").await;

    let listed = harness
        .send(ADMIN, "GET", "/v1/personal-metrics", None)
        .await;
    let values = harness
        .values(ADMIN, asked(&["lines_merged"], &[ALICE]))
        .await;
    let records = harness
        .records(ADMIN, "lines_merged", records_of(ALICE))
        .await;

    assert_eq!(listed.status, StatusCode::FORBIDDEN, "{}", listed.body);
    assert_eq!(values.status, StatusCode::FORBIDDEN, "{}", values.body);
    assert_eq!(records.status, StatusCode::FORBIDDEN, "{}", records.body);
}

#[tokio::test]
async fn records_refuse_a_person_the_caller_cannot_see() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;
    harness.grant("lines_merged", MEMBER, ADMIN).await;

    let shown = harness
        .records(MEMBER, "lines_merged", records_of(ALICE))
        .await;
    let refused = harness
        .records(MEMBER, "lines_merged", records_of(HIDDEN))
        .await;

    assert_eq!(shown.status, StatusCode::OK, "{}", shown.body);
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.body);
    assert!(
        refused
            .body
            .to_string()
            .contains(super::PERSONS_NOT_VISIBLE),
        "{}",
        refused.body
    );
}

#[tokio::test]
async fn records_page_with_a_cursor() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;

    let first = harness
        .records(ADMIN, "lines_merged", records_of(ALICE))
        .await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.body);
    assert_eq!(rows_of(&first).len(), 100);
    let cursor = first.body["next_cursor"]
        .as_str()
        .unwrap_or_else(|| panic!("a full page has a cursor: {}", first.body))
        .to_owned();

    let mut continued = records_of(ALICE);
    continued["cursor"] = json!(cursor);
    let second = harness.records(ADMIN, "lines_merged", continued).await;

    assert_eq!(second.status, StatusCode::OK, "{}", second.body);
    assert_eq!(rows_of(&second).len(), 1);
    assert_eq!(second.body["next_cursor"], Value::Null);
    assert!(
        harness.last_sql().contains(") AS __m WHERE tuple("),
        "{}",
        harness.last_sql()
    );
}

#[tokio::test]
async fn records_read_the_newest_rows_first() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;

    let answer = harness
        .records(ADMIN, "lines_merged", records_of(ALICE))
        .await;

    assert_eq!(answer.status, StatusCode::OK, "{}", answer.body);
    let sql = harness.last_sql();
    assert!(
        sql.contains("ifNull(toString(__m.`time`), '') AS `__drilldown_key`"),
        "{sql}"
    );
    assert!(
        sql.ends_with(
            " ORDER BY `__drilldown_flag` DESC, `__drilldown_key` DESC, \
             `__drilldown_tie0` DESC, `__drilldown_tie1` DESC, `__drilldown_tie2` DESC, \
             `__drilldown_tie3` DESC LIMIT 101"
        ),
        "{sql}"
    );
}

#[tokio::test]
async fn records_answer_in_the_drilldown_shape() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;

    let answer = harness
        .records(ADMIN, "lines_merged", records_of(ALICE))
        .await;

    assert_eq!(answer.status, StatusCode::OK, "{}", answer.body);
    assert_eq!(
        answer.body["columns"],
        json!([
            { "key": "time", "label": "time", "type": "date",
              "sortable": false, "percent": false, "exact": false },
            { "key": "author", "label": "author", "type": "string",
              "sortable": false, "percent": false, "exact": false },
            { "key": "lines", "label": "lines", "type": "number",
              "sortable": false, "percent": false, "exact": false }
        ])
    );
    assert_eq!(
        rows_of(&answer)[0],
        json!({ "values": { "time": "2026-09-07 23:59:00", "author": "Alice Example", "lines": 3 } })
    );
    let mut keys: Vec<&String> = answer
        .body
        .as_object()
        .map(|answer| answer.keys().collect())
        .unwrap_or_default();
    keys.sort();
    assert_eq!(keys, ["columns", "next_cursor", "rows"]);
}

#[tokio::test]
async fn records_refuse_a_cursor_issued_for_another_person() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;
    let first = harness
        .records(ADMIN, "lines_merged", records_of(ALICE))
        .await;
    let cursor = first.body["next_cursor"].clone();

    let mut elsewhere = records_of(BOB);
    elsewhere["cursor"] = cursor;
    let refused = harness.records(ADMIN, "lines_merged", elsewhere).await;

    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    assert_eq!(field_of(&refused), json!("cursor"));
}

#[tokio::test]
async fn records_refuse_a_cursor_that_does_not_decode() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;

    let mut broken = records_of(ALICE);
    broken["cursor"] = json!("not a cursor!");
    let refused = harness.records(ADMIN, "lines_merged", broken).await;

    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    assert_eq!(field_of(&refused), json!("cursor"));
}

#[tokio::test]
async fn records_refuse_a_person_id_that_is_not_a_uuid() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;

    let refused = harness
        .records(ADMIN, "lines_merged", records_of("alice"))
        .await;

    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    assert_eq!(field_of(&refused), json!("person_id"));
}

#[tokio::test]
async fn records_refuse_a_period_that_does_not_move_forward() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;

    let refused = harness
        .records(
            ADMIN,
            "lines_merged",
            json!({ "person_id": ALICE, "from": PERIOD_TO, "to": PERIOD_FROM }),
        )
        .await;

    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    assert_eq!(field_of(&refused), json!("to"));
}

#[tokio::test]
async fn records_hide_a_metric_not_shared_with_the_caller() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;
    harness.marked("lines_other", "Lines for another").await;
    harness
        .metric("lines_unmarked", "Lines unmarked", &lines_metric())
        .await;
    harness.grant("lines_merged", MEMBER, ADMIN).await;
    harness.grant("lines_other", OTHER_MEMBER, ADMIN).await;
    harness.grant("lines_unmarked", MEMBER, ADMIN).await;

    let shown = harness
        .records(MEMBER, "lines_merged", records_of(ALICE))
        .await;
    assert_eq!(shown.status, StatusCode::OK, "{}", shown.body);
    for hidden in ["lines_other", "lines_unmarked", "no_such_metric"] {
        let refused = harness.records(MEMBER, hidden, records_of(ALICE)).await;

        assert_eq!(
            refused.status,
            StatusCode::NOT_FOUND,
            "{hidden}: {}",
            refused.body
        );
    }
}

#[tokio::test]
async fn records_tell_an_admin_which_dataset_is_not_ready() {
    let harness = Harness::new().await;
    let mut unready = lines_metric();
    unready["dataset"] = json!("absent");
    harness
        .marked_as("lines_unready", "Lines unready", &unready)
        .await;

    let refused = harness
        .records(ADMIN, "lines_unready", records_of(ALICE))
        .await;

    assert_eq!(refused.status, StatusCode::NOT_FOUND, "{}", refused.body);
    assert!(
        refused.body.to_string().contains("absent"),
        "{}",
        refused.body
    );
}

#[tokio::test]
async fn records_hide_from_a_member_why_a_metric_cannot_be_read() {
    let harness = Harness::new().await;
    let mut unready = lines_metric();
    unready["dataset"] = json!("absent");
    harness
        .marked_as("lines_unready", "Lines unready", &unready)
        .await;
    harness.grant("lines_unready", "everyone", ADMIN).await;

    let failed = harness
        .records(MEMBER, "lines_unready", records_of(ALICE))
        .await;

    assert_eq!(
        failed.status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "{}",
        failed.body
    );
    assert!(
        !failed.body.to_string().contains("absent"),
        "{}",
        failed.body
    );
}

#[tokio::test]
async fn records_fail_on_the_server_when_a_stored_body_does_not_parse() {
    let harness = Harness::new().await;
    harness
        .marked_as(
            "lines_broken",
            "Lines broken",
            &json!({ "dataset": "commits", "fields": "not a list" }),
        )
        .await;

    let failed = harness
        .records(ADMIN, "lines_broken", records_of(ALICE))
        .await;

    assert_eq!(
        failed.status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "{}",
        failed.body
    );
}

#[tokio::test]
async fn records_wait_for_the_shared_run_slots() {
    let harness = Harness::new().await;
    harness.marked("lines_merged", "Lines merged").await;
    let taken = Arc::clone(harness.state.widget_run_slots())
        .acquire_many_owned(
            u32::try_from(crate::api::dashboard_widgets::MAX_CONCURRENT_WIDGET_RUNS)
                .unwrap_or_else(|error| panic!("the slot count fits: {error}")),
        )
        .await
        .unwrap_or_else(|error| panic!("the slots are taken: {error}"));

    let busy = harness
        .records(ADMIN, "lines_merged", records_of(ALICE))
        .await;
    drop(taken);
    let served = harness
        .records(ADMIN, "lines_merged", records_of(ALICE))
        .await;

    assert_eq!(busy.status, StatusCode::TOO_MANY_REQUESTS, "{}", busy.body);
    assert_eq!(served.status, StatusCode::OK, "{}", served.body);
}
