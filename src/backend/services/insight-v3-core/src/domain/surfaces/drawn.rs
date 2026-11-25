use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use super::{CustomError, Surfaces, not_found};
use crate::domain::definition::{DefinitionId, DefinitionKind};
use crate::domain::kinds;
use crate::domain::kinds::metric::answerable::EffectiveClock;
use crate::domain::query::metric_query::{CompiledQuery, Unit};

#[derive(Debug, Serialize)]
pub(crate) struct DrawnWidget {
    id: String,
    name: String,
    body: Value,
    clock: Option<EffectiveClock>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    percents: Vec<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    units: BTreeMap<String, Unit>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reading {
    Drawn,
    Drilled,
}

impl Surfaces<'_> {
    pub(crate) async fn drawn_widgets(
        &self,
        dashboard: &DefinitionId,
    ) -> Result<Vec<DrawnWidget>, CustomError> {
        let body = self.dashboard_body(dashboard).await?;
        let mut drawn = Vec::new();

        for named in kinds::dashboard::drawn(&body) {
            let Ok(id) = DefinitionId::parse(&named) else {
                continue;
            };
            let Some(stored) = self
                .definitions
                .read(DefinitionKind::Widget, &id)
                .await
                .map_err(CustomError::Store)?
            else {
                continue;
            };
            let (clock, compiled) = self.drawn_reading(&named, &stored.body).await?;
            let (percents, units) = compiled
                .map(|compiled| (compiled.percents().to_vec(), compiled.units().clone()))
                .unwrap_or_default();

            drawn.push(DrawnWidget {
                id: named,
                name: stored.name,
                body: stored.body,
                clock,
                percents,
                units,
            });
        }

        Ok(drawn)
    }

    pub(crate) async fn drawn_metric(
        &self,
        dashboard: &DefinitionId,
        widget: &DefinitionId,
        reading: Reading,
    ) -> Result<DefinitionId, CustomError> {
        let body = self.dashboard_body(dashboard).await?;
        let missing = || not_found(DefinitionKind::Widget, widget);
        if !kinds::dashboard::drawn(&body)
            .iter()
            .any(|named| named == widget.as_str())
        {
            return Err(missing());
        }

        let stored = self
            .definitions
            .get(DefinitionKind::Widget, widget)
            .await
            .map_err(CustomError::Store)?
            .ok_or_else(missing)?;
        let named = match reading {
            Reading::Drawn => kinds::widget::drawn_metric(&stored),
            Reading::Drilled => kinds::widget::drilled_metric(&stored),
        };

        named
            .and_then(|named| DefinitionId::parse(named).ok())
            .ok_or_else(|| CustomError::NotFound {
                kind: DefinitionKind::Metric,
                id: named.unwrap_or_default().to_owned(),
            })
    }

    async fn dashboard_body(&self, dashboard: &DefinitionId) -> Result<Value, CustomError> {
        self.seen(dashboard).await?;

        self.definitions
            .get(DefinitionKind::Dashboard, dashboard)
            .await
            .map_err(CustomError::Store)?
            .ok_or_else(|| not_found(DefinitionKind::Dashboard, dashboard))
    }

    async fn drawn_reading(
        &self,
        widget_id: &str,
        widget: &Value,
    ) -> Result<(Option<EffectiveClock>, Option<CompiledQuery>), CustomError> {
        let Some(metric) =
            kinds::widget::drawn_metric(widget).and_then(|named| DefinitionId::parse(named).ok())
        else {
            return Ok((None, None));
        };
        let Some(body) = self
            .definitions
            .get(DefinitionKind::Metric, &metric)
            .await
            .map_err(CustomError::Store)?
        else {
            return Ok((None, None));
        };

        let clock = self.clock_of(DefinitionKind::Metric, &body).await;
        let compiling =
            kinds::metric::compiled(&body, self.definitions, self.datasets, self.over).await;
        let compiled = match compiling {
            Ok(compiled) => Some(compiled),
            Err(error) => {
                tracing::warn!(
                    widget_id,
                    metric_id = metric.as_str(),
                    error_kind = error.kind(),
                    %error,
                    "the metric of a listed widget did not compile; the list omits its percents and units"
                );
                None
            }
        };

        Ok((clock, compiled))
    }
}
