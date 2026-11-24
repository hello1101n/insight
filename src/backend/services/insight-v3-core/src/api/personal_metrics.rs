use std::collections::{HashMap, HashSet};
use std::hash::Hash;
use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Extension, Path};
use axum::http::{HeaderMap, StatusCode, header::AUTHORIZATION};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use chrono::{SecondsFormat, Utc};
use futures::{StreamExt as _, TryStreamExt as _};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use toolkit::api::{OpenApiRegistry, OperationBuilder, ParamSpec};
use toolkit_canonical_errors::{CanonicalError, resource_error};
use utoipa::ToSchema;

use super::AppState;
use super::dashboard_widgets::{
    MAX_CONCURRENT_WIDGET_RUNS, WIDGET_RUN_ACQUIRE_TIMEOUT_SECS, run_slot,
};
use super::definitions::owner_names;
use super::errors::ApiErrors;
use super::metric_drilldown::{ColumnOut, REBUILT, RowOut, column_out, rows_out};
use crate::domain::access::{Caller, Owner, PersonId};
use crate::domain::definition::{DefinitionId, DefinitionKind};
use crate::domain::drilldown::{DEFAULT_PAGE_ROWS, DrilldownError, Records};
use crate::domain::personal::Marked;
use crate::domain::personal::values::{Asked, Listed, PersonalMetrics, Team, Values};
use crate::domain::query::metric_query::{MetricQueryError, MetricRunError};
use crate::domain::query::time_window::{RequestedRange, Window, canonical_date};
use crate::domain::surfaces::CustomError;
use crate::store::identity::IdentityError;

const MAX_METRICS: usize = 50;
const MAX_PERSONS: usize = 1000;
const MAX_TEAMS: usize = 50;
const RUNS_AT_ONCE: usize = 4;

const PERSONS_NOT_VISIBLE: &str = "the caller cannot see every person asked for";
const RUNS_BUSY: &str = "every metric run slot is taken; try again shortly";
const NOT_READ: &str = "this personal metric could not be read";
const PERSON_REFUSED: &str = "the identity service refused a person id asked for";

#[resource_error("gts.cf.insight.insight_v3_core.personal_metrics.v1~")]
struct PersonalMetricApiError;

impl ApiErrors for PersonalMetricApiError {
    fn invalid_field(field: &str, detail: String) -> CanonicalError {
        Self::invalid_argument()
            .with_field_violation(field, detail, "INVALID")
            .create()
    }

    fn timed_out(detail: &str) -> CanonicalError {
        Self::deadline_exceeded(detail).create()
    }

    fn name_taken(name: &str) -> CanonicalError {
        Self::already_exists(format!("`{name}` is already taken"))
            .with_resource(name)
            .create()
    }

    fn missing(resource: &str, detail: String) -> CanonicalError {
        Self::not_found(detail).with_resource(resource).create()
    }

    fn oversized(field: &str, detail: &str) -> CanonicalError {
        Self::invalid_argument()
            .with_field_violation(field, detail, "TOO_LARGE")
            .create()
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct ValuesRequest {
    metrics: Vec<String>,
    person_ids: Vec<String>,
    #[serde(default)]
    teams: Vec<TeamRequest>,
    from: String,
    /// The day after the last day of the period: the period ends before it.
    to: String,
}

impl toolkit::api::api_dto::RequestApiDto for ValuesRequest {}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct TeamRequest {
    id: String,
    person_ids: Vec<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct RecordsRequest {
    person_id: String,
    from: String,
    /// The day after the last day of the period: the period ends before it.
    to: String,
    #[serde(default)]
    cursor: Option<String>,
}

impl toolkit::api::api_dto::RequestApiDto for RecordsRequest {}

#[derive(Debug, Serialize)]
struct RecordsResponse {
    columns: Vec<ColumnOut>,
    rows: Vec<RowOut>,
    next_cursor: Option<String>,
}

#[derive(Debug)]
enum Read {
    Values(Values),
    Failed(Option<String>),
}

#[derive(Debug)]
struct Checked {
    metrics: Vec<DefinitionId>,
    asked: Asked,
    everyone: Vec<PersonId>,
}

pub(crate) fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    state: &Arc<AppState>,
) -> Router {
    let list = OperationBuilder::get("/v1/personal-metrics")
        .operation_id("insight_v3_core.personal_metrics.list")
        .summary("List the personal metrics the caller sees, with who shared each and when")
        .anonymous()
        .exposed()
        .json_response(
            StatusCode::OK,
            "Each metric's id, label, unit, format, direction, description, calculation and sharer",
        )
        .error_403(openapi)
        .error_500(openapi)
        .error_504(openapi)
        .handler(list_metrics)
        .register(Router::new(), openapi)
        .layer(Extension(state.clone()));

    let values = OperationBuilder::post("/v1/personal-metrics/values")
        .operation_id("insight_v3_core.personal_metrics.values")
        .summary(
            "Read personal metrics the caller sees for each person and team asked for, over a period",
        )
        .anonymous()
        .exposed()
        .json_request::<ValuesRequest>(openapi, "The metrics, persons, teams and period")
        .json_response(
            StatusCode::OK,
            "One value per metric and person, and per metric and team; null where no rows count. \
             A metric that could not be read gives no values and is listed in `errors`, \
             with a `detail` for an administrator",
        )
        .error_400(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_429(openapi)
        .error_500(openapi)
        .error_504(openapi)
        .handler(read_values)
        .register(Router::new(), openapi)
        .layer(Extension(state.clone()));

    let records = OperationBuilder::post("/v1/personal-metrics/{id}/records")
        .operation_id("insight_v3_core.personal_metrics.records")
        .summary(
            "Read the rows behind one person's value of a personal metric the caller sees, newest first, one page at a time",
        )
        .anonymous()
        .exposed()
        .param(ParamSpec::path("id").description("Metric id"))
        .json_request::<RecordsRequest>(openapi, "The person, the period and the cursor to the next page")
        .json_response(
            StatusCode::OK,
            "One page of the person's rows, its columns, and the cursor to the next",
        )
        .error_400(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_429(openapi)
        .error_500(openapi)
        .error_504(openapi)
        .handler(read_records)
        .register(Router::new(), openapi)
        .layer(Extension(state.clone()));

    router.merge(list).merge(values).merge(records)
}

async fn list_metrics(
    Extension(state): Extension<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, CanonicalError> {
    let caller = crate::api::caller(&state, &headers, unidentified).await?;

    let listed = state
        .personal_metrics(caller)
        .listed()
        .await
        .map_err(PersonalMetricApiError::custom_error)?;
    let sharers = listed
        .iter()
        .filter_map(|listed| listed.shown.shared_by.as_ref())
        .map(|grant| Owner::Person(grant.granted_by));
    let names = owner_names(
        &state,
        crate::api::forwarded_authorization(&headers),
        sharers,
    )
    .await;

    let metrics: Vec<Value> = listed
        .iter()
        .map(|listed| listed_json(listed, &names))
        .collect();
    Ok(Json(json!({ "metrics": metrics })).into_response())
}

async fn read_values(
    Extension(state): Extension<Arc<AppState>>,
    headers: HeaderMap,
    body: Result<Json<ValuesRequest>, JsonRejection>,
) -> Result<Response, CanonicalError> {
    let caller = crate::api::caller(&state, &headers, unidentified).await?;
    let Json(request) = body.map_err(|error| PersonalMetricApiError::unreadable_body(&error))?;
    let checked = checked(request)?;

    let personal = state.personal_metrics(caller);
    let metrics = personal
        .asked(&checked.metrics)
        .await
        .map_err(PersonalMetricApiError::custom_error)?;
    require_visible(&state, &headers, &checked.everyone, "person_ids").await?;

    let reads = values_of(&state, &personal, caller, &metrics, &checked.asked).await?;

    Ok(Json(answer(&metrics, &checked.asked, reads)).into_response())
}

async fn read_records(
    Extension(state): Extension<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Result<Json<RecordsRequest>, JsonRejection>,
) -> Result<Response, CanonicalError> {
    let caller = crate::api::caller(&state, &headers, unidentified).await?;
    let Json(request) = body.map_err(|error| PersonalMetricApiError::unreadable_body(&error))?;
    let person = PersonId::parse(&request.person_id).ok_or_else(|| {
        invalid(
            "person_id",
            format!("`{}` is not a person id", request.person_id),
        )
    })?;
    let window = window(&request.from, &request.to)?;
    let missing = || PersonalMetricApiError::malformed_id(DefinitionKind::Metric, &id);
    let metric = DefinitionId::parse(&id).map_err(|_| missing())?;

    let marked = state
        .personal_metrics(caller)
        .asked(std::slice::from_ref(&metric))
        .await
        .map_err(PersonalMetricApiError::custom_error)?
        .pop()
        .ok_or_else(missing)?;
    require_visible(&state, &headers, &[person], "person_id").await?;

    let _permit = run_slot(&state).await.ok_or_else(runs_busy)?;
    let asked = Records {
        person,
        window,
        cursor: request.cursor,
        limit: DEFAULT_PAGE_ROWS,
    };
    let page = state
        .drilldowns()
        .records(&marked, &asked)
        .await
        .map_err(|error| records_error(caller, &marked.id, error))?;

    Ok(Json(RecordsResponse {
        columns: page
            .columns
            .iter()
            .map(|column| column_out(column, false))
            .collect(),
        rows: rows_out(page.rows),
        next_cursor: page.next_cursor,
    })
    .into_response())
}

fn checked(request: ValuesRequest) -> Result<Checked, CanonicalError> {
    let metrics = distinct(request.metrics);
    if metrics.is_empty() {
        return Err(invalid("metrics", "ask for at least one metric".to_owned()));
    }
    if metrics.len() > MAX_METRICS {
        return Err(invalid(
            "metrics",
            format!("ask for at most {MAX_METRICS} metrics"),
        ));
    }
    if request.teams.len() > MAX_TEAMS {
        return Err(invalid(
            "teams",
            format!("ask for at most {MAX_TEAMS} teams"),
        ));
    }

    let persons = persons_of("person_ids", &request.person_ids)?;
    let teams = request
        .teams
        .into_iter()
        .map(|team| {
            Ok(Team {
                persons: persons_of("teams", &team.person_ids)?,
                id: team.id,
            })
        })
        .collect::<Result<Vec<_>, CanonicalError>>()?;
    let mut everyone: Vec<PersonId> = persons
        .iter()
        .chain(teams.iter().flat_map(|team| &team.persons))
        .copied()
        .collect();
    everyone.sort_unstable();
    everyone.dedup();
    if everyone.len() > MAX_PERSONS {
        return Err(invalid(
            "person_ids",
            format!("ask for at most {MAX_PERSONS} persons, team members included"),
        ));
    }
    if persons.is_empty() && teams.is_empty() {
        return Err(invalid(
            "person_ids",
            "ask for at least one person or one team".to_owned(),
        ));
    }

    let window = window(&request.from, &request.to)?;
    let metrics = metrics
        .iter()
        .map(|raw| {
            DefinitionId::parse(raw)
                .map_err(|_| PersonalMetricApiError::malformed_id(DefinitionKind::Metric, raw))
        })
        .collect::<Result<Vec<_>, CanonicalError>>()?;

    Ok(Checked {
        metrics,
        asked: Asked {
            persons,
            teams,
            window,
        },
        everyone,
    })
}

fn persons_of(field: &str, raw: &[String]) -> Result<Vec<PersonId>, CanonicalError> {
    let persons = raw
        .iter()
        .map(|id| {
            PersonId::parse(id).ok_or_else(|| invalid(field, format!("`{id}` is not a person id")))
        })
        .collect::<Result<Vec<_>, CanonicalError>>()?;

    Ok(distinct(persons))
}

fn distinct<T: Eq + Hash + Clone>(items: Vec<T>) -> Vec<T> {
    let mut seen = HashSet::with_capacity(items.len());

    items
        .into_iter()
        .filter(|item| seen.insert(item.clone()))
        .collect()
}

fn window(from: &str, to: &str) -> Result<Window, CanonicalError> {
    let not_a_day = |field: &str, value: &str| {
        invalid(field, format!("`{value}` is not a day written YYYY-MM-DD"))
    };
    let first = canonical_date(from).ok_or_else(|| not_a_day("from", from))?;
    let after = canonical_date(to).ok_or_else(|| not_a_day("to", to))?;
    if after <= first {
        return Err(invalid(
            "to",
            "`to` is the day after the period, so it comes after `from`".to_owned(),
        ));
    }

    RequestedRange::Interval {
        from: first,
        to: after,
    }
    .resolve(Utc::now())
    .map(Window::unbucketed)
    .map_err(|error| invalid("to", error.to_string()))
}

async fn require_visible(
    state: &AppState,
    headers: &HeaderMap,
    persons: &[PersonId],
    field: &str,
) -> Result<(), CanonicalError> {
    let Some(authorization) = headers.get(AUTHORIZATION) else {
        return Err(unidentified());
    };

    let visible = state
        .identity()
        .visible(authorization, persons)
        .await
        .map_err(|error| {
            if matches!(error, IdentityError::Refused(400)) {
                tracing::warn!(%error, "identity refused a person id asked for");
                return invalid(field, PERSON_REFUSED.to_owned());
            }
            if error.is_about_the_caller() {
                tracing::warn!(%error, "identity refused to say which persons the caller sees");
                return unidentified();
            }
            tracing::error!(%error, "the persons the caller sees could not be read");
            CanonicalError::internal("the persons the caller sees could not be read").create()
        })?;

    let unseen = persons
        .iter()
        .filter(|person| !visible.contains(person))
        .count();
    if unseen == 0 {
        return Ok(());
    }

    tracing::warn!(
        unseen,
        "personal values refused: the caller cannot see a person asked for"
    );
    Err(PersonalMetricApiError::permission_denied()
        .with_reason(PERSONS_NOT_VISIBLE)
        .create())
}

async fn values_of(
    state: &AppState,
    personal: &PersonalMetrics<'_>,
    caller: Caller,
    metrics: &[Marked],
    asked: &Asked,
) -> Result<Vec<Read>, CanonicalError> {
    let runs: Vec<_> = metrics
        .iter()
        .map(|marked| value_of(state, personal, caller, marked, asked))
        .collect();

    futures::stream::iter(runs)
        .buffered(RUNS_AT_ONCE)
        .try_collect()
        .await
}

async fn value_of(
    state: &AppState,
    personal: &PersonalMetrics<'_>,
    caller: Caller,
    marked: &Marked,
    asked: &Asked,
) -> Result<Read, CanonicalError> {
    let Some(_permit) = run_slot(state).await else {
        tracing::warn!(
            capacity = MAX_CONCURRENT_WIDGET_RUNS,
            metric_id = marked.id,
            "a personal metric found no run slot"
        );
        return Ok(failed(caller, RUNS_BUSY.to_owned()));
    };

    match personal.values(marked, asked).await {
        Ok(values) => Ok(Read::Values(values)),
        Err(CustomError::Compile(source @ MetricQueryError::RangeExceedsMaximum(_))) => Err(
            invalid("metrics", format!("metric `{}`: {source}", marked.id)),
        ),
        Err(error) => {
            tracing::error!(%error, metric_id = marked.id, "a personal metric could not be read");
            Ok(failed(caller, admin_detail(&error)))
        }
    }
}

fn failed(caller: Caller, detail: String) -> Read {
    Read::Failed(caller.is_administrator().then_some(detail))
}

fn admin_detail(error: &CustomError) -> String {
    match error {
        CustomError::Run(MetricRunError::ClickHouse(_) | MetricRunError::InvalidResponse(_)) => {
            "metric query execution failed".to_owned()
        }
        CustomError::Store(_) => "the definition store could not be read".to_owned(),
        CustomError::Datasets(_) => "the dataset store could not be read".to_owned(),
        error => error.to_string(),
    }
}

fn read_error(caller: Caller, metric: &str, field: &str, error: CustomError) -> CanonicalError {
    match error {
        CustomError::Compile(source @ MetricQueryError::RangeExceedsMaximum(_)) => {
            invalid(field, format!("metric `{metric}`: {source}"))
        }
        error @ (CustomError::Body(_) | CustomError::Compile(_)) => {
            tracing::error!(%error, metric_id = metric, "a stored personal metric cannot be read");
            if caller.is_administrator() {
                return stored_fault(metric, &error);
            }
            not_read()
        }
        error if caller.is_administrator() => PersonalMetricApiError::custom_error(error),
        error => {
            tracing::error!(%error, metric_id = metric, "a personal metric read for a member failed");
            not_read()
        }
    }
}

fn records_error(caller: Caller, metric: &str, error: DrilldownError) -> CanonicalError {
    let said = error.to_string();

    match error {
        DrilldownError::Custom(source) => read_error(caller, metric, "to", source),
        DrilldownError::Cursor(_) => invalid("cursor", said),
        DrilldownError::Rebuilt => PersonalMetricApiError::failed_precondition()
            .with_precondition_violation("metric source", REBUILT, "SOURCE_REBUILT")
            .create(),
        DrilldownError::Sort(_) | DrilldownError::PageSize | DrilldownError::Reserved(_) => {
            tracing::error!(
                said,
                metric_id = metric,
                "the records of a personal metric cannot be paged"
            );
            not_read()
        }
    }
}

fn stored_fault(metric: &str, error: &CustomError) -> CanonicalError {
    PersonalMetricApiError::data_loss(format!("metric `{metric}`: {error}"))
        .with_resource(metric)
        .create()
}

fn not_read() -> CanonicalError {
    CanonicalError::internal(NOT_READ).create()
}

fn answer(metrics: &[Marked], asked: &Asked, reads: Vec<Read>) -> Value {
    let mut persons = Vec::new();
    let mut teams = Vec::new();
    let mut errors = Vec::new();
    for (marked, read) in metrics.iter().zip(reads) {
        let values = match read {
            Read::Values(values) => values,
            Read::Failed(Some(detail)) => {
                errors.push(json!({ "metric": marked.id, "detail": detail }));
                continue;
            }
            Read::Failed(None) => {
                errors.push(json!({ "metric": marked.id }));
                continue;
            }
        };
        persons.extend(values.persons.into_iter().map(|(person, value)| {
            json!({ "metric": marked.id, "person_id": person.to_string(), "value": value })
        }));
        teams.extend(
            asked.teams.iter().zip(values.teams).map(
                |(team, value)| json!({ "metric": marked.id, "team": team.id, "value": value }),
            ),
        );
    }

    json!({ "values": persons, "teams": teams, "errors": errors })
}

fn listed_json(listed: &Listed, names: &HashMap<PersonId, String>) -> Value {
    let marked = &listed.shown.marked;
    let shared_by = listed.shown.shared_by.as_ref().map(|grant| {
        json!({
            "person_id": grant.granted_by.to_string(),
            "name": names.get(&grant.granted_by),
            "at": grant.created_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        })
    });

    json!({
        "id": marked.id,
        "label": marked.name,
        "unit": marked.mark.unit,
        "format": marked.mark.format,
        "direction": marked.mark.direction,
        "description": marked.mark.description,
        "calculation": listed.calculation,
        "shared_by": shared_by,
    })
}

fn invalid(field: &str, detail: String) -> CanonicalError {
    PersonalMetricApiError::invalid_field(field, detail)
}

fn runs_busy() -> CanonicalError {
    tracing::warn!(
        capacity = MAX_CONCURRENT_WIDGET_RUNS,
        "personal metric run capacity exhausted"
    );
    PersonalMetricApiError::resource_exhausted(RUNS_BUSY)
        .with_quota_violation("metric runs", "concurrency limit reached")
        .with_quota_violation_retry_after_seconds(WIDGET_RUN_ACQUIRE_TIMEOUT_SECS)
        .create()
}

fn unidentified() -> CanonicalError {
    PersonalMetricApiError::permission_denied()
        .with_reason(crate::api::UNIDENTIFIED)
        .create()
}

#[cfg(test)]
mod tests;
