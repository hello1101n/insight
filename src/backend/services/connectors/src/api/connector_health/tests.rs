use toolkit_canonical_errors::{CanonicalError, Problem};

use super::*;

const NAMESPACE: &str = "gts.cf.insight.analytics_api.connector_health.v1~";

fn problem(error: CanonicalError) -> Result<serde_json::Value, serde_json::Error> {
    serde_json::to_value(Problem::from(error))
}

#[test]
fn a_refusal_names_the_surface_it_refused() -> Result<(), Box<dyn std::error::Error>> {
    let p = problem(admin_only())?;
    assert_eq!(p["status"], 403);
    assert_eq!(p["context"]["resource_type"], NAMESPACE);
    Ok(())
}

#[test]
fn the_summary_contract_describes_the_recorded_schedule() -> Result<(), Box<dyn std::error::Error>>
{
    let document = serde_json::to_value(super::super::openapi_document()?)?;
    let schemas = &document["components"]["schemas"];

    assert_eq!(
        schemas["ConnectorHealth"]["properties"]["schedule"]["oneOf"][1]["$ref"],
        "#/components/schemas/AppliedSchedule"
    );
    assert_eq!(
        schemas["AppliedSchedule"]["properties"]["crons"]["minItems"],
        1
    );
    assert_eq!(
        schemas["AppliedSchedule"]["properties"]["suspended"]["type"],
        "boolean"
    );
    assert!(
        schemas["AppliedSchedule"]["required"]
            .as_array()
            .ok_or("required fields must be an array")?
            .contains(&serde_json::json!("suspended"))
    );
    assert_eq!(
        schemas["ScheduleOrigin"]["enum"],
        serde_json::json!(["api", "annotation", "descriptor", "default"])
    );
    Ok(())
}

#[test]
fn a_refusal_says_what_the_caller_is_missing() -> Result<(), Box<dyn std::error::Error>> {
    let p = problem(admin_only())?;
    assert_eq!(p["context"]["reason"], ADMIN_ONLY);
    Ok(())
}

#[test]
fn an_unusable_connector_name_is_a_bad_request_not_a_not_found()
-> Result<(), Box<dyn std::error::Error>> {
    let p = problem(unnamed_connector())?;
    assert_eq!(p["status"], 400);
    let violations = p["context"]["field_violations"]
        .as_array()
        .ok_or("field_violations must be an array")?;
    assert_eq!(violations.len(), 1);
    assert_eq!(violations[0]["field"], "connector");
    Ok(())
}

fn scope(tenant: Option<&str>, source: Option<&str>) -> SyncScopeQuery {
    SyncScopeQuery {
        tenant_id: tenant.map(str::to_owned),
        source_id: source.map(str::to_owned),
    }
}

#[test]
fn naming_neither_half_asks_about_every_installation() -> Result<(), Box<dyn std::error::Error>> {
    assert!(parse_scope(&scope(None, None))?.is_none());
    Ok(())
}

#[test]
fn naming_both_halves_narrows_to_one_installation() -> Result<(), Box<dyn std::error::Error>> {
    let (tenant, source) =
        parse_scope(&scope(Some("acme"), Some("claude-team-main")))?.ok_or("must narrow")?;
    assert_eq!(tenant.as_str(), "acme");
    assert_eq!(source.as_str(), "claude-team-main");
    Ok(())
}

#[test]
fn half_an_identity_is_refused_rather_than_quietly_widened()
-> Result<(), Box<dyn std::error::Error>> {
    for (tenant, source, missing) in [
        (Some("acme"), None, "source_id"),
        (None, Some("claude-team-main"), "tenant_id"),
    ] {
        let refusal = parse_scope(&scope(tenant, source))
            .err()
            .ok_or("half an identity must be refused")?;
        let p = problem(refusal)?;
        assert_eq!(p["status"], 400);
        assert_eq!(p["context"]["field_violations"][0]["field"], missing);
    }
    Ok(())
}

#[test]
fn an_identity_outside_the_vocabulary_is_a_bad_request() -> Result<(), Box<dyn std::error::Error>> {
    let refusal = parse_scope(&scope(Some("Acme"), Some("main")))
        .err()
        .ok_or("an unusable identity must be refused")?;
    let p = problem(refusal)?;
    assert_eq!(p["status"], 400);
    assert_eq!(p["context"]["field_violations"][0]["field"], "tenant_id");
    Ok(())
}

#[test]
fn a_read_failure_does_not_repeat_the_warehouse_to_the_caller()
-> Result<(), Box<dyn std::error::Error>> {
    let leaky = clickhouse::error::Error::BadResponse(
        "Code: 60. DB::Exception: Table ingestion_history.sync_events does not exist".to_owned(),
    );
    let p = problem(read_error(leaky))?;
    assert_eq!(p["status"], 500);
    let body = serde_json::to_string(&p)?;
    assert!(
        !body.contains("ingestion_history"),
        "an internal relation name must not cross the wire: {body}"
    );
    assert!(!body.contains("DB::Exception"), "{body}");
    Ok(())
}

#[tokio::test]
async fn connector_summary_survives_a_history_read_error() {
    let db = sea_orm::MockDatabase::new(sea_orm::DbBackend::MySql)
        .append_query_errors([sea_orm::DbErr::Custom("fixture query error".into())])
        .into_connection();
    let mut response = ConnectorHealthResponse::from_facts(LedgerFacts::default(), Utc::now());
    response
        .connectors
        .push(crate::domain::connector_health::ConnectorHealth {
            connector: "example".into(),
            tenant_id: None,
            source_id: None,
            configured: true,
            schedule: None,
            schedule_request: None,
            last_sync: None,
            latest_run: None,
            last_successful_run: None,
        });
    enrich_history(&db, "example", &mut response).await;
    assert_eq!(
        response.history_read_error.as_deref(),
        Some("Sync run history is unavailable.")
    );
    assert_eq!(response.connectors[0].connector, "example");
    assert!(response.connectors[0].configured);
    assert!(response.schedule_read_error.is_none());
}

const SYNCS_PATH: &str =
    "/v1/connector-health/example-connector/syncs?tenant_id=example-tenant&source_id=main";

async fn saved_history_api(
    runs: &[(Option<&str>, bool)],
    clickhouse_unavailable: bool,
) -> anyhow::Result<(axum::Router, Vec<String>, tokio::task::AbortHandle)> {
    use axum::{
        Router,
        http::StatusCode,
        routing::{get, post},
    };
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
    use sea_orm_migration::MigratorTrait;
    use serde_json::json;
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let upstream = Router::new()
        .route("/v1/me", get(|| async {
            Json(json!({"roles": [{"role_id": "a4d11000-0000-4000-8000-000000000001"}]}))
        }))
        .route("/", post(move || async move {
            if clickhouse_unavailable {
                (StatusCode::SERVICE_UNAVAILABLE, "The fixture warehouse is unavailable.")
            } else {
                (StatusCode::NOT_FOUND, "Code: 60. DB::Exception: Table ingestion_history.sync_events does not exist. (UNKNOWN_TABLE)")
            }
        }));
    let upstream_task = tokio::spawn(async move { axum::serve(listener, upstream).await });

    let db = Database::connect(std::env::var("INTEGRATION_TESTS_MARIADB_URL")?).await?;
    crate::migration::Migrator::up(&db, None).await?;
    let mut cluster = crate::infra::cluster::Cluster::disabled();
    cluster.namespace = uuid::Uuid::new_v4().to_string();
    cluster.client = Some(kube::Client::try_from(kube::Config::new(url.parse()?))?);
    let epoch = chrono::DateTime::<Utc>::UNIX_EPOCH + chrono::Duration::days(1);
    let mut ids = Vec::new();
    for ((status, ready), minutes) in runs.iter().zip(0_i64..) {
        let id = uuid::Uuid::new_v4().to_string();
        let start = epoch + chrono::Duration::minutes(minutes);
        let end = start + chrono::Duration::seconds(30);
        db.execute_raw(Statement::from_sql_and_values(
            DbBackend::MySql,
            "INSERT INTO ingestion_runs (sync_id,stand,tenant,connector,source_id,workflow_name,started_at,execution,finished_at,status,ready_at)
             VALUES (?,?,'example-tenant','example-connector','main','example-sync',?,?,?,?,?)",
            [id.clone().into(), cluster.namespace.clone().into(), start.into(), start.into(),
                status.map(|_|end).into(), (*status).into(), ready.then_some(end).into()],
        )).await?;
        ids.push(id);
    }

    let state = Arc::new(AppState {
        db,
        cluster,
        identity: crate::infra::identity::IdentityClient::new(&url)?,
        ch: insight_clickhouse::Client::new(insight_clickhouse::Config::new(url, "default")),
        schedule_slots: tokio::sync::Semaphore::new(1),
    });
    let router = Router::new()
        .route("/v1/connector-health", get(get_connector_health))
        .route(
            "/v1/connector-health/{connector}/syncs",
            get(get_connector_syncs),
        )
        .layer(Extension(state));
    Ok((router, ids, upstream_task.abort_handle()))
}

async fn get_json<T: serde::de::DeserializeOwned>(
    app: &axum::Router,
    path: &str,
) -> anyhow::Result<T> {
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    let response = app
        .clone()
        .oneshot(Request::get(path).body(Body::empty())?)
        .await?;
    assert_eq!(response.status(), StatusCode::OK, "GET {path}");
    Ok(serde_json::from_slice(
        &to_bytes(response.into_body(), 1 << 20).await?,
    )?)
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn summary_picks_the_latest_run_and_latest_ready_run_for_an_unconfigured_instance()
-> anyhow::Result<()> {
    let (app, ids, upstream) = saved_history_api(
        &[
            (Some("succeeded"), false),
            (None, true),
            (Some("failed"), false),
            (None, false),
        ],
        false,
    )
    .await?;
    let summary: ConnectorHealthResponse = get_json(&app, "/v1/connector-health").await?;
    upstream.abort();

    assert!(summary.history_available);
    assert_eq!(summary.connectors.len(), 1);
    let row = &summary.connectors[0];
    assert!(!row.configured);
    let latest = row
        .latest_run
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("missing latest run"))?;
    let ready = row
        .last_successful_run
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("missing ready run"))?;
    assert_eq!(latest.sync_id, ids[3]);
    assert!(latest.finished_at.is_none());
    assert_eq!(ready.sync_id, ids[1]);
    assert_eq!(ready.status, "succeeded");
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn syncs_returns_only_the_fifty_newest_runs() -> anyhow::Result<()> {
    let (app, ids, upstream) = saved_history_api(&[(Some("succeeded"), false); 52], false).await?;
    let history: SyncHistoryResponse = get_json(&app, SYNCS_PATH).await?;
    upstream.abort();

    assert_eq!(history.runs.len(), 50);
    let returned: Vec<_> = history.runs.iter().map(|run| &run.sync_id).collect();
    assert_eq!(returned, ids[2..].iter().rev().collect::<Vec<_>>());
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn clickhouse_outage_still_serves_stored_summary_and_syncs() -> anyhow::Result<()> {
    let (app, ids, upstream) = saved_history_api(&[(Some("failed"), false)], true).await?;
    let summary: ConnectorHealthResponse = get_json(&app, "/v1/connector-health").await?;
    assert!(summary.schedule_read_error.is_some());
    assert_eq!(
        summary.connectors[0]
            .latest_run
            .as_ref()
            .map(|run| &run.sync_id),
        ids.first()
    );

    let history: SyncHistoryResponse = get_json(&app, SYNCS_PATH).await?;
    upstream.abort();

    assert!(history.syncs.is_empty());
    assert_eq!(
        history
            .runs
            .iter()
            .map(|run| &run.sync_id)
            .collect::<Vec<_>>(),
        [&ids[0]]
    );
    Ok(())
}
