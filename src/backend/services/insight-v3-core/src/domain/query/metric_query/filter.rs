use insight_clickhouse::{Param, Sql, sql};
use serde::Deserialize;

use super::MetricQueryError;
use super::field::{FieldType, Source};
use super::over::Over;
use crate::domain::kinds::dataset::declaration::FieldType as DeclaredType;
use crate::domain::kinds::dataset::read::Form;

fn placeholder(declared: DeclaredType, filter: Param) -> Sql {
    match declared {
        DeclaredType::Datetime => sql!(
            "parseDateTime64BestEffortOrNull({filter}, 3, 'UTC')",
            filter = filter
        ),
        DeclaredType::String | DeclaredType::Int | DeclaredType::Float | DeclaredType::Bool => {
            sql!("{filter}", filter = filter)
        }
    }
}

fn compared(read: String, operator: &str, value: Sql) -> Sql {
    sql!(
        "{read} {operator} {value}",
        read = Sql::raw(read),
        operator = Sql::raw(operator),
        value = value,
    )
}

#[derive(Debug, Deserialize)]
pub(super) struct Filter {
    #[serde(default, rename = "field")]
    pub(super) declared: Option<String>,
    #[serde(default)]
    pub(super) json: Option<String>,
    #[serde(default)]
    pub(super) column: Option<String>,
    pub(super) r#type: FieldType,
    pub(super) op: FilterOp,
    pub(super) value: serde_json::Value,
}

impl Filter {
    pub(super) fn reads(&self) -> Option<&str> {
        self.declared.as_deref()
    }

    pub(super) fn physical_keys(&self, at: &str, into: &mut Vec<(String, &'static str)>) {
        if self.json.is_some() {
            into.push((format!("{at}.json"), "json"));
        }
        if self.column.is_some() {
            into.push((format!("{at}.column"), "column"));
        }
    }

    pub(super) fn source(&self) -> Result<Source<'_>, MetricQueryError> {
        Source::resolve(self.json.as_deref(), self.column.as_deref())
            .ok_or_else(|| MetricQueryError::FieldSource("a filter".to_owned()))
    }

    pub(super) fn predicate(
        &self,
        over: Option<Over<'_>>,
        qualifier: Option<&str>,
    ) -> Result<Sql, MetricQueryError> {
        let operator = self.op.sql();

        if let Some(over) = over {
            let read = over.read_as(self.declared.as_deref(), "a filter", qualifier, Form::Raw)?;
            let declared = over.type_of(self.declared.as_deref(), "a filter")?;
            let named = self.declared.as_deref().unwrap_or("a filter");
            let bound = self.declared_bind(declared, named)?;

            return Ok(compared(read, operator, placeholder(declared, bound)));
        }

        let source = self.source()?;
        let read = source.sql(self.r#type, qualifier)?;
        let bound = self.bind(source)?;

        Ok(compared(read, operator, sql!("{filter}", filter = bound)))
    }

    fn declared_bind(
        &self,
        declared: DeclaredType,
        named: &str,
    ) -> Result<Param, MetricQueryError> {
        match declared {
            DeclaredType::String | DeclaredType::Datetime => self.value.as_str().map(Param::string),
            DeclaredType::Int => self.value.as_i64().map(Param::int64),
            DeclaredType::Float => self.value.as_f64().map(Param::float64),
            DeclaredType::Bool => self.value.as_bool().map(Param::bool),
        }
        .ok_or_else(|| MetricQueryError::FilterValue(named.to_owned()))
    }

    pub(super) fn bind(&self, source: Source<'_>) -> Result<Param, MetricQueryError> {
        match self.r#type {
            FieldType::String => self.value.as_str().map(Param::string),
            FieldType::Int => self.value.as_i64().map(Param::int64),
            FieldType::Float => self.value.as_f64().map(Param::float64),
        }
        .ok_or_else(|| MetricQueryError::FilterValue(source.name().to_owned()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum FilterOp {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
}

impl FilterOp {
    pub(super) fn sql(self) -> &'static str {
        match self {
            Self::Eq => "=",
            Self::Ne => "!=",
            Self::Gt => ">",
            Self::Gte => ">=",
            Self::Lt => "<",
            Self::Lte => "<=",
        }
    }
}
