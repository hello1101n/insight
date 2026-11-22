use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::sync::{Arc, Mutex};

use axum::body::{Body, to_bytes};
use axum::extract::{Query, State};
use axum::http::header::AUTHORIZATION;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::middleware::{Next, from_fn_with_state};
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use p256::elliptic_curve::Generate as _;
use p256::pkcs8::{EncodePrivateKey as _, LineEnding};
use sea_orm::{ConnectOptions, Database, DatabaseConnection};
use sea_orm_migration::MigratorTrait as _;
use serde_json::{Value, json};
use toolkit::api::OpenApiRegistryImpl;
use toolkit_security::SecurityContext;
use tower::ServiceExt as _;
use uuid::Uuid;

use super::{MAX_LIFETIME_DAYS, store};
use crate::api::AppState;
use crate::audit::AuditEmitter;
use crate::config::AuthenticatorConfig;
use crate::identity::IdentityPersonResolver;
use crate::issuers::IssuerSelector;
use crate::jwt::KeyStore;
use crate::local_client::LocalClient;
use crate::mcp_oauth::McpOAuthStore;
use crate::migration::{Migrator, sql_token_schema};
use crate::service_token::ServiceRegistry;
use crate::session::SessionManager;

const MARIADB_VAR: &str = "INTEGRATION_TESTS_MARIADB_URL";
const REDIS_VAR: &str = "INTEGRATION_TESTS_REDIS_URL";

pub(crate) const ADMIN: Uuid = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0001);
pub(crate) const KNOWN_PERSON: Uuid = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0002);
const UNKNOWN_PERSON: Uuid = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0003);
pub(crate) const CALLER_AUTHORIZATION: &str = "Bearer synthetic-caller-jwt";
pub(crate) const KNOWN_PERSON_NAME: &str = "Ada Example";
pub(crate) const KNOWN_PERSON_EMAIL: &str = "ada@example.com";

pub(crate) type R = Result<(), Box<dyn Error>>;

static MIGRATED: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();

pub(crate) struct Env {
    pub(crate) db: DatabaseConnection,
    pub(crate) redis_url: String,
}

pub(crate) async fn env_or_skip() -> Option<Env> {
    let (Ok(db_url), Ok(redis_url)) = (std::env::var(MARIADB_VAR), std::env::var(REDIS_VAR)) else {
        eprintln!("skipping: {MARIADB_VAR} and {REDIS_VAR} must both be set");
        return None;
    };
    let mut options = ConnectOptions::new(db_url);
    options
        .max_connections(2)
        .acquire_timeout(std::time::Duration::from_secs(3))
        .sqlx_logging(false);
    let db = Database::connect(options)
        .await
        .unwrap_or_else(|e| panic!("cannot connect to {MARIADB_VAR}: {e}"));
    MIGRATED
        .get_or_init(|| async {
            Migrator::up(&db, None)
                .await
                .unwrap_or_else(|e| panic!("cannot migrate {MARIADB_VAR}: {e}"));
        })
        .await;
    Some(Env { db, redis_url })
}

#[derive(Clone)]
pub(crate) struct StubIdentity {
    pub(crate) url: String,
    pub(crate) roster_authorizations: Arc<Mutex<Vec<Option<String>>>>,
}

struct StubState {
    roles_status: StatusCode,
    roles: Vec<String>,
    roster_status: StatusCode,
    roster: HashSet<Uuid>,
    seen: Arc<Mutex<Vec<Option<String>>>>,
}

pub(crate) struct StubSpec<'a> {
    pub(crate) roles: &'a [&'a str],
    pub(crate) roles_status: StatusCode,
    pub(crate) roster: &'a [Uuid],
    pub(crate) roster_status: StatusCode,
}

impl Default for StubSpec<'_> {
    fn default() -> Self {
        Self {
            roles: &["admin"],
            roles_status: StatusCode::OK,
            roster: &[KNOWN_PERSON],
            roster_status: StatusCode::OK,
        }
    }
}

pub(crate) async fn spawn_identity(spec: StubSpec<'_>) -> Result<StubIdentity, Box<dyn Error>> {
    let seen: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
    let state = Arc::new(StubState {
        roles_status: spec.roles_status,
        roles: spec.roles.iter().map(|role| (*role).to_owned()).collect(),
        roster_status: spec.roster_status,
        roster: spec.roster.iter().copied().collect(),
        seen: Arc::clone(&seen),
    });

    let router = Router::new()
        .route(
            "/internal/persons/active-roles",
            get(|State(state): State<Arc<StubState>>| async move {
                (state.roles_status, Json(json!({"roles": state.roles})))
            }),
        )
        .route(
            "/v1/people",
            get(
                |State(state): State<Arc<StubState>>,
                 headers: HeaderMap,
                 Query(params): Query<HashMap<String, String>>| async move {
                    let authorization = headers
                        .get(AUTHORIZATION)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned);
                    state
                        .seen
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .push(authorization);

                    let asked = params.get("ids").cloned().unwrap_or_default();
                    let items: Vec<Value> = asked
                        .split(',')
                        .filter_map(|id| Uuid::parse_str(id).ok())
                        .filter(|id| state.roster.contains(id))
                        .map(|id| {
                            json!({
                                "person_id": id.to_string(),
                                "display_name": KNOWN_PERSON_NAME,
                                "username": "ada",
                                "email": KNOWN_PERSON_EMAIL,
                            })
                        })
                        .collect();

                    (
                        state.roster_status,
                        Json(json!({"items": items, "next_cursor": null})),
                    )
                },
            ),
        )
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    Ok(StubIdentity {
        url,
        roster_authorizations: seen,
    })
}

async fn inject_caller(
    State((tenant, caller)): State<(Uuid, Uuid)>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let Ok(context) = SecurityContext::builder()
        .subject_id(caller)
        .subject_type("user")
        .subject_tenant_id(tenant)
        .build()
    else {
        unreachable!("subject_id and subject_tenant_id are set")
    };
    request.extensions_mut().insert(context);
    next.run(request).await
}

pub(crate) async fn app(
    redis_url: &str,
    identity: &StubIdentity,
    tokens_db: Option<DatabaseConnection>,
    tenant: Uuid,
) -> Result<Router, Box<dyn Error>> {
    let cfg = AuthenticatorConfig::default();
    let pem = p256::SecretKey::generate().to_pkcs8_pem(LineEnding::LF)?;
    let keystore = Arc::new(KeyStore::from_pem_for_test(&pem)?);
    let sessions = SessionManager::connect(redis_url).await?;
    let resolver = Arc::new(IdentityPersonResolver::new(
        &identity.url,
        keystore.clone(),
        cfg.gateway_issuer.clone(),
        cfg.jwt_audience.clone(),
        cfg.idp.source_type.clone(),
    )?);

    let state = Arc::new(AppState {
        oidc: IssuerSelector::build(&cfg)?,
        service_registry: ServiceRegistry::build(&cfg.service_tokens)?,
        authn_client: Arc::new(LocalClient::new(sessions.clone())),
        mcp_oauth: McpOAuthStore::connect(redis_url).await?,
        cfg,
        sessions,
        keystore,
        resolver,
        audit: AuditEmitter::disabled(),
        sql_tokens_db: tokens_db,
    });

    let openapi = OpenApiRegistryImpl::new();
    Ok(crate::api::register_routes(Router::new(), &openapi, state)
        .layer(from_fn_with_state((tenant, ADMIN), inject_caller)))
}

pub(crate) fn request(
    method: &str,
    uri: &str,
    body: Option<&Value>,
) -> Result<Request<Body>, axum::http::Error> {
    let builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(AUTHORIZATION, CALLER_AUTHORIZATION);
    match body {
        Some(body) => builder
            .header("content-type", "application/json")
            .body(Body::from(body.to_string())),
        None => builder.body(Body::empty()),
    }
}

pub(crate) async fn body_json(response: Response) -> Result<Value, Box<dyn Error>> {
    let bytes = to_bytes(response.into_body(), 256 * 1024).await?;
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_slice(&bytes)?)
}

fn create_body(label: &str) -> Value {
    json!({"person_id": KNOWN_PERSON.to_string(), "label": label})
}

async fn answer(app: &Router, request: Request<Body>) -> Result<Response, Box<dyn Error>> {
    Ok(app.clone().oneshot(request).await?)
}

#[tokio::test]
#[ignore = "requires MariaDB and Redis; set INTEGRATION_TESTS_MARIADB_URL and INTEGRATION_TESTS_REDIS_URL"]
async fn a_caller_without_the_admin_role_is_refused_on_every_route() -> R {
    let Some(env) = env_or_skip().await else {
        return Ok(());
    };
    let identity = spawn_identity(StubSpec {
        roles: &["member"],
        ..StubSpec::default()
    })
    .await?;
    let app = app(
        &env.redis_url,
        &identity,
        Some(env.db.clone()),
        Uuid::now_v7(),
    )
    .await?;

    for request in [
        request("GET", "/v1/sql-tokens", None)?,
        request("POST", "/v1/sql-tokens", Some(&create_body("laptop")))?,
        request(
            "DELETE",
            &format!("/v1/sql-tokens/{}", Uuid::now_v7()),
            None,
        )?,
    ] {
        let route = format!("{} {}", request.method(), request.uri());
        let response = answer(&app, request).await?;
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "route: {route}");
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires MariaDB and Redis; set INTEGRATION_TESTS_MARIADB_URL and INTEGRATION_TESTS_REDIS_URL"]
async fn a_caller_whose_roles_cannot_be_read_is_refused_not_failed() -> R {
    let Some(env) = env_or_skip().await else {
        return Ok(());
    };
    let identity = spawn_identity(StubSpec {
        roles_status: StatusCode::SERVICE_UNAVAILABLE,
        ..StubSpec::default()
    })
    .await?;
    let tenant = Uuid::now_v7();
    let app = app(&env.redis_url, &identity, Some(env.db.clone()), tenant).await?;

    let response = answer(
        &app,
        request("POST", "/v1/sql-tokens", Some(&create_body("laptop")))?,
    )
    .await?;

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(store::list(&env.db, tenant).await?.is_empty());
    Ok(())
}

#[tokio::test]
#[ignore = "requires MariaDB and Redis; set INTEGRATION_TESTS_MARIADB_URL and INTEGRATION_TESTS_REDIS_URL"]
async fn every_route_answers_503_when_no_database_is_configured() -> R {
    let Some(env) = env_or_skip().await else {
        return Ok(());
    };
    let identity = spawn_identity(StubSpec::default()).await?;
    let app = app(&env.redis_url, &identity, None, Uuid::now_v7()).await?;

    for request in [
        request("GET", "/v1/sql-tokens", None)?,
        request("POST", "/v1/sql-tokens", Some(&create_body("laptop")))?,
        request(
            "DELETE",
            &format!("/v1/sql-tokens/{}", Uuid::now_v7()),
            None,
        )?,
    ] {
        let route = format!("{} {}", request.method(), request.uri());
        let response = answer(&app, request).await?;
        assert_eq!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "route: {route}"
        );
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires MariaDB and Redis; set INTEGRATION_TESTS_MARIADB_URL and INTEGRATION_TESTS_REDIS_URL"]
async fn a_token_for_a_person_the_roster_does_not_know_is_refused() -> R {
    let Some(env) = env_or_skip().await else {
        return Ok(());
    };
    let identity = spawn_identity(StubSpec::default()).await?;
    let tenant = Uuid::now_v7();
    let app = app(&env.redis_url, &identity, Some(env.db.clone()), tenant).await?;

    let response = answer(
        &app,
        request(
            "POST",
            "/v1/sql-tokens",
            Some(&json!({"person_id": UNKNOWN_PERSON.to_string(), "label": "laptop"})),
        )?,
    )
    .await?;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = body_json(response).await?;
    assert!(body.to_string().contains("person_id"), "body: {body}");
    assert!(store::list(&env.db, tenant).await?.is_empty());
    Ok(())
}

#[tokio::test]
#[ignore = "requires MariaDB and Redis; set INTEGRATION_TESTS_MARIADB_URL and INTEGRATION_TESTS_REDIS_URL"]
async fn a_roster_that_cannot_be_read_creates_no_token() -> R {
    let Some(env) = env_or_skip().await else {
        return Ok(());
    };
    let identity = spawn_identity(StubSpec {
        roster_status: StatusCode::BAD_GATEWAY,
        ..StubSpec::default()
    })
    .await?;
    let tenant = Uuid::now_v7();
    let app = app(&env.redis_url, &identity, Some(env.db.clone()), tenant).await?;

    let response = answer(
        &app,
        request("POST", "/v1/sql-tokens", Some(&create_body("laptop")))?,
    )
    .await?;

    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(store::list(&env.db, tenant).await?.is_empty());
    Ok(())
}

#[tokio::test]
#[ignore = "requires MariaDB and Redis; set INTEGRATION_TESTS_MARIADB_URL and INTEGRATION_TESTS_REDIS_URL"]
async fn a_blank_or_over_budget_label_is_refused() -> R {
    let Some(env) = env_or_skip().await else {
        return Ok(());
    };
    let identity = spawn_identity(StubSpec::default()).await?;
    let tenant = Uuid::now_v7();
    let app = app(&env.redis_url, &identity, Some(env.db.clone()), tenant).await?;

    for label in [
        "   ".to_owned(),
        "x".repeat(sql_token_schema::LABEL_CHARS + 1),
    ] {
        let response = answer(
            &app,
            request("POST", "/v1/sql-tokens", Some(&create_body(&label)))?,
        )
        .await?;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body_json(response).await?;
        assert!(body.to_string().contains("label"), "body: {body}");
    }
    assert!(store::list(&env.db, tenant).await?.is_empty());
    Ok(())
}

#[tokio::test]
#[ignore = "requires MariaDB and Redis; set INTEGRATION_TESTS_MARIADB_URL and INTEGRATION_TESTS_REDIS_URL"]
async fn a_lifetime_outside_one_day_to_two_years_is_refused() -> R {
    let Some(env) = env_or_skip().await else {
        return Ok(());
    };
    let identity = spawn_identity(StubSpec::default()).await?;
    let tenant = Uuid::now_v7();
    let app = app(&env.redis_url, &identity, Some(env.db.clone()), tenant).await?;

    for days in [0, -1, MAX_LIFETIME_DAYS + 1] {
        let body = json!({
            "person_id": KNOWN_PERSON.to_string(),
            "label": "laptop",
            "lifetime_days": days,
        });
        let response = answer(&app, request("POST", "/v1/sql-tokens", Some(&body))?).await?;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "days: {days}");
        let refused = body_json(response).await?;
        assert!(
            refused.to_string().contains("lifetime_days"),
            "refused: {refused}"
        );
    }
    assert!(store::list(&env.db, tenant).await?.is_empty());
    Ok(())
}

fn days_between(from: &Value, to: &Value) -> Result<i64, Box<dyn Error>> {
    let from = chrono::DateTime::parse_from_rfc3339(from.as_str().unwrap_or_default())?;
    let to = chrono::DateTime::parse_from_rfc3339(to.as_str().unwrap_or_default())?;
    Ok((to - from).num_days())
}

#[tokio::test]
#[ignore = "requires MariaDB and Redis; set INTEGRATION_TESTS_MARIADB_URL and INTEGRATION_TESTS_REDIS_URL"]
async fn a_token_lasts_one_year_unless_the_admin_sets_its_lifetime() -> R {
    let Some(env) = env_or_skip().await else {
        return Ok(());
    };
    let identity = spawn_identity(StubSpec::default()).await?;
    let app = app(
        &env.redis_url,
        &identity,
        Some(env.db.clone()),
        Uuid::now_v7(),
    )
    .await?;

    for (body, days) in [
        (create_body("default"), 365),
        (
            json!({"person_id": KNOWN_PERSON.to_string(), "label": "month", "lifetime_days": 30}),
            30,
        ),
        (
            json!({"person_id": KNOWN_PERSON.to_string(), "label": "max", "lifetime_days": MAX_LIFETIME_DAYS}),
            MAX_LIFETIME_DAYS,
        ),
    ] {
        let response = answer(&app, request("POST", "/v1/sql-tokens", Some(&body))?).await?;
        assert_eq!(response.status(), StatusCode::CREATED, "body: {body}");
        let created = body_json(response).await?;
        assert_eq!(
            days_between(&created["created_at"], &created["expires_at"])?,
            days,
            "created: {created}"
        );
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires MariaDB and Redis; set INTEGRATION_TESTS_MARIADB_URL and INTEGRATION_TESTS_REDIS_URL"]
async fn an_admin_creates_lists_and_removes_a_personal_token() -> R {
    let Some(env) = env_or_skip().await else {
        return Ok(());
    };
    let identity = spawn_identity(StubSpec::default()).await?;
    let tenant = Uuid::now_v7();
    let app = app(&env.redis_url, &identity, Some(env.db.clone()), tenant).await?;

    let response = answer(
        &app,
        request("POST", "/v1/sql-tokens", Some(&create_body("  laptop  ")))?,
    )
    .await?;
    assert_eq!(response.status(), StatusCode::CREATED);
    let created = body_json(response).await?;
    let token = created["token"].as_str().unwrap_or_default().to_owned();
    let token_id = created["token_id"].as_str().unwrap_or_default().to_owned();
    assert!(token.starts_with("isql_"), "created: {created}");
    assert_eq!(created["person_id"], json!(KNOWN_PERSON.to_string()));
    assert_eq!(created["label"], json!("laptop"));

    let holder = store::holder(&env.db, &super::TokenHash::of(&token), chrono::Utc::now()).await?;
    assert_eq!(
        holder.map(|holder| holder.person_id),
        Some(KNOWN_PERSON),
        "the shown token must be the one the exchange looks up"
    );

    let listed = body_json(answer(&app, request("GET", "/v1/sql-tokens", None)?).await?).await?;
    let items = listed["items"].as_array().cloned().unwrap_or_default();
    assert_eq!(items.len(), 1, "listed: {listed}");
    assert_eq!(items[0]["token_id"], json!(token_id));
    assert_eq!(items[0]["label"], json!("laptop"));
    assert_eq!(
        items[0]["person"],
        json!({
            "person_id": KNOWN_PERSON.to_string(),
            "display_name": KNOWN_PERSON_NAME,
            "username": "ada",
            "email": KNOWN_PERSON_EMAIL,
        })
    );
    assert_eq!(
        items[0]["created_by"],
        json!({
            "person_id": ADMIN.to_string(),
            "display_name": "",
            "username": "",
            "email": null,
        }),
        "a person with no roster entry shows by id with empty names"
    );
    assert!(
        !listed.to_string().contains(&token),
        "a list must never carry the token: {listed}"
    );
    let forwarded = identity
        .roster_authorizations
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    assert!(
        forwarded
            .iter()
            .all(|auth| auth.as_deref() == Some(CALLER_AUTHORIZATION)),
        "roster reads must carry the caller's authorization: {forwarded:?}"
    );

    let removed = answer(
        &app,
        request("DELETE", &format!("/v1/sql-tokens/{token_id}"), None)?,
    )
    .await?;
    assert_eq!(removed.status(), StatusCode::NO_CONTENT);

    let again = answer(
        &app,
        request("DELETE", &format!("/v1/sql-tokens/{token_id}"), None)?,
    )
    .await?;
    assert_eq!(again.status(), StatusCode::NOT_FOUND);

    let listed = body_json(answer(&app, request("GET", "/v1/sql-tokens", None)?).await?).await?;
    assert_eq!(listed["items"], json!([]));
    Ok(())
}

#[tokio::test]
#[ignore = "requires MariaDB and Redis; set INTEGRATION_TESTS_MARIADB_URL and INTEGRATION_TESTS_REDIS_URL"]
async fn an_admin_cannot_list_or_remove_another_tenants_token() -> R {
    let Some(env) = env_or_skip().await else {
        return Ok(());
    };
    let identity = spawn_identity(StubSpec::default()).await?;
    let first = app(
        &env.redis_url,
        &identity,
        Some(env.db.clone()),
        Uuid::now_v7(),
    )
    .await?;
    let second = app(
        &env.redis_url,
        &identity,
        Some(env.db.clone()),
        Uuid::now_v7(),
    )
    .await?;

    let created = body_json(
        answer(
            &first,
            request("POST", "/v1/sql-tokens", Some(&create_body("laptop")))?,
        )
        .await?,
    )
    .await?;
    let token_id = created["token_id"].as_str().unwrap_or_default().to_owned();

    let listed = body_json(answer(&second, request("GET", "/v1/sql-tokens", None)?).await?).await?;
    assert_eq!(listed["items"], json!([]));

    let removed = answer(
        &second,
        request("DELETE", &format!("/v1/sql-tokens/{token_id}"), None)?,
    )
    .await?;
    assert_eq!(removed.status(), StatusCode::NOT_FOUND);

    let listed = body_json(answer(&first, request("GET", "/v1/sql-tokens", None)?).await?).await?;
    assert_eq!(listed["items"].as_array().map(Vec::len), Some(1));
    Ok(())
}
