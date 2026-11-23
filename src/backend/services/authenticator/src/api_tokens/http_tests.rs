use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::sync::Arc;

use axum::body::{Body, to_bytes};
use axum::extract::{Query, State};
use axum::http::header::AUTHORIZATION;
use axum::http::{Request, StatusCode};
use axum::middleware::{Next, from_fn_with_state};
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use chrono::DateTime;
use sea_orm::DatabaseConnection;
use serde_json::{Value, json};
use toolkit::api::OpenApiRegistryImpl;
use toolkit_security::SecurityContext;
use tower::ServiceExt as _;
use uuid::Uuid;

use super::{MAX_LIFETIME_DAYS, store};
use crate::api::AppState;
use crate::audit::AuditEmitter;
use crate::config::AuthenticatorConfig;
use crate::migration::api_token_schema;

const REDIS_VAR: &str = "INTEGRATION_TESTS_REDIS_URL";
const TOKENS: &str = "/v1/api-tokens";

pub(crate) const ADMIN: Uuid = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0001);
pub(crate) const KNOWN_PERSON: Uuid = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0002);
const UNKNOWN_PERSON: Uuid = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0003);
const CALLER_AUTHORIZATION: &str = "Bearer synthetic-caller-jwt";
pub(crate) const KNOWN_PERSON_NAME: &str = "Ada Example";
pub(crate) const KNOWN_PERSON_EMAIL: &str = "ada@example.com";

pub(crate) type R = Result<(), Box<dyn Error>>;

pub(crate) struct Env {
    pub(crate) db: DatabaseConnection,
    pub(crate) redis_url: String,
}

pub(crate) async fn env_or_skip() -> Option<Env> {
    let Ok(redis_url) = std::env::var(REDIS_VAR) else {
        eprintln!("skipping: {REDIS_VAR} not set");
        return None;
    };
    let db = super::live_tests::connect_or_skip().await?;
    Some(Env { db, redis_url })
}

struct StubState {
    roles_status: StatusCode,
    roles: Vec<String>,
    roster_status: StatusCode,
    roster: HashSet<Uuid>,
}

#[derive(Clone, Copy)]
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

pub(crate) async fn spawn_identity(spec: StubSpec<'_>) -> Result<String, Box<dyn Error>> {
    let state = Arc::new(StubState {
        roles_status: spec.roles_status,
        roles: spec.roles.iter().map(|role| (*role).to_owned()).collect(),
        roster_status: spec.roster_status,
        roster: spec.roster.iter().copied().collect(),
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
                 Query(params): Query<HashMap<String, String>>| async move {
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

    Ok(url)
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
    identity_url: &str,
    tokens_db: Option<DatabaseConnection>,
    tenant: Uuid,
    audit: AuditEmitter,
) -> Result<Router, Box<dyn Error>> {
    let cfg = AuthenticatorConfig::default();
    let state = AppState::for_test(redis_url, identity_url, cfg, audit, tokens_db).await?;
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

fn lifetime_body(days: i64) -> Value {
    json!({"person_id": KNOWN_PERSON.to_string(), "label": "laptop", "lifetime_days": days})
}

async fn answer(app: &Router, request: Request<Body>) -> Result<Response, Box<dyn Error>> {
    Ok(app.clone().oneshot(request).await?)
}

#[tokio::test]
#[ignore = "requires MariaDB and Redis; set INTEGRATION_TESTS_MARIADB_URL and INTEGRATION_TESTS_REDIS_URL"]
async fn a_refused_request_stores_no_token() -> R {
    let Some(env) = env_or_skip().await else {
        return Ok(());
    };
    let admin = StubSpec::default();
    let member = StubSpec {
        roles: &["member"],
        ..admin
    };
    let roles_down = StubSpec {
        roles_status: StatusCode::SERVICE_UNAVAILABLE,
        ..admin
    };
    let roster_down = StubSpec {
        roster_status: StatusCode::BAD_GATEWAY,
        ..admin
    };
    let one = format!("{TOKENS}/{}", Uuid::now_v7());
    let get = || request("GET", TOKENS, None);
    let post = |body: &Value| request("POST", TOKENS, Some(body));
    let delete = || request("DELETE", &one, None);
    let laptop = create_body("laptop");
    let stranger = json!({"person_id": UNKNOWN_PERSON.to_string(), "label": "laptop"});
    let blank = create_body("   ");
    let long = create_body(&"x".repeat(api_token_schema::LABEL_CHARS + 1));
    let no_days = lifetime_body(0);
    let over_max = lifetime_body(MAX_LIFETIME_DAYS + 1);
    let (forbidden, invalid) = (StatusCode::FORBIDDEN, StatusCode::BAD_REQUEST);
    let unavailable = StatusCode::SERVICE_UNAVAILABLE;
    let failed = StatusCode::INTERNAL_SERVER_ERROR;
    let (person, label, days) = (Some("person_id"), Some("label"), Some("lifetime_days"));

    let cases = [
        (member, true, get()?, forbidden, None),
        (member, true, post(&laptop)?, forbidden, None),
        (member, true, delete()?, forbidden, None),
        (roles_down, true, post(&laptop)?, forbidden, None),
        (admin, false, get()?, unavailable, None),
        (admin, false, post(&laptop)?, unavailable, None),
        (admin, false, delete()?, unavailable, None),
        (admin, true, post(&stranger)?, invalid, person),
        (roster_down, true, post(&laptop)?, failed, None),
        (admin, true, post(&blank)?, invalid, label),
        (admin, true, post(&long)?, invalid, label),
        (admin, true, post(&no_days)?, invalid, days),
        (admin, true, post(&over_max)?, invalid, days),
    ];

    for (case, (spec, database, request, status, field)) in cases.into_iter().enumerate() {
        let identity = spawn_identity(spec).await?;
        let tenant = Uuid::now_v7();
        let db = database.then(|| env.db.clone());
        let app = app(
            &env.redis_url,
            &identity,
            db,
            tenant,
            AuditEmitter::disabled(),
        )
        .await?;
        let route = format!("{} {}", request.method(), request.uri());

        let response = answer(&app, request).await?;

        assert_eq!(response.status(), status, "case {case}: {route}");
        let refusal = body_json(response).await?.to_string();
        if let Some(field) = field {
            assert!(refusal.contains(field), "case {case}: {refusal}");
        }
        assert!(
            store::list(&env.db, tenant).await?.is_empty(),
            "case {case}"
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
    let (audit, mut events) = AuditEmitter::recording();
    let app = app(
        &env.redis_url,
        &identity,
        Some(env.db.clone()),
        tenant,
        audit,
    )
    .await?;

    let response = answer(
        &app,
        request("POST", TOKENS, Some(&create_body("  laptop  ")))?,
    )
    .await?;
    assert_eq!(response.status(), StatusCode::CREATED);
    let created = body_json(response).await?;
    let token = created["token"].as_str().unwrap_or_default().to_owned();
    let token_id = created["token_id"].as_str().unwrap_or_default().to_owned();
    assert!(token.starts_with("iapi_"), "created: {created}");
    assert_eq!(created["person_id"], json!(KNOWN_PERSON.to_string()));
    assert_eq!(created["label"], json!("laptop"));
    let lifetime =
        DateTime::parse_from_rfc3339(created["expires_at"].as_str().unwrap_or_default())?
            - DateTime::parse_from_rfc3339(created["created_at"].as_str().unwrap_or_default())?;
    assert_eq!(lifetime.num_days(), 365, "created: {created}");

    let holder = store::holder(&env.db, &super::TokenHash::of(&token), chrono::Utc::now()).await?;
    assert_eq!(
        holder.map(|holder| holder.person_id),
        Some(KNOWN_PERSON),
        "the shown token must be the one the exchange looks up"
    );

    let listed = body_json(answer(&app, request("GET", TOKENS, None)?).await?).await?;
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

    let one = format!("{TOKENS}/{token_id}");
    let removed = answer(&app, request("DELETE", &one, None)?).await?;
    assert_eq!(removed.status(), StatusCode::NO_CONTENT);
    let again = answer(&app, request("DELETE", &one, None)?).await?;
    assert_eq!(again.status(), StatusCode::NOT_FOUND);
    let listed = body_json(answer(&app, request("GET", TOKENS, None)?).await?).await?;
    assert_eq!(listed["items"], json!([]));

    for action in ["api_token_created", "api_token_removed"] {
        let event = events.try_recv()?;
        assert_eq!(
            (event.action, event.resource_id),
            (action, token_id.clone())
        );
    }
    assert!(events.try_recv().is_err(), "an extra audit event");
    Ok(())
}
