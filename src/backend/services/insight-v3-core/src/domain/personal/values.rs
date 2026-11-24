use std::collections::HashMap;

use serde_json::{Number, Value};

use crate::domain::access::{Caller, Grantee, PersonId};
use crate::domain::definition::{DefinitionId, DefinitionKind};
use crate::domain::folders::DefinitionStore;
use crate::domain::metric_run::MetricRuns;
use crate::domain::personal::{Calculation, Marked};
use crate::domain::query::metric_query::{MetricQuery, RunResult};
use crate::domain::query::time_window::Window;
use crate::domain::sharing::{Grant, Shared};
use crate::domain::surfaces::CustomError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Shown {
    pub(crate) marked: Marked,
    pub(crate) shared_by: Option<Grant>,
}

#[derive(Debug)]
pub(crate) struct Listed {
    pub(crate) shown: Shown,
    pub(crate) calculation: Calculation,
}

#[derive(Debug)]
pub(crate) struct Team {
    pub(crate) id: String,
    pub(crate) persons: Vec<PersonId>,
}

#[derive(Debug)]
pub(crate) struct Asked {
    pub(crate) persons: Vec<PersonId>,
    pub(crate) teams: Vec<Team>,
    pub(crate) window: Window,
}

#[derive(Debug)]
pub(crate) struct Values {
    pub(crate) persons: Vec<(PersonId, Option<Number>)>,
    pub(crate) teams: Vec<Option<Number>>,
}

#[derive(Debug)]
pub(crate) struct PersonalMetrics<'a> {
    store: &'a dyn DefinitionStore,
    runs: MetricRuns<'a>,
    caller: Caller,
}

impl<'a> PersonalMetrics<'a> {
    pub(crate) fn new(
        store: &'a dyn DefinitionStore,
        runs: MetricRuns<'a>,
        caller: Caller,
    ) -> Self {
        Self {
            store,
            runs,
            caller,
        }
    }

    pub(crate) async fn listed(&self) -> Result<Vec<Listed>, CustomError> {
        let marked = self.store.marked().await.map_err(CustomError::Store)?;

        let mut listed = Vec::with_capacity(marked.len());
        for held in marked {
            let Some(shown) = self.shown(held).await? else {
                continue;
            };
            match self.calculation(&shown.marked).await {
                Ok(calculation) => listed.push(Listed { shown, calculation }),
                Err(
                    error @ (CustomError::Body(_)
                    | CustomError::DatasetNotReady(_)
                    | CustomError::Mark(_)),
                ) => {
                    tracing::warn!(
                        %error,
                        metric_id = shown.marked.id,
                        "a personal metric is left out of the listing: its calculation cannot be read"
                    );
                }
                Err(error) => return Err(error),
            }
        }

        Ok(listed)
    }

    pub(crate) async fn asked(&self, ids: &[DefinitionId]) -> Result<Vec<Marked>, CustomError> {
        let marked: HashMap<String, Marked> = self
            .store
            .marked()
            .await
            .map_err(CustomError::Store)?
            .into_iter()
            .map(|held| (held.id.clone(), held))
            .collect();

        let mut asked = Vec::with_capacity(ids.len());
        for id in ids {
            let missing = || CustomError::NotFound {
                kind: DefinitionKind::Metric,
                id: id.as_str().to_owned(),
            };
            let held = marked.get(id.as_str()).cloned().ok_or_else(missing)?;
            if self.caller.is_administrator() {
                asked.push(held);
                continue;
            }
            let shown = self.shown(held).await?.ok_or_else(missing)?;
            asked.push(shown.marked);
        }

        Ok(asked)
    }

    pub(crate) async fn values(
        &self,
        marked: &Marked,
        asked: &Asked,
    ) -> Result<Values, CustomError> {
        let query: MetricQuery =
            serde_json::from_value(marked.body.clone()).map_err(CustomError::Body)?;
        let reading = self.runs.reading(&query).await?;

        let mut persons = Vec::with_capacity(asked.persons.len());
        if !asked.persons.is_empty() {
            let result = self
                .runs
                .run_read(&reading, |people, engine, over| {
                    query.personal_values(
                        &marked.mark,
                        &asked.persons,
                        &asked.window,
                        people,
                        engine,
                        over,
                    )
                })
                .await?;
            let mut found = by_person(&result);
            persons.extend(
                asked
                    .persons
                    .iter()
                    .map(|person| (*person, found.remove(person).flatten())),
            );
        }

        let mut teams = Vec::with_capacity(asked.teams.len());
        for team in &asked.teams {
            if team.persons.is_empty() {
                teams.push(None);
                continue;
            }
            let result = self
                .runs
                .run_read(&reading, |people, engine, over| {
                    query.team_value(
                        &marked.mark,
                        &team.persons,
                        &asked.window,
                        people,
                        engine,
                        over,
                    )
                })
                .await?;
            teams.push(only_value(&result));
        }

        Ok(Values { persons, teams })
    }

    async fn shown(&self, marked: Marked) -> Result<Option<Shown>, CustomError> {
        let Ok(id) = DefinitionId::parse(&marked.id) else {
            return Ok(None);
        };
        let grants = self
            .store
            .grants_of(Shared::Metric(&id))
            .await
            .map_err(CustomError::Store)?;

        Ok(shown(self.caller, marked, grants))
    }

    async fn calculation(&self, marked: &Marked) -> Result<Calculation, CustomError> {
        let query: MetricQuery =
            serde_json::from_value(marked.body.clone()).map_err(CustomError::Body)?;
        let declaration = self.runs.declaration_of(&query).await?;

        marked
            .mark
            .check(&query, declaration.as_ref())
            .map_err(CustomError::Mark)
    }
}

fn shown(caller: Caller, marked: Marked, grants: Vec<Grant>) -> Option<Shown> {
    if caller.is_administrator() {
        let shared_by = grants.into_iter().max_by_key(|grant| grant.created_at);
        return Some(Shown { marked, shared_by });
    }

    let reaching = |grantee: Grantee| grants.iter().find(|grant| grant.grantee == grantee);
    let shared_by = reaching(Grantee::Person(caller.person))
        .or_else(|| reaching(Grantee::Everyone))?
        .clone();

    Some(Shown {
        marked,
        shared_by: Some(shared_by),
    })
}

fn column(result: &RunResult, name: &str) -> Option<usize> {
    result.columns.iter().position(|column| column == name)
}

fn by_person(result: &RunResult) -> HashMap<PersonId, Option<Number>> {
    let (Some(person), Some(value)) = (column(result, "person_id"), column(result, "value")) else {
        return HashMap::new();
    };

    result
        .rows
        .iter()
        .filter_map(|row| {
            let id = row.get(person)?.as_str().and_then(PersonId::parse)?;
            Some((id, row.get(value).and_then(number)))
        })
        .collect()
}

fn only_value(result: &RunResult) -> Option<Number> {
    let value = column(result, "value")?;

    result.rows.first()?.get(value).and_then(number)
}

fn number(value: &Value) -> Option<Number> {
    match value {
        Value::Number(number) => Some(number.clone()),
        Value::String(text) => text
            .parse::<i64>()
            .map(Number::from)
            .or_else(|_| text.parse::<u64>().map(Number::from))
            .ok()
            .or_else(|| text.parse::<f64>().ok().and_then(Number::from_f64)),
        Value::Null | Value::Bool(_) | Value::Array(_) | Value::Object(_) => None,
    }
}

#[cfg(test)]
mod tests;
