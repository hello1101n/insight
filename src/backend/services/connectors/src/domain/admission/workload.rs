use std::sync::Arc;
use std::time::Duration;

use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::routing::{post, put};
use axum::{Extension, Json, Router};
use chrono::{DateTime, Utc};
use k8s_openapi::api::authentication::v1::{TokenReview, TokenReviewSpec};
use k8s_openapi::api::core::v1::Pod;
use kube::Api;
use kube::api::{ApiResource, DynamicObject, GroupVersionKind, PostParams};
use serde::Deserialize;

use super::{Request, capacity, store};
use crate::api::AppState;
use crate::domain::connector_health::{ConnectorName, SourceId};
use store::{AirbyteWrite, Claim, Reply, WriteError};

const AUDIENCE: &str = "insight-connectors";
const STAGES: &[&str] = &[
    "bronze",
    "transform-jira-staging",
    "transform-staging",
    "identity-seed",
    "transform-jira-silver",
    "transform-legacy",
    "connector-checks",
];

pub(crate) fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/v1/ingestion/stage-requests", post(register))
        .route("/v1/ingestion/stage-requests/work-start", post(work_start))
        .route("/v1/ingestion/stage-requests/airbyte-claim", post(claim))
        .route("/v1/ingestion/stage-requests/airbyte-job", put(receipt))
        .route("/v1/ingestion/stage-requests/airbyte-retry", post(retry))
        .route("/v1/ingestion/stage-requests/airbyte-poll", post(poll))
        .layer(Extension(Arc::new(tokio::sync::Semaphore::new(1))))
        .layer(DefaultBodyLimit::max(8192))
        .with_state(state)
}

fn valid(req: &Request) -> bool {
    req.attempt > 0
        && req.mode_signature.as_ref().is_none_or(|v| {
            v.len() == 64
                && v.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        && !req.workflow_name.is_empty()
        && req.workflow_name.len() <= 253
        && req
            .workflow_name
            .bytes()
            .all(|v| v.is_ascii_lowercase() || v.is_ascii_digit() || v == b'-' || v == b'.')
        && STAGES.contains(&req.stage.as_str())
        && ConnectorName::parse(&req.connector).is_some()
        && SourceId::parse(&req.source_id).is_some()
        && (req.stage == "bronze") == req.connection_id.is_some()
        && req
            .connection_id
            .as_ref()
            .is_none_or(|id| uuid::Uuid::parse_str(id).is_ok())
}
#[derive(Clone, Copy)]
enum Caller {
    Gate,
    Work,
    Trigger,
    Retry,
    Poll(u64),
}
fn matches_node(
    node: &serde_json::Value,
    req: &Request,
    caller: Caller,
    attempt_label: Option<&str>,
) -> bool {
    if node["type"] != "Pod" {
        return false;
    }
    let template = node["templateName"]
        .as_str()
        .or_else(|| node["templateRef"]["template"].as_str());
    let parameter = |name: &str| {
        node["inputs"]["parameters"]
            .as_array()?
            .iter()
            .find(|p| p["name"].as_str() == Some(name))?["value"]
            .as_str()
    };
    let attempt = req.attempt.to_string();
    let conn = parameter("connection_id").filter(|v| !v.is_empty());
    if conn != req.connection_id.as_deref() {
        return false;
    }
    match caller {
        Caller::Work => {
            req.stage != "bronze"
                && matches!(
                    node["templateRef"]["name"].as_str(),
                    Some("dbt-run" | "connector-checks" | "identity-seed-run")
                )
                && parameter("admission_start_guard") == Some("workflow-v1")
                && parameter("admission_stage") == Some(&req.stage)
                && attempt_label == Some(&attempt)
        }
        Caller::Gate => {
            template == Some("request-stage")
                && parameter("mode_signature").filter(|v| !v.is_empty())
                    == req.mode_signature.as_deref()
                && parameter("stage") == Some(&req.stage)
                && parameter("attempt") == Some(&attempt)
                && parameter("admission_connector") == Some(&req.connector)
                && parameter("admission_source_id") == Some(&req.source_id)
        }
        Caller::Poll(job) => {
            req.stage == "bronze"
                && template == Some("poll-job")
                && parameter("attempt") == Some(&attempt)
                && parameter("job_id").and_then(|v| v.parse::<u64>().ok()) == Some(job)
        }
        Caller::Trigger | Caller::Retry => {
            req.stage == "bronze"
                && template
                    == Some(if matches!(caller, Caller::Trigger) {
                        "trigger-sync"
                    } else {
                        "retry-bronze"
                    })
                && parameter("attempt").or(attempt_label) == Some(&attempt)
        }
    }
}
struct WorkflowFacts {
    created_at: DateTime<Utc>,
    custom_selection: bool,
    bronze_volume: Option<super::BronzeVolume>,
}

async fn auth(
    state: &AppState,
    headers: &HeaderMap,
    req: &Request,
    caller: Caller,
) -> Result<WorkflowFacts, StatusCode> {
    if !valid(req) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| !v.is_empty())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    tokio::time::timeout(Duration::from_secs(10), identity(state, token, req, caller))
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
}
fn unavailable(_: kube::Error) -> StatusCode {
    StatusCode::SERVICE_UNAVAILABLE
}

async fn bound_pod(
    client: &kube::Client,
    cluster: &crate::infra::cluster::Cluster,
    token: &str,
    req: &Request,
) -> Result<Pod, StatusCode> {
    let review = Api::<TokenReview>::all(client.clone())
        .create(
            &PostParams::default(),
            &TokenReview {
                spec: TokenReviewSpec {
                    token: token.to_owned(),
                    audiences: Some(vec![AUDIENCE.to_owned()]),
                },
                ..Default::default()
            },
        )
        .await
        .map_err(unavailable)?
        .status
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if review.authenticated != Some(true)
        || !review
            .audiences
            .is_some_and(|v| v.iter().any(|a| a == AUDIENCE))
    {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let who = review.user.ok_or(StatusCode::UNAUTHORIZED)?;
    let username = format!(
        "system:serviceaccount:{}:{}",
        cluster.namespace, cluster.workflow_sa
    );
    if who.username.as_deref() != Some(username.as_str()) {
        return Err(StatusCode::FORBIDDEN);
    }
    let extra = who.extra.ok_or(StatusCode::FORBIDDEN)?;
    let one = |k: &str| {
        extra
            .get(k)
            .and_then(|v| (v.len() == 1).then(|| v[0].as_str()))
            .ok_or(StatusCode::FORBIDDEN)
    };
    let pod_name = one("authentication.kubernetes.io/pod-name")?;
    let pod_uid = one("authentication.kubernetes.io/pod-uid")?;
    let pod = Api::<Pod>::namespaced(client.clone(), &cluster.namespace)
        .get_opt(pod_name)
        .await
        .map_err(unavailable)?
        .ok_or(StatusCode::FORBIDDEN)?;
    let uid = req.sync_id.to_string();
    if pod.metadata.uid.as_deref() != Some(pod_uid)
        || pod.metadata.deletion_timestamp.is_some()
        || !pod
            .metadata
            .owner_references
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|o| {
                o.kind == "Workflow"
                    && o.api_version == "argoproj.io/v1alpha1"
                    && o.controller == Some(true)
                    && o.uid == uid
                    && o.name == req.workflow_name
            })
    {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(pod)
}

async fn identity(
    state: &AppState,
    token: &str,
    req: &Request,
    caller: Caller,
) -> Result<WorkflowFacts, StatusCode> {
    let cluster = &state.cluster;
    let client = cluster
        .client
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let pod = bound_pod(client, cluster, token, req).await?;
    let uid = req.sync_id.to_string();
    let ar = ApiResource::from_gvk(&GroupVersionKind::gvk(
        "argoproj.io",
        "v1alpha1",
        "Workflow",
    ));
    let api = Api::<DynamicObject>::namespaced_with(client.clone(), &cluster.namespace, &ar);
    let wf = api
        .get_opt(&req.workflow_name)
        .await
        .map_err(unavailable)?
        .ok_or(StatusCode::FORBIDDEN)?;
    if wf.metadata.uid.as_deref() != Some(uid.as_str())
        || wf.metadata.deletion_timestamp.is_some()
        || wf
            .data
            .pointer("/spec/workflowTemplateRef/name")
            .and_then(|v| v.as_str())
            != Some("ingestion-pipeline")
    {
        return Err(StatusCode::FORBIDDEN);
    }
    if wf
        .data
        .pointer("/status/finishedAt")
        .is_some_and(|v| !v.is_null())
        || wf
            .data
            .pointer("/spec/shutdown")
            .and_then(|v| v.as_str())
            .is_some_and(|v| !v.is_empty())
    {
        return Err(StatusCode::CONFLICT);
    }
    let args = wf
        .data
        .pointer("/spec/arguments/parameters")
        .and_then(|v| v.as_array())
        .ok_or(StatusCode::FORBIDDEN)?;
    let arg = |n: &str| {
        args.iter()
            .find(|p| p["name"].as_str() == Some(n))
            .and_then(|p| p["value"].as_str())
    };
    if arg("insight_source_id") != Some(req.source_id.as_str())
        || arg("data_source") != Some(req.connector.as_str())
    {
        return Err(StatusCode::FORBIDDEN);
    }
    let node_id = pod
        .metadata
        .annotations
        .as_ref()
        .and_then(|m| m.get("workflows.argoproj.io/node-id"))
        .ok_or(StatusCode::FORBIDDEN)?;
    let node = wf.data["status"]["nodes"]
        .get(node_id)
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let attempt = pod
        .metadata
        .labels
        .as_ref()
        .and_then(|m| m.get("insight.cyberfabric.com/attempt"))
        .map(String::as_str);
    if !matches_node(node, req, caller, attempt) {
        return Err(StatusCode::FORBIDDEN);
    }
    if matches!(caller, Caller::Work) {
        allow_work_start(state, &api, &wf, req).await?;
    }
    let custom_selection =
        custom_jira_selection(&req.stage, arg("dbt_select_staging"), arg("dbt_select"));
    wf.metadata
        .creation_timestamp
        .and_then(|ts| DateTime::from_timestamp_millis(ts.0.as_millisecond()))
        .map(|created_at| WorkflowFacts {
            created_at,
            custom_selection,
            bronze_volume: if matches!(caller, Caller::Gate) && req.stage != "bronze" {
                super::reconcile::bronze_volume(&wf.data["status"])
            } else {
                None
            },
        })
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)
}

fn custom_jira_selection(stage: &str, staging: Option<&str>, downstream: Option<&str>) -> bool {
    match stage {
        "transform-jira-staging" => staging != Some("tag:staging,tag:jira"),
        "transform-jira-silver" => downstream != Some("tag:silver,tag:jira+ tag:gold,tag:jira+"),
        _ => false,
    }
}

async fn allow_work_start(
    state: &AppState,
    api: &Api<DynamicObject>,
    wf: &DynamicObject,
    req: &Request,
) -> Result<(), StatusCode> {
    use sea_orm::ConnectionTrait;
    let uid = req.sync_id.to_string();
    let key = super::reconcile::placement::key(&req.stage, req.attempt);
    let granted = state
        .db
        .query_one_raw(store::sql(
            "SELECT 1 FROM ingestion_stage_attempts s JOIN ingestion_runs r USING(sync_id)
         WHERE r.tenant=? AND r.stand=? AND s.sync_id=? AND s.stage=? AND s.attempt=?
         AND s.granted_at IS NOT NULL AND s.finished_at IS NULL",
            vec![
                state.cluster.tenant_id.clone().into(),
                state.cluster.namespace.clone().into(),
                uid.clone().into(),
                req.stage.clone().into(),
                req.attempt.into(),
            ],
        ))
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    if granted.is_none() {
        return Err(StatusCode::CONFLICT);
    }
    if let Some(marker) = wf.metadata.annotations.as_ref().and_then(|a| a.get(&key)) {
        return if marker == &uid {
            Ok(())
        } else {
            Err(StatusCode::CONFLICT)
        };
    }
    super::reconcile::placement::decide(api, wf, &key, false)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok(())
}

async fn work_start(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<Request>,
) -> Result<StatusCode, StatusCode> {
    auth(&state, &headers, &req, Caller::Work).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn outcome(e: WriteError) -> StatusCode {
    match e {
        WriteError::Conflict => StatusCode::CONFLICT,
        WriteError::Db(error) => {
            tracing::error!(%error,"ingestion stage write failed");
            StatusCode::SERVICE_UNAVAILABLE
        }
    }
}
async fn register(
    State(state): State<Arc<AppState>>,
    Extension(capacity_probe): Extension<Arc<tokio::sync::Semaphore>>,
    headers: HeaderMap,
    Json(mut req): Json<Request>,
) -> Result<(StatusCode, Json<Reply>), StatusCode> {
    let facts = auth(&state, &headers, &req, Caller::Gate).await?;
    req.custom_selection = facts.custom_selection;
    req.bronze_volume = facts.bronze_volume;
    let usable = if let Ok(_permit) = capacity_probe.try_acquire() {
        capacity::sample(&state).await.unwrap_or_else(|e| {
            tracing::warn!(error=%e,"ingestion capacity unavailable");
            capacity::Snapshot::default()
        })
    } else {
        capacity::Snapshot::default()
    };
    let (new, reply) = store::register(
        &state.db,
        &state.cluster.namespace,
        &state.cluster.tenant_id,
        &req,
        facts.created_at,
        usable,
    )
    .await
    .map_err(outcome)?;
    Ok((
        if new {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(reply),
    ))
}
#[derive(Deserialize)]
struct ClaimRequest {
    #[serde(flatten)]
    req: Request,
    sender: Option<uuid::Uuid>,
}
async fn claim(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ClaimRequest>,
) -> Result<Json<Claim>, StatusCode> {
    auth(&state, &headers, &body.req, Caller::Trigger).await?;
    let claim = |boundary| {
        store::airbyte(
            &state.db,
            &state.cluster.namespace,
            &state.cluster.tenant_id,
            &body.req,
            AirbyteWrite::Claim(body.sender, boundary),
        )
    };
    let existing = claim(None).await.map_err(outcome)?;
    if existing.decision != "prepare" {
        return Ok(Json(existing));
    }
    let connection = body
        .req
        .connection_id
        .as_deref()
        .ok_or(StatusCode::CONFLICT)?;
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let history = super::reconcile::airbyte::recent_jobs(&state, &http, connection).await.map_err(|error| {
        tracing::warn!(%error, %connection, "could not read Airbyte sync history before launch");
        StatusCode::SERVICE_UNAVAILABLE
    })?;
    let boundary = history
        .before_send()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    claim(Some(boundary)).await.map(Json).map_err(outcome)
}
#[derive(Deserialize)]
struct Receipt {
    #[serde(flatten)]
    req: Request,
    job_id: serde_json::Value,
}
impl Receipt {
    fn job(&self) -> Result<u64, StatusCode> {
        let id = match &self.job_id {
            serde_json::Value::String(s) => s.parse::<u64>().ok(),
            v => v.as_u64(),
        };
        id.filter(|v| *v > 0).ok_or(StatusCode::BAD_REQUEST)
    }
}

#[derive(serde::Serialize)]
struct Poll {
    cancel: bool,
}
async fn poll(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Receipt>,
) -> Result<Json<Poll>, StatusCode> {
    let job = body.job()?;
    auth(&state, &headers, &body.req, Caller::Poll(job)).await?;
    store::poll_airbyte(
        &state.db,
        &state.cluster.namespace,
        &state.cluster.tenant_id,
        &body.req,
        job,
    )
    .await
    .map_err(outcome)?;
    Ok(Json(Poll { cancel: false }))
}

async fn receipt(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Receipt>,
) -> Result<Json<Claim>, StatusCode> {
    let job = body.job()?.to_string();
    auth(&state, &headers, &body.req, Caller::Trigger).await?;
    store::airbyte(
        &state.db,
        &state.cluster.namespace,
        &state.cluster.tenant_id,
        &body.req,
        AirbyteWrite::Receipt(&job),
    )
    .await
    .map(Json)
    .map_err(outcome)
}

#[derive(Deserialize)]
struct Retry {
    #[serde(flatten)]
    req: Request,
    replay_mode_safe: bool,
}
async fn retry(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Retry>,
) -> Result<Json<Claim>, StatusCode> {
    auth(&state, &headers, &body.req, Caller::Retry).await?;
    let capacity = capacity::sample(&state)
        .await
        .unwrap_or_default()
        .uncredited();
    store::retry_bronze(
        &state.db,
        &state.cluster.namespace,
        &state.cluster.tenant_id,
        &body.req,
        body.replay_mode_safe,
        capacity,
    )
    .await
    .map(Json)
    .map_err(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn custom_jira_arguments_isolate_only_the_transform_that_uses_them() {
        let staging = Some("tag:staging,tag:jira");
        let downstream = Some("tag:silver,tag:jira+ tag:gold,tag:jira+");
        for stage in ["transform-jira-staging", "transform-jira-silver"] {
            assert!(!custom_jira_selection(stage, staging, downstream));
            assert!(custom_jira_selection(stage, None, None));
        }
        assert!(custom_jira_selection(
            "transform-jira-staging",
            Some("tag:jira"),
            downstream
        ));
        assert!(!custom_jira_selection(
            "transform-jira-silver",
            Some("tag:jira"),
            downstream
        ));
        assert!(custom_jira_selection(
            "transform-jira-silver",
            staging,
            Some("tag:jira+")
        ));
        assert!(!custom_jira_selection("transform-legacy", None, None));
        assert!(!custom_jira_selection("bronze", None, None));
    }

    #[test]
    fn gate_can_register_only_its_own_stage_attempt_and_instance() {
        let mut request = Request {
            sync_id: uuid::Uuid::now_v7(),
            workflow_name: "scheduled-jira".into(),
            custom_selection: false,
            bronze_volume: None,
            mode_signature: None,
            connector: "jira".into(),
            source_id: "installation-a".into(),
            stage: "transform-jira-silver".into(),
            attempt: 1,
            connection_id: None,
        };
        let node = json!({"type":"Pod","templateName":"request-stage","inputs":{"parameters":[{"name":"stage","value":"transform-jira-silver"},{"name":"attempt","value":"1"},{"name":"connection_id","value":""},{"name":"admission_connector","value":"jira"},{"name":"admission_source_id","value":"installation-a"}]}});
        assert!(matches_node(&node, &request, Caller::Gate, None));
        assert!(!matches_node(&node, &request, Caller::Trigger, Some("1")));
        assert!(!matches_node(
            &node,
            &request,
            Caller::Poll(8101),
            Some("1")
        ));
        request.stage = "transform-jira-staging".into();
        assert!(!matches_node(&node, &request, Caller::Gate, None));
    }
}
