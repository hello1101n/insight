use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;
use thiserror::Error;

use super::{KindError, Reference};
use crate::domain::datasets::Datasets;
use crate::domain::definition::{DefinitionId, DefinitionKind, Lookup};
use crate::domain::kinds::dataset::declaration::BUCKET_COLUMN;
use crate::domain::kinds::metric::answerable::effective_clock;
use crate::domain::kinds::metric::composite;
use crate::domain::query::metric::Metric;
use crate::domain::query::metric_query::MetricQuery;

const FEWEST_STAGES: usize = 2;
const MOST_STAGES: usize = 12;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[expect(
    dead_code,
    reason = "parsed only to refuse a comparison the renderer cannot draw"
)]
struct Compare {
    #[serde(default)]
    better: Better,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Better {
    #[default]
    Higher,
    Lower,
    Neutral,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Stack {
    Percent,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[expect(
    dead_code,
    reason = "parsed only to refuse a target that is not a number"
)]
struct Target {
    value: f64,
    #[serde(default)]
    label: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Tone {
    Success,
    Danger,
    Warning,
    Info,
    Neutral,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Widget {
    Table {
        metric: String,
        #[serde(default)]
        columns: Vec<String>,
        #[serde(default)]
        detail: Option<String>,
    },
    Line {
        metric: String,
        x: String,
        y: String,
        #[serde(default)]
        series: Option<String>,
        #[serde(default)]
        #[expect(dead_code, reason = "parsed only to refuse a malformed target")]
        target: Option<Target>,
        #[serde(default)]
        detail: Option<String>,
    },
    Bar {
        metric: String,
        x: String,
        y: String,
        #[serde(default)]
        series: Option<String>,
        #[serde(default)]
        #[expect(
            dead_code,
            reason = "parsed only to refuse a `labels` that is not a flag"
        )]
        labels: bool,
        #[serde(default)]
        #[expect(
            dead_code,
            reason = "parsed only to refuse a `horizontal` that is not a flag"
        )]
        horizontal: bool,
        #[serde(default)]
        stack: Option<Stack>,
        #[serde(default)]
        #[expect(dead_code, reason = "parsed only to refuse a malformed target")]
        target: Option<Target>,
        #[serde(default)]
        #[expect(
            dead_code,
            reason = "parsed only to refuse a colour that is not a named tone"
        )]
        colors: BTreeMap<String, Tone>,
        #[serde(default)]
        detail: Option<String>,
    },
    Area {
        metric: String,
        x: String,
        y: String,
        #[serde(default)]
        series: Option<String>,
        #[serde(default)]
        #[expect(dead_code, reason = "parsed only to refuse a malformed target")]
        target: Option<Target>,
        #[serde(default)]
        detail: Option<String>,
    },
    Stat {
        metric: String,
        value: String,
        #[serde(default)]
        #[expect(dead_code, reason = "parsed only to refuse a malformed comparison")]
        compare: Option<Compare>,
        #[serde(default)]
        detail: Option<String>,
    },
    Pie {
        metric: String,
        label: String,
        value: String,
        #[serde(default)]
        detail: Option<String>,
    },
    Heatmap {
        metric: String,
        x: String,
        #[serde(default)]
        y: Option<String>,
        value: String,
        #[serde(default)]
        detail: Option<String>,
    },
    Funnel {
        metric: String,
        stages: Vec<String>,
        #[serde(default)]
        detail: Option<String>,
    },
    Treemap {
        metric: String,
        label: String,
        value: String,
        #[serde(default)]
        group: Option<String>,
        #[serde(default)]
        detail: Option<String>,
    },
    Scatter {
        metric: String,
        x: String,
        y: String,
        #[serde(default)]
        size: Option<String>,
        #[serde(default)]
        series: Option<String>,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        detail: Option<String>,
    },
}

impl Widget {
    fn metric(&self) -> &str {
        match self {
            Self::Table { metric, .. }
            | Self::Line { metric, .. }
            | Self::Bar { metric, .. }
            | Self::Area { metric, .. }
            | Self::Stat { metric, .. }
            | Self::Pie { metric, .. }
            | Self::Heatmap { metric, .. }
            | Self::Funnel { metric, .. }
            | Self::Treemap { metric, .. }
            | Self::Scatter { metric, .. } => metric,
        }
    }

    fn detail(&self) -> Option<&str> {
        match self {
            Self::Table { detail, .. }
            | Self::Line { detail, .. }
            | Self::Bar { detail, .. }
            | Self::Area { detail, .. }
            | Self::Stat { detail, .. }
            | Self::Pie { detail, .. }
            | Self::Heatmap { detail, .. }
            | Self::Funnel { detail, .. }
            | Self::Treemap { detail, .. }
            | Self::Scatter { detail, .. } => detail.as_deref(),
        }
    }

    fn narrowing_columns<'w>(&'w self, drawn: &'w Metric) -> Vec<&'w str> {
        match self {
            Self::Line { x, .. } | Self::Bar { x, .. } | Self::Area { x, .. } => vec![x.as_str()],
            Self::Pie { label, .. } => vec![label.as_str()],
            Self::Table { columns, .. } => columns
                .iter()
                .map(String::as_str)
                .filter(|column| {
                    *column == BUCKET_COLUMN || drawn.groups().contains(&(*column).to_owned())
                })
                .collect(),
            Self::Heatmap { x, y, .. } => present([Some(x), y.as_ref()]),
            Self::Treemap { label, group, .. } => present([Some(label), group.as_ref()]),
            Self::Scatter { label, series, .. } => present([label.as_ref(), series.as_ref()]),
            Self::Stat { .. } | Self::Funnel { .. } => Vec::new(),
        }
    }

    fn columns(&self) -> Vec<&str> {
        match self {
            Self::Table { columns, .. } => columns.iter().map(String::as_str).collect(),
            Self::Line { x, y, series, .. }
            | Self::Bar { x, y, series, .. }
            | Self::Area { x, y, series, .. } => present([Some(x), Some(y), series.as_ref()]),
            Self::Stat { value, .. } => vec![value.as_str()],
            Self::Pie { label, value, .. } => vec![label.as_str(), value.as_str()],
            Self::Heatmap { x, y, value, .. } => present([Some(x), y.as_ref(), Some(value)]),
            Self::Funnel { stages, .. } => stages.iter().map(String::as_str).collect(),
            Self::Treemap {
                label,
                value,
                group,
                ..
            } => present([Some(label), Some(value), group.as_ref()]),
            Self::Scatter {
                x,
                y,
                size,
                series,
                label,
                ..
            } => present([
                Some(x),
                Some(y),
                size.as_ref(),
                series.as_ref(),
                label.as_ref(),
            ]),
        }
    }

    fn check_shape(&self) -> Result<(), WidgetError> {
        if let Self::Bar {
            stack: Some(Stack::Percent),
            series: None,
            ..
        } = self
        {
            return Err(WidgetError::StackWithoutSeries);
        }
        if let Self::Heatmap { x, y: None, .. } = self
            && x != BUCKET_COLUMN
        {
            return Err(WidgetError::CalendarNotByBucket(x.clone()));
        }
        if let Self::Funnel { stages, .. } = self {
            check_stages(stages)?;
        }

        Ok(())
    }

    fn check_against(&self, metric: &Metric, clocked: bool) -> Result<(), WidgetError> {
        self.check_shape()?;
        let available = metric.column_names(clocked);

        if self.columns().is_empty() {
            return Err(WidgetError::NoColumns);
        }

        for column in self.columns() {
            if !available.iter().any(|name| name == column) {
                return Err(WidgetError::UnknownColumn {
                    column: column.to_owned(),
                    metric: self.metric().to_owned(),
                    available: available.join(", "),
                });
            }
        }

        Ok(())
    }

    fn check_detail_against(
        &self,
        drawn: &Metric,
        detail: &MetricQuery,
        clocked: bool,
    ) -> Result<(), WidgetError> {
        let available = detail.column_names(clocked);

        for column in self.narrowing_columns(drawn) {
            if !available.iter().any(|name| name == column) {
                return Err(WidgetError::DetailLacksColumn {
                    column: column.to_owned(),
                    detail: self.detail().unwrap_or_default().to_owned(),
                    available: available.join(", "),
                });
            }
        }

        Ok(())
    }
}

fn present<const N: usize>(named: [Option<&String>; N]) -> Vec<&str> {
    named.into_iter().flatten().map(String::as_str).collect()
}

fn check_stages(stages: &[String]) -> Result<(), WidgetError> {
    if !(FEWEST_STAGES..=MOST_STAGES).contains(&stages.len()) {
        return Err(WidgetError::FunnelStages(stages.len()));
    }

    for (index, stage) in stages.iter().enumerate() {
        if stages[..index].contains(stage) {
            return Err(WidgetError::RepeatedStage(stage.clone()));
        }
    }

    Ok(())
}

#[derive(Debug, Error)]
pub(crate) enum WidgetError {
    #[error("a table names the columns it draws; this one names none")]
    NoColumns,
    #[error(
        "a widget needs a metric, a type of `table`, `line`, `bar`, `area`, `stat`, `pie`, \
         `heatmap`, `funnel`, `treemap` or `scatter`, and the columns that type draws: columns \
         for a table, x and y for a line, bar, area or scatter, value for a stat, label and \
         value for a pie or a treemap, x and value for a heatmap, stages for a funnel; a \
         heatmap may add a `y` column, a treemap a `group` column, and a scatter `size`, \
         `series` and `label` columns; a bar may add a `series` column \
         to stack by and `labels: true` to print each bar's total; a line or an area may add a \
         `series` column to draw one line per value; a line, bar or area may add a `target` \
         of {{\"value\": <number>, \"label\": <text>}}; a bar may add `horizontal: true`, \
         `stack: \"percent\"`, and `colors` giving a series value one tone of `success`, \
         `danger`, `warning`, `info` or `neutral`; a stat may add `compare` with `better` of `higher`, `lower` \
         or `neutral`"
    )]
    Shape(#[from] serde_json::Error),
    #[error("a bar stacks to 100% by its `series` column; this one names no `series`")]
    StackWithoutSeries,
    #[error("a heatmap without `y` is a calendar, so its `x` is `bucket`; this one names `{0}`")]
    CalendarNotByBucket(String),
    #[error("a funnel draws 2 to 12 stages; this one names {0}")]
    FunnelStages(usize),
    #[error("`{0}` is a stage of this funnel twice; each stage is one column, named once")]
    RepeatedStage(String),
    #[error("`{column}` is not a column of metric `{metric}`; its columns are: {available}")]
    UnknownColumn {
        column: String,
        metric: String,
        available: String,
    },
    #[error("there is no metric named `{0}`")]
    NoMetric(String),
    #[error(
        "`{0}` combines other metrics and has no records of its own, so it cannot be a \
         widget's detail; name one of the metrics it combines"
    )]
    CompositeDetail(String),
    #[error(
        "`{column}` is not a column of the detail metric `{detail}`, so its rows could not be \
         narrowed to what this widget draws; the detail's columns are: {available}"
    )]
    DetailLacksColumn {
        column: String,
        detail: String,
        available: String,
    },
}

pub(crate) async fn check(
    body: &Value,
    definitions: &dyn Lookup,
    datasets: &dyn Datasets,
) -> Result<(), KindError> {
    let widget: Widget =
        serde_json::from_value(body.clone()).map_err(|error| KindError::Widget(error.into()))?;

    let metric = stored_metric(widget.metric(), definitions).await?;
    let dated = match &metric {
        Metric::Query(query) => clocked(query, datasets).await,
        Metric::Composite(combined) => composite::children(combined, definitions, datasets)
            .await?
            .dated(),
    };

    widget
        .check_against(&metric, dated)
        .map_err(KindError::Widget)?;

    let Some(named) = widget.detail() else {
        return Ok(());
    };
    let Metric::Query(detail) = stored_metric(named, definitions).await? else {
        return Err(KindError::Widget(WidgetError::CompositeDetail(
            named.to_owned(),
        )));
    };
    let dated = clocked(&detail, datasets).await;

    widget
        .check_detail_against(&metric, &detail, dated)
        .map_err(KindError::Widget)
}

async fn stored_metric(named: &str, definitions: &dyn Lookup) -> Result<Metric, KindError> {
    let name = DefinitionId::parse(named)
        .map_err(|_| KindError::Widget(WidgetError::NoMetric(named.to_owned())))?;

    let stored = definitions
        .get(DefinitionKind::Metric, &name)
        .await
        .map_err(KindError::Store)?
        .ok_or_else(|| KindError::Widget(WidgetError::NoMetric(named.to_owned())))?;

    Metric::parse(stored).map_err(|error| KindError::Widget(error.into()))
}

async fn clocked(metric: &MetricQuery, datasets: &dyn Datasets) -> bool {
    let Some(named) = metric.dataset() else {
        return metric.has_clock().unwrap_or(false);
    };
    let held = crate::domain::datasets::ready(datasets, named).await;
    let Ok(Some(ready)) = held else {
        return false;
    };

    effective_clock(metric, &ready.declaration).is_some()
}

const METRIC_KEYS: [&str; 2] = ["metric", "detail"];

pub(crate) fn drawn_metric(body: &Value) -> Option<&str> {
    body.get("metric")?.as_str()
}

pub(crate) fn drilled_metric(body: &Value) -> Option<&str> {
    body.get("detail")
        .and_then(Value::as_str)
        .or_else(|| drawn_metric(body))
}

pub(crate) fn refers_to(body: &Value) -> Vec<Reference> {
    let mut named = Vec::new();

    for key in METRIC_KEYS {
        let Some(metric) = body.get(key).and_then(Value::as_str) else {
            continue;
        };
        let reference = Reference::new(DefinitionKind::Metric, metric);
        if !named.contains(&reference) {
            named.push(reference);
        }
    }

    named
}

pub(crate) fn rename_reference(mut body: Value, from: &str, to: &str) -> Value {
    for key in METRIC_KEYS {
        if body.get(key).and_then(Value::as_str) == Some(from) {
            body[key] = Value::String(to.to_owned());
        }
    }

    body
}

#[cfg(test)]
mod tests;
