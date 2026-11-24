use std::sync::Arc;

use axum::http::request::Parts;
use rmcp::handler::server::tool::Extension;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use serde_json::{Value, json};
use uuid::Uuid;

use super::{CustomSurfaces, GranteeRequest, MetricRequest, WriteRequest};
use crate::api::AppState;
use crate::chat::ChatClient;
use crate::domain::query::metric_query::{MetricRunner, People};
use crate::store::catalog::Catalog;
use crate::store::definitions::memory::MemoryDefinitions;
use crate::store::identity::IdentityClient;

const URL_VAR: &str = "INTEGRATION_TESTS_CLICKHOUSE_URL";
const ADMIN: &str = "0192a1b2-0000-7000-8000-000000000001";
const ALICE: &str = "0192a1b2-0000-7000-8000-0000000000c1";
const STRANGER: &str = "0192a1b2-0000-7000-8000-0000000000d1";

struct Stand {
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
    let database = format!("sharing_{}", Uuid::now_v7().simple());
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
            "INSERT INTO {database}.identity_persons \
             (value_type, value_effective, person_id, created_at) VALUES \
             ('email', 'alice@example.com', toUUID('{ALICE}'), now64(6))"
        ),
    )
    .await;

    Some(Stand { client, database })
}

impl Stand {
    fn surfaces(&self) -> CustomSurfaces {
        let identity = IdentityClient::new("http://identity.invalid")
            .unwrap_or_else(|error| panic!("a plain http base URL builds a client: {error}"));
        let state = Arc::new(AppState::new(
            MetricRunner::new(
                insight_clickhouse::Client::new(self.client.config().clone()),
                People::new(self.database.clone()),
            ),
            Arc::new(MemoryDefinitions::new()),
            ChatClient::keyless(),
            identity,
            crate::api::Datasets::holding(
                "http://offline.invalid",
                &[(
                    "commits",
                    json!({
                        "title": "Commits",
                        "fields": [
                            { "name": "occurred_at", "path": "occurred_at", "type": "datetime",
                              "default_clock": true },
                            { "name": "author", "path": "author", "type": "string",
                              "person": "email" },
                            { "name": "lines", "path": "lines", "type": "int" }
                        ]
                    }),
                )],
            ),
            Catalog::fixed(Vec::new()),
        ));

        CustomSurfaces::new(state)
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

fn administrator() -> Extension<Parts> {
    let Ok(request) = axum::http::Request::builder().body(()) else {
        panic!("an empty request builds");
    };
    let (mut parts, ()) = request.into_parts();
    parts
        .extensions
        .insert(crate::mcp::auth::McpCaller(ADMIN.to_owned()));

    Extension(parts)
}

fn to_grantee(metric: &str, grantee: &str) -> Parameters<GranteeRequest> {
    Parameters(GranteeRequest {
        metric: metric.to_owned(),
        grantee: grantee.to_owned(),
    })
}

fn structured(result: &CallToolResult) -> Value {
    assert_ne!(
        result.is_error,
        Some(true),
        "should be accepted: {result:?}"
    );

    result
        .structured_content
        .clone()
        .unwrap_or_else(|| panic!("an accepted call carries structured content: {result:?}"))
}

fn refusal(result: &CallToolResult) -> String {
    assert_eq!(result.is_error, Some(true), "should be refused: {result:?}");

    result
        .content
        .iter()
        .filter_map(|block| block.as_text().map(|text| text.text.clone()))
        .collect::<Vec<_>>()
        .join(" ")
}

#[tokio::test]
async fn an_mcp_share_finds_a_known_person_in_the_warehouse_and_refuses_a_stranger() {
    let Some(stand) = stand_or_skip().await else {
        return;
    };
    let surfaces = stand.surfaces();
    let written = surfaces
        .put_metric(
            administrator(),
            Parameters(WriteRequest {
                id: None,
                name: "Lines".to_owned(),
                body: json!({
                    "dataset": "commits",
                    "fields": [
                        { "field": "author", "type": "string", "as_name": "author" },
                        { "field": "lines", "type": "int", "agg": "sum", "as_name": "lines" }
                    ],
                    "group_by": ["author"]
                }),
            }),
        )
        .await;
    let metric = structured(&written)["id"]
        .as_str()
        .unwrap_or_else(|| panic!("a write answers its id"))
        .to_owned();

    let shared = surfaces
        .share_metric(administrator(), to_grantee(&metric, ALICE))
        .await;
    let refused = surfaces
        .share_metric(administrator(), to_grantee(&metric, STRANGER))
        .await;
    let listed = surfaces
        .list_metric_grants(
            administrator(),
            Parameters(MetricRequest {
                metric: metric.clone(),
            }),
        )
        .await;

    assert_eq!(structured(&shared)["grantee"], ALICE);
    let said = refusal(&refused);
    assert!(said.contains(STRANGER), "{said}");
    let grants = structured(&listed)["grants"].clone();
    assert_eq!(grants.as_array().map(Vec::len), Some(1), "{grants}");
    assert_eq!(grants[0]["grantee"], ALICE);

    stand.drop_database().await;
}
