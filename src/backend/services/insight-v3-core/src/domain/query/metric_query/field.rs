use std::collections::HashSet;
use std::fmt::Write as _;

use insight_clickhouse::{Sql, sql};
use serde::Deserialize;

use super::MetricQueryError;
use super::filter::Filter;
use super::over::Over;
use super::people::PersonHandle;
use crate::domain::kinds::dataset::declaration::FieldType as DeclaredType;

pub(super) const MAX_IDENTIFIER_CHARS: usize = 128;

#[derive(Debug, Deserialize)]
pub(super) struct OrderBy {
    pub(super) field: String,
    #[serde(default)]
    pub(super) direction: Direction,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Direction {
    #[default]
    Asc,
    Desc,
}

impl Direction {
    pub(super) fn sql(self) -> &'static str {
        match self {
            Self::Asc => "ASC",
            Self::Desc => "DESC",
        }
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct Field {
    #[serde(default, rename = "field")]
    pub(super) declared: Option<String>,
    #[serde(default)]
    pub(super) json: Option<String>,
    #[serde(default)]
    pub(super) column: Option<String>,
    pub(super) r#type: FieldType,
    #[serde(default)]
    pub(super) agg: Option<Agg>,
    pub(super) as_name: String,
    #[serde(default)]
    pub(super) person: Option<PersonHandle>,
    #[serde(default)]
    pub(super) when: Vec<Filter>,
    #[serde(default, rename = "where")]
    pub(super) r#where: Option<Filter>,
    #[serde(default)]
    pub(super) divide: Option<Vec<String>>,
    #[serde(default)]
    pub(super) percent: bool,
    #[serde(default)]
    pub(super) exact: bool,
}

impl Field {
    pub(super) fn reads(&self) -> Option<&str> {
        self.declared.as_deref()
    }

    pub(super) fn aggregate(&self) -> Option<super::Aggregate> {
        self.agg.map(|agg| {
            if agg.arithmetic() {
                super::Aggregate::Arithmetic
            } else {
                super::Aggregate::Ordering
            }
        })
    }

    pub(super) fn result_type(&self) -> FieldType {
        self.result_type_reading(self.r#type)
    }

    pub(super) fn result_type_over(&self, over: Over<'_>) -> FieldType {
        let declared = self
            .reads()
            .and_then(|named| over.declaration.field(named))
            .map(|declared| declared.r#type);
        let read = match declared {
            Some(DeclaredType::Int) => FieldType::Int,
            Some(DeclaredType::Float) => FieldType::Float,
            Some(DeclaredType::String | DeclaredType::Datetime | DeclaredType::Bool) => {
                FieldType::String
            }
            None => self.r#type,
        };

        self.result_type_reading(read)
    }

    fn result_type_reading(&self, read: FieldType) -> FieldType {
        if self.divide.is_some() {
            return FieldType::Float;
        }

        match (self.agg, read) {
            (Some(Agg::Count), _) | (Some(Agg::Sum), FieldType::Int | FieldType::String) => {
                FieldType::Int
            }

            (Some(Agg::Avg), _) | (Some(Agg::Sum), FieldType::Float) => FieldType::Float,

            (Some(Agg::Min | Agg::Max) | None, declared) => declared,
        }
    }

    pub(super) fn conditions(&self) -> &[Filter] {
        &self.when
    }

    pub(super) fn physical_keys(&self, at: &str, into: &mut Vec<(String, &'static str)>) {
        if self.json.is_some() {
            into.push((format!("{at}.json"), "json"));
        }
        if self.column.is_some() {
            into.push((format!("{at}.column"), "column"));
        }
        if self.person.is_some() {
            into.push((format!("{at}.person"), "person"));
        }
        if self.r#where.is_some() {
            into.push((format!("{at}.where"), "where"));
        }
    }

    pub(super) fn source(&self) -> Result<Source<'_>, MetricQueryError> {
        Source::resolve(self.json.as_deref(), self.column.as_deref())
            .ok_or_else(|| MetricQueryError::FieldSource(format!("field `{}`", self.as_name)))
    }

    pub(super) fn expression(
        &self,
        over: Option<Over<'_>>,
        qualifier: Option<&str>,
    ) -> Result<Sql, MetricQueryError> {
        if self.agg == Some(Agg::Count) && self.reads_nothing() {
            return Ok(match self.condition(over, qualifier)? {
                Some(condition) => sql!("countIf({condition})", condition = condition),
                None => Sql::raw("count()"),
            });
        }

        let read = self.read(over, qualifier)?;
        let condition = self.condition(over, qualifier)?;

        Ok(self.aggregated_if(read, condition))
    }

    fn read(
        &self,
        over: Option<Over<'_>>,
        qualifier: Option<&str>,
    ) -> Result<Sql, MetricQueryError> {
        if let Some(over) = over {
            return over
                .read(self.declared.as_deref(), &self.as_name, qualifier)
                .map(Sql::raw);
        }

        let source = self.source()?;

        let Some(selector) = &self.r#where else {
            return source.sql(self.r#type, qualifier).map(Sql::raw);
        };

        let Source::Json { path, .. } = source else {
            return Err(MetricQueryError::Selector(self.as_name.clone()));
        };

        let selected = selector.source()?;
        let Source::Json { path: key, .. } = selected else {
            return Err(MetricQueryError::Selector(self.as_name.clone()));
        };

        // ClickHouse refuses `Array(String)` inside a `Nullable`, and an
        // ingested JSON column may be declared `Nullable(String)`.
        let element = sql!(
            "arrayFirst(x -> {matched} {operator} {selected}, JSONExtractArrayRaw(ifNull({payload}, '')))",
            matched = Sql::raw(selector.r#type.extract("x", key)?),
            operator = Sql::raw(selector.op.sql()),
            selected = selector.bind(selected)?,
            payload = Sql::raw(source.payload_sql(qualifier)?),
        );

        Ok(sql!(
            "{function}({element}{keys})",
            function = Sql::raw(self.r#type.function()),
            element = element,
            keys = Sql::raw(json_keys(path)?),
        ))
    }

    pub(super) fn condition(
        &self,
        over: Option<Over<'_>>,
        qualifier: Option<&str>,
    ) -> Result<Option<Sql>, MetricQueryError> {
        if self.when.is_empty() {
            return Ok(None);
        }

        let parts = self
            .when
            .iter()
            .map(|one| one.predicate(over, qualifier))
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Some(Sql::join(parts, " AND ")))
    }

    fn reads_nothing(&self) -> bool {
        self.declared.is_none() && self.json.is_none() && self.column.is_none()
    }

    /// The two are this query's own `as_name`s, already selected: `ClickHouse`
    /// resolves an alias inside the same select list, so a rate needs no
    /// second pass over the table.
    pub(super) fn ratio(
        &self,
        selected: &HashSet<&str>,
    ) -> Result<Option<String>, MetricQueryError> {
        let Some(names) = &self.divide else {
            return Ok(None);
        };

        let [numerator, denominator] = names.as_slice() else {
            return Err(MetricQueryError::Ratio(format!(
                "`{}` divides exactly two of this query's fields",
                self.as_name
            )));
        };

        for name in [numerator, denominator] {
            if !selected.contains(name.as_str()) {
                return Err(MetricQueryError::Ratio(format!(
                    "`{}` divides `{name}`, which no earlier field of this query selects",
                    self.as_name
                )));
            }
        }

        let division = format!("(`{numerator}` / nullIf(`{denominator}`, 0))");

        Ok(Some(if self.percent {
            format!("(100 * {division})")
        } else {
            division
        }))
    }

    pub(super) fn aggregated_if(&self, read: Sql, condition: Option<Sql>) -> Sql {
        let Some(agg) = self.agg else {
            return read;
        };
        let function = Sql::raw(agg.sql());

        match condition {
            Some(condition) => sql!(
                "{function}If({read}, {condition})",
                function = function,
                read = read,
                condition = condition,
            ),
            None => sql!("{function}({read})", function = function, read = read),
        }
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(super) enum Source<'a> {
    Json {
        payload: Option<&'a str>,
        path: &'a str,
    },
    Column(&'a str),
}

impl<'a> Source<'a> {
    pub(super) fn resolve(json: Option<&'a str>, column: Option<&'a str>) -> Option<Self> {
        match (json, column) {
            (Some(path), payload) => Some(Self::Json { payload, path }),
            (None, Some(column)) => Some(Self::Column(column)),
            (None, None) => None,
        }
    }

    pub(super) fn name(self) -> &'a str {
        match self {
            Self::Json { path: name, .. } | Self::Column(name) => name,
        }
    }

    pub(super) fn payload_sql(self, qualifier: Option<&str>) -> Result<String, MetricQueryError> {
        let Self::Json { payload, .. } = self else {
            return Err(MetricQueryError::Identifier(self.name().to_owned()));
        };

        Ok(match payload {
            Some(column) => qualified(column, qualifier)?,
            None => match qualifier {
                Some(alias) => format!("`{alias}`.raw_data"),
                None => "raw_data".to_owned(),
            },
        })
    }

    pub(super) fn sql(
        self,
        field_type: FieldType,
        qualifier: Option<&str>,
    ) -> Result<String, MetricQueryError> {
        match self {
            Self::Json { path, .. } => {
                let payload = self.payload_sql(qualifier)?;
                field_type.extract(&payload, path)
            }
            Self::Column(column) => qualified(column, qualifier),
        }
    }
}

fn qualified(column: &str, qualifier: Option<&str>) -> Result<String, MetricQueryError> {
    if !is_identifier(column) {
        return Err(MetricQueryError::Identifier(column.to_owned()));
    }

    Ok(match qualifier {
        Some(alias) => format!("`{alias}`.`{column}`"),
        None => format!("`{column}`"),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FieldType {
    String,
    Int,
    Float,
}

impl FieldType {
    pub(super) fn extract(self, payload: &str, path: &str) -> Result<String, MetricQueryError> {
        Ok(format!(
            "{}({payload}{})",
            self.function(),
            json_keys(path)?
        ))
    }

    fn function(self) -> &'static str {
        match self {
            Self::String => "JSONExtractString",
            Self::Int => "JSONExtractInt",
            Self::Float => "JSONExtractFloat",
        }
    }
}

fn json_keys(path: &str) -> Result<String, MetricQueryError> {
    let mut keys = String::new();
    for segment in path.split('.') {
        if segment.is_empty() || segment.chars().count() > MAX_IDENTIFIER_CHARS {
            return Err(MetricQueryError::JsonKey(path.to_owned()));
        }
        let _ = write!(keys, ", {}", json_key_literal(segment));
    }

    Ok(keys)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Agg {
    Count,
    Sum,
    Avg,
    Min,
    Max,
}

impl Agg {
    pub(super) fn arithmetic(self) -> bool {
        match self {
            Self::Sum | Self::Avg => true,
            Self::Count | Self::Min | Self::Max => false,
        }
    }

    pub(super) fn sql(self) -> &'static str {
        match self {
            Self::Count => "count",
            Self::Sum => "sum",
            Self::Avg => "avg",
            Self::Min => "min",
            Self::Max => "max",
        }
    }
}

pub(super) fn is_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_IDENTIFIER_CHARS
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn json_key_literal(key: &str) -> String {
    format!("'{}'", key.replace('\\', r"\\").replace('\'', r"\'"))
}

/// `ClickHouse`'s `JSON` format serialises wide integers as JSON strings;
/// parse the columns typed `int`/`float` back into numbers.
pub(super) fn coerce_value(value: serde_json::Value, field_type: FieldType) -> serde_json::Value {
    let serde_json::Value::String(text) = value else {
        return value;
    };

    match field_type {
        FieldType::String => {}
        FieldType::Int => {
            if let Ok(number) = text.parse::<i64>() {
                return serde_json::Value::Number(number.into());
            }
            if let Ok(number) = text.parse::<u64>() {
                return serde_json::Value::Number(number.into());
            }
        }
        FieldType::Float => {
            if let Some(number) = text
                .parse::<f64>()
                .ok()
                .and_then(serde_json::Number::from_f64)
            {
                return serde_json::Value::Number(number);
            }
        }
    }

    serde_json::Value::String(text)
}
