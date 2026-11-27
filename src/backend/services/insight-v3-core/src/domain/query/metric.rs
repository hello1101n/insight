use serde_json::Value;

use crate::domain::query::composite::Composite;
use crate::domain::query::metric_query::MetricQuery;

pub(crate) const COMBINE_KEY: &str = "combine";

#[derive(Debug)]
pub(crate) enum Metric {
    Query(MetricQuery),
    Composite(Composite),
}

impl Metric {
    pub(crate) fn parse(body: Value) -> Result<Self, serde_json::Error> {
        if body.get(COMBINE_KEY).is_some() {
            return serde_json::from_value(body).map(Self::Composite);
        }

        serde_json::from_value(body).map(Self::Query)
    }

    pub(crate) fn column_names(&self, clocked: bool) -> Vec<String> {
        match self {
            Self::Query(query) => query.column_names(clocked),
            Self::Composite(composite) => composite.column_names(clocked),
        }
    }

    pub(crate) fn groups(&self) -> &[String] {
        match self {
            Self::Query(query) => query.groups(),
            Self::Composite(composite) => composite.groups(),
        }
    }

    pub(crate) fn imposed_limit(&self) -> Option<u32> {
        match self {
            Self::Query(query) => query.imposed_limit(),
            Self::Composite(composite) => composite.imposed_limit(),
        }
    }
}
