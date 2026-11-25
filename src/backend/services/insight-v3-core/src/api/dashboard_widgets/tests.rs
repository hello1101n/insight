use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use clickhouse::test::Mock;
use serde_json::{Value, json};
use tower::ServiceExt as _;

use super::register_routes;
use crate::api::AppState;
use crate::chat::ChatClient;
use crate::domain::definition::{DefinitionId, DefinitionKind};
use crate::domain::query::metric_query::{MetricRunner, People};
use crate::store::definitions::memory::MemoryDefinitions;
use crate::store::identity::IdentityClient;

type R = Result<(), Box<dyn std::error::Error>>;

const BOARD: &str = "board";

struct Harness {
    _clickhouse: Mock,
    router: Router,
    definitions: Arc<MemoryDefinitions>,
}

impl Harness {
    fn new() -> Self {
        let mut mock = Mock::new();
        mock.non_exhaustive();
        let url = mock.url();
        let definitions = Arc::new(MemoryDefinitions::new());
        let commits = json!({
            "title": "Commits",
            "fields": [
                { "name": "occurred_at", "path": "occurred_at", "type": "datetime" },
                { "name": "lines", "path": "lines", "type": "int" }
            ]
        });
        let state = Arc::new(AppState::new(
            MetricRunner::new(
                insight_clickhouse::Client::new(insight_clickhouse::Config::new(url, "insight")),
                People::new("identity"),
            ),
            definitions.clone(),
            ChatClient::keyless(),
            IdentityClient::fixed(true),
            crate::api::Datasets::holding(url, &[("commits", commits)]),
            crate::store::catalog::Catalog::fixed(Vec::new()),
        ));
        let openapi = toolkit::api::OpenApiRegistryImpl::new();

        Self {
            _clickhouse: mock,
            router: register_routes(Router::new(), &openapi, &state),
            definitions,
        }
    }

    async fn stored(&self, kind: DefinitionKind, id: &str, body: &Value) -> R {
        self.definitions
            .seed(kind, &DefinitionId::parse(id)?, body)
            .await?;

        Ok(())
    }

    async fn listed(&self) -> Result<(StatusCode, Value), Box<dyn std::error::Error>> {
        let request = Request::builder()
            .uri(format!("/v1/dashboards/{BOARD}/widgets"))
            .body(Body::empty())?;
        let response = self.router.clone().oneshot(request).await?;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 64 * 1024).await?;

        Ok((status, serde_json::from_slice(&bytes)?))
    }
}

fn per_team(table: &str, measure: &Value) -> Value {
    json!({
        "table": table,
        "fields": [{ "column": "team", "type": "string", "as_name": "team" }, measure],
        "group_by": ["team"]
    })
}

#[derive(Debug)]
struct Case {
    widget: &'static str,
    metric: Value,
    percents: Option<Value>,
    units: Option<Value>,
}

fn cases() -> [Case; 5] {
    [
        Case {
            widget: "over-a-dataset",
            metric: json!({
                "dataset": "commits",
                "fields": [
                    { "agg": "count", "type": "int", "as_name": "total" },
                    { "field": "lines", "type": "int", "agg": "sum", "as_name": "review", "unit": "h" },
                    { "divide": ["review", "total"], "type": "float", "as_name": "share", "percent": true }
                ]
            }),
            percents: Some(json!(["share"])),
            units: Some(json!({ "review": "h" })),
        },
        Case {
            widget: "over-a-table",
            metric: per_team(
                "ci_runs",
                &json!({ "column": "duration_s", "type": "int", "agg": "avg", "as_name": "wait", "unit": "s" }),
            ),
            percents: None,
            units: Some(json!({ "wait": "s" })),
        },
        Case {
            widget: "combined",
            metric: json!({
                "combine": { "incidents": "incident-minutes", "deploys": "deploy-counts" },
                "group_by": ["team"],
                "fields": [
                    { "as_name": "minutes", "field": "incidents.minutes" },
                    { "as_name": "deploys", "field": "deploys.count" },
                    { "as_name": "rate", "divide": ["minutes", "deploys"], "percent": true }
                ]
            }),
            percents: Some(json!(["rate"])),
            units: Some(json!({ "minutes": "min" })),
        },
        Case {
            widget: "plain-count",
            metric: json!({
                "dataset": "commits",
                "fields": [{ "agg": "count", "type": "int", "as_name": "total" }]
            }),
            percents: None,
            units: None,
        },
        Case {
            widget: "not-compilable",
            metric: json!({
                "dataset": "never_declared",
                "fields": [{ "field": "lines", "type": "int", "agg": "sum", "as_name": "review", "unit": "h" }]
            }),
            percents: None,
            units: None,
        },
    ]
}

impl Harness {
    async fn board_of(&self, cases: &[Case]) -> R {
        let incidents = per_team(
            "incidents",
            &json!({ "column": "minutes", "type": "int", "agg": "sum", "as_name": "minutes", "unit": "min" }),
        );
        let deploys = per_team(
            "deploys",
            &json!({ "agg": "count", "type": "int", "as_name": "count" }),
        );
        self.stored(DefinitionKind::Metric, "incident-minutes", &incidents)
            .await?;
        self.stored(DefinitionKind::Metric, "deploy-counts", &deploys)
            .await?;

        for case in cases {
            let widget = json!({ "type": "table", "metric": case.widget, "columns": [] });
            self.stored(DefinitionKind::Metric, case.widget, &case.metric)
                .await?;
            self.stored(DefinitionKind::Widget, case.widget, &widget)
                .await?;
        }
        let items: Vec<Value> = cases
            .iter()
            .map(|case| json!({ "widget": case.widget }))
            .collect();

        self.stored(
            DefinitionKind::Dashboard,
            BOARD,
            &json!({ "title": "Board", "items": items }),
        )
        .await
    }
}

#[tokio::test]
async fn each_listed_widget_names_the_percent_and_duration_columns_its_run_would_name() -> R {
    let harness = Harness::new();
    let cases = cases();
    harness.board_of(&cases).await?;

    let (status, listed) = harness.listed().await?;

    assert_eq!(status, StatusCode::OK, "{listed}");
    let widgets = listed["items"].as_array().cloned().unwrap_or_default();
    assert_eq!(
        widgets.len(),
        cases.len(),
        "every widget is listed: {listed}"
    );
    for (case, widget) in cases.iter().zip(&widgets) {
        let id = case.widget;
        assert_eq!(widget["id"], json!(id), "{listed}");
        assert_eq!(
            widget.get("percents"),
            case.percents.as_ref(),
            "{id}: {widget}"
        );
        assert_eq!(widget.get("units"), case.units.as_ref(), "{id}: {widget}");
    }

    Ok(())
}
