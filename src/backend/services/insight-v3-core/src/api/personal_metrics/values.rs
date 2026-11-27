use std::collections::HashSet;
use std::hash::Hash;
use std::sync::Arc;

use axum::Json;
use axum::extract::Extension;
use axum::extract::rejection::JsonRejection;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use futures::StreamExt as _;
use serde::Deserialize;
use serde_json::{Value, json};
use toolkit_canonical_errors::CanonicalError;
use utoipa::ToSchema;

use super::{PersonalMetricApiError, RUNS_BUSY, invalid, require_visible, unidentified, window};
use crate::api::AppState;
use crate::api::dashboard_widgets::{MAX_CONCURRENT_WIDGET_RUNS, run_slot};
use crate::api::errors::ApiErrors;
use crate::domain::access::{Caller, PersonId};
use crate::domain::definition::{DefinitionId, DefinitionKind};
use crate::domain::personal::Marked;
use crate::domain::personal::values::{Asked, PersonalMetrics, Team, Values};
use crate::domain::query::metric_query::{MetricQueryError, MetricRunError};
use crate::domain::surfaces::CustomError;

const MAX_METRICS: usize = 50;
const MAX_PERSONS: usize = 1000;
const MAX_TEAMS: usize = 50;
const RUNS_AT_ONCE: usize = 4;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct ValuesRequest {
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

pub(super) async fn read_values(
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

    let reads = values_of(&state, &personal, caller, &metrics, &checked.asked).await;

    Ok(Json(answer(&metrics, &checked.asked, reads)).into_response())
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

async fn values_of(
    state: &AppState,
    personal: &PersonalMetrics<'_>,
    caller: Caller,
    metrics: &[Marked],
    asked: &Asked,
) -> Vec<Read> {
    let runs: Vec<_> = metrics
        .iter()
        .map(|marked| value_of(state, personal, caller, marked, asked))
        .collect();

    futures::stream::iter(runs)
        .buffered(RUNS_AT_ONCE)
        .collect()
        .await
}

async fn value_of(
    state: &AppState,
    personal: &PersonalMetrics<'_>,
    caller: Caller,
    marked: &Marked,
    asked: &Asked,
) -> Read {
    // INVARIANT: the permit lives until this metric's values answer; it is what
    // caps concurrent metric runs at MAX_CONCURRENT_WIDGET_RUNS.
    let Some(_permit) = run_slot(state).await else {
        tracing::warn!(
            capacity = MAX_CONCURRENT_WIDGET_RUNS,
            metric_id = marked.id,
            "a personal metric found no run slot"
        );
        return failed(caller, RUNS_BUSY.to_owned());
    };

    match personal.values(marked, asked).await {
        Ok(values) => Read::Values(values),
        Err(CustomError::Compile(source @ MetricQueryError::RangeExceedsMaximum(_))) => {
            failed(caller, source.to_string())
        }
        Err(error) => {
            tracing::error!(%error, metric_id = marked.id, "a personal metric could not be read");
            failed(caller, admin_detail(&error))
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
