use std::fmt;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::domain::definition::{DefinitionId, DefinitionStoreError};
use crate::domain::kinds::dataset::declaration::Declaration;
use crate::domain::query::metric_query::{Agg, ColumnKind, MetricQuery, Output};

pub(crate) mod values;

const RESERVED_PREFIX: &str = "__";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct PersonalMark {
    /// The `as_name` of the field that names the person.
    pub(crate) person_field: String,
    /// The `as_name` of the aggregated numeric field read as the value.
    pub(crate) value_field: String,
    /// A label for the value such as `lines`, or null for none.
    pub(crate) unit: Option<String>,
    /// How the value is written: `number`, `percent`, `duration` or `currency`.
    pub(crate) format: MetricFormat,
    /// Which way is better: `higher_is_better`, `lower_is_better` or `neutral`.
    pub(crate) direction: Direction,
    /// What the value means, in words people read.
    pub(crate) description: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MetricFormat {
    Number,
    Percent,
    Duration,
    Currency,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Direction {
    HigherIsBetter,
    LowerIsBetter,
    Neutral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Calculation {
    Sum,
    Count,
    Avg,
    Min,
    Max,
    Ratio,
    Percent,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub(crate) enum MarkError {
    #[error(
        "the personal mark names person field `{0}`, which is not one of this metric's as_name values"
    )]
    NoPersonField(String),
    #[error(
        "the personal mark names person field `{0}`, which carries no person handle: \
         set `person` on it, or read a dataset field declared with `person`"
    )]
    NoPersonHandle(String),
    #[error(
        "the personal mark names person field `{0}`, which carries an aggregate, \
         so it names no one person"
    )]
    AggregatedPerson(String),
    #[error(
        "the personal mark names value field `{0}`, which is not one of this metric's as_name values"
    )]
    NoValueField(String),
    #[error(
        "the personal mark names value field `{0}`, which carries no `agg` or `divide`, \
         so it gives no one value per person"
    )]
    NotAggregated(String),
    #[error("the personal mark names value field `{0}`, which is not a number")]
    NotANumber(String),
    #[error(
        "the personal mark names value field `{0}`, which divides a field \
         that carries no `agg`, so it gives no one value per person"
    )]
    UnaggregatedRatio(String),
    #[error(
        "`{0}` starts with `__`, which this service keeps for the names it writes itself; \
         give that field another `as_name`"
    )]
    ReservedName(String),
}

impl PersonalMark {
    pub(crate) fn check(
        &self,
        query: &MetricQuery,
        declaration: Option<&Declaration>,
    ) -> Result<Calculation, MarkError> {
        if let Some(kept) = query
            .output_names()
            .into_iter()
            .find(|name| name.starts_with(RESERVED_PREFIX))
        {
            return Err(MarkError::ReservedName(kept.to_owned()));
        }

        let person = query
            .output(&self.person_field, declaration)
            .ok_or_else(|| MarkError::NoPersonField(self.person_field.clone()))?;
        if !person.carries_a_person() {
            return Err(MarkError::NoPersonHandle(self.person_field.clone()));
        }
        if calculation(person).is_some() {
            return Err(MarkError::AggregatedPerson(self.person_field.clone()));
        }

        let value = query
            .output(&self.value_field, declaration)
            .ok_or_else(|| MarkError::NoValueField(self.value_field.clone()))?;
        let calculation =
            calculation(value).ok_or_else(|| MarkError::NotAggregated(self.value_field.clone()))?;
        if value.divides() && !query.aggregates(&self.value_field) {
            return Err(MarkError::UnaggregatedRatio(self.value_field.clone()));
        }
        if value.kind() != ColumnKind::Number {
            return Err(MarkError::NotANumber(self.value_field.clone()));
        }

        Ok(calculation)
    }
}

fn calculation(output: Output<'_>) -> Option<Calculation> {
    if output.divides() {
        return Some(if output.percent() {
            Calculation::Percent
        } else {
            Calculation::Ratio
        });
    }

    output.agg().map(|agg| match agg {
        Agg::Count => Calculation::Count,
        Agg::Sum => Calculation::Sum,
        Agg::Avg => Calculation::Avg,
        Agg::Min => Calculation::Min,
        Agg::Max => Calculation::Max,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Marked {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) mark: PersonalMark,
    pub(crate) body: serde_json::Value,
}

#[async_trait]
pub(crate) trait Marks: Send + Sync + fmt::Debug {
    async fn mark(
        &self,
        metric: &DefinitionId,
        mark: Option<&PersonalMark>,
    ) -> Result<bool, DefinitionStoreError>;

    async fn mark_of(
        &self,
        metric: &DefinitionId,
    ) -> Result<Option<PersonalMark>, DefinitionStoreError>;

    async fn marked(&self) -> Result<Vec<Marked>, DefinitionStoreError>;
}

#[cfg(test)]
mod tests;
