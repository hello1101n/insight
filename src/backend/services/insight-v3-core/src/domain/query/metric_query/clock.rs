use insight_clickhouse::{Param, Sql, sql};
use serde::Deserialize;

use super::MetricQueryError;
use super::field::{FieldType, Source};
use crate::domain::query::time_window::{Bounds, Grain, Window};

#[derive(Debug, Deserialize)]
pub(super) struct TimeField {
    #[serde(default, rename = "field")]
    pub(super) declared: Option<String>,
    #[serde(default)]
    pub(super) json: Option<String>,
    #[serde(default)]
    pub(super) column: Option<String>,
    #[serde(default = "datetime_type")]
    pub(super) r#type: String,
}

fn datetime_type() -> String {
    "datetime".to_owned()
}

impl TimeField {
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
        if self.r#type != "datetime" {
            return Err(MetricQueryError::ClockType(self.r#type.clone()));
        }
        Source::resolve(self.json.as_deref(), self.column.as_deref())
            .ok_or(MetricQueryError::ClockSource)
    }
}

pub(super) fn clock_expression(
    source: Source<'_>,
    qualifier: Option<&str>,
) -> Result<String, MetricQueryError> {
    let read = source.sql(FieldType::String, qualifier)?;

    Ok(match source {
        Source::Json { .. } => format!("parseDateTimeBestEffortOrNull({read})"),
        Source::Column(_) => read,
    })
}

pub(super) fn bucket_expression(grain: Grain, clock: &str) -> String {
    // WORKAROUND: ClickHouse refuses a timezone argument on a `Date` clock, so
    // every clock is read as a UTC `DateTime` before it is bucketed.
    let instant = format!("toDateTime({clock}, 'UTC')");

    match grain {
        Grain::Hour => format!("toStartOfHour({instant}, 'UTC')"),
        Grain::Day => format!("toStartOfDay({instant}, 'UTC')"),
        Grain::Week => format!("toStartOfWeek({instant}, 1, 'UTC')"),
        Grain::Month => format!("toStartOfMonth({instant}, 'UTC')"),
    }
}

pub(super) fn add_window_predicates(
    window: &Window,
    time_expression: Option<&str>,
    where_parts: &mut Vec<Sql>,
) -> Result<(), MetricQueryError> {
    let Window::Requested { bounds, .. } = window else {
        return Ok(());
    };
    let Some(clock) = time_expression else {
        return Err(MetricQueryError::ClocklessWindow);
    };

    match *bounds {
        Bounds::Finite { from, to } => {
            where_parts.push(sql!(
                "{clock} >= fromUnixTimestamp64Milli({from}, 'UTC')",
                clock = Sql::raw(clock),
                from = Param::int64(from.timestamp_millis()),
            ));
            where_parts.push(sql!(
                "{clock} < fromUnixTimestamp64Milli({to}, 'UTC')",
                clock = Sql::raw(clock),
                to = Param::int64(to.timestamp_millis()),
            ));
        }
        Bounds::Unbounded => where_parts.push(Sql::raw(format!("{clock} IS NOT NULL"))),
    }

    Ok(())
}
