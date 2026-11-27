use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::{Error, dto::ScheduleStatus, validation::Violation};

pub(crate) const PARAMETER: &str = "sync_resources";
pub(crate) const DBT_POD_PATCH: &str = "dbt_pod_patch";
pub(crate) const IDENTITY_POD_PATCH: &str = "identity_pod_patch";
pub(crate) const DBT_QUERY_MEMORY_ENV: &str = "DBT_QUERY_MEMORY_BYTES";
pub(super) const POD_PATCH_PARAMETERS: [&str; 2] = [DBT_POD_PATCH, IDENTITY_POD_PATCH];
pub(super) const DEPLOYMENT: &str = "insight.cyberfabric.com/deployment-resources";

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct Resources {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub airbyte_cpu_millis: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub airbyte_memory_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dbt_cpu_millis: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dbt_memory_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_cpu_millis: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_memory_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dbt_query_memory_bytes: Option<u64>,
}

impl Resources {
    pub(crate) fn validate(self) -> Result<Self, Violation> {
        for (field, value, min, max) in [
            (
                "airbyte_cpu_millis",
                self.airbyte_cpu_millis.map(u64::from),
                1,
                u64::from(u32::MAX),
            ),
            (
                "dbt_cpu_millis",
                self.dbt_cpu_millis.map(u64::from),
                1,
                u64::from(u32::MAX),
            ),
            (
                "identity_cpu_millis",
                self.identity_cpu_millis.map(u64::from),
                1,
                u64::from(u32::MAX),
            ),
            (
                "airbyte_memory_bytes",
                self.airbyte_memory_bytes,
                1,
                9_007_199_254_740_991,
            ),
            (
                "dbt_memory_bytes",
                self.dbt_memory_bytes,
                1,
                9_007_199_254_740_991,
            ),
            (
                "identity_memory_bytes",
                self.identity_memory_bytes,
                1,
                9_007_199_254_740_991,
            ),
            (
                "dbt_query_memory_bytes",
                self.dbt_query_memory_bytes,
                2,
                9_007_199_254_740_991,
            ),
        ] {
            if value.is_some_and(|n| !(min..=max).contains(&n)) {
                return Err(Violation::new(
                    field,
                    format!("expected an integer from {min} to {max}"),
                ));
            }
        }
        Ok(self)
    }

    pub(super) fn stored(raw: Option<&Value>) -> Result<Self, Error> {
        Ok(raw
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(Error::StoredResources)?
            .unwrap_or_default())
    }

    pub(crate) fn parse(raw: &str) -> Result<Self, Error> {
        Ok(serde_json::from_str::<Self>(raw)
            .map_err(Error::StoredResources)?
            .validate()?)
    }

    pub(super) fn resolve(&self, defaults: &Self) -> Self {
        Self {
            airbyte_cpu_millis: self.airbyte_cpu_millis.or(defaults.airbyte_cpu_millis),
            airbyte_memory_bytes: self.airbyte_memory_bytes.or(defaults.airbyte_memory_bytes),
            dbt_cpu_millis: self.dbt_cpu_millis.or(defaults.dbt_cpu_millis),
            dbt_memory_bytes: self.dbt_memory_bytes.or(defaults.dbt_memory_bytes),
            identity_cpu_millis: self.identity_cpu_millis.or(defaults.identity_cpu_millis),
            identity_memory_bytes: self
                .identity_memory_bytes
                .or(defaults.identity_memory_bytes),
            dbt_query_memory_bytes: self
                .dbt_query_memory_bytes
                .or(defaults.dbt_query_memory_bytes),
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self == &Self::default()
    }

    pub(super) fn pod_patches(&self) -> [String; 2] {
        [
            pod_patch(
                self.dbt_cpu_millis,
                self.dbt_memory_bytes,
                self.dbt_query_memory_bytes,
            ),
            pod_patch(self.identity_cpu_millis, self.identity_memory_bytes, None),
        ]
    }
}

fn pod_patch(
    cpu_millis: Option<u32>,
    memory_bytes: Option<u64>,
    query_bytes: Option<u64>,
) -> String {
    if cpu_millis.is_none() && memory_bytes.is_none() && query_bytes.is_none() {
        return "{}".to_owned();
    }

    let mut sizes = Map::new();
    if let Some(cpu) = cpu_millis {
        sizes.insert("cpu".to_owned(), json!(format!("{cpu}m")));
    }
    if let Some(memory) = memory_bytes {
        sizes.insert("memory".to_owned(), json!(memory.to_string()));
    }

    let mut main = Map::new();
    if let Some(cap) = query_bytes {
        main.insert(
            "env".to_owned(),
            json!([{"name": DBT_QUERY_MEMORY_ENV, "value": cap.to_string()}]),
        );
    }
    main.insert("name".to_owned(), json!("main"));
    if !sizes.is_empty() {
        main.insert(
            "resources".to_owned(),
            json!({"limits": sizes, "requests": sizes}),
        );
    }

    json!({"containers": [main]}).to_string()
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct ResourcePatch {
    airbyte_cpu_millis: Edit<u32>,
    airbyte_memory_bytes: Edit<u64>,
    dbt_cpu_millis: Edit<u32>,
    dbt_memory_bytes: Edit<u64>,
    identity_cpu_millis: Edit<u32>,
    identity_memory_bytes: Edit<u64>,
    dbt_query_memory_bytes: Edit<u64>,
}

impl ResourcePatch {
    pub(crate) fn validate(&self) -> Result<(), Violation> {
        self.merge(&Resources::default()).validate().map(|_| ())
    }

    pub(super) fn sets_pod_resources(&self) -> bool {
        let sizes = self.merge(&Resources::default());
        [
            sizes.airbyte_cpu_millis,
            sizes.dbt_cpu_millis,
            sizes.identity_cpu_millis,
        ]
        .iter()
        .any(Option::is_some)
            || [
                sizes.airbyte_memory_bytes,
                sizes.dbt_memory_bytes,
                sizes.identity_memory_bytes,
            ]
            .iter()
            .any(Option::is_some)
    }

    pub(super) fn only_clears(&self) -> bool {
        self.merge(&Resources::default()).is_empty()
    }

    pub(super) fn merge(&self, stored: &Resources) -> Resources {
        Resources {
            airbyte_cpu_millis: self.airbyte_cpu_millis.apply(stored.airbyte_cpu_millis),
            airbyte_memory_bytes: self.airbyte_memory_bytes.apply(stored.airbyte_memory_bytes),
            dbt_cpu_millis: self.dbt_cpu_millis.apply(stored.dbt_cpu_millis),
            dbt_memory_bytes: self.dbt_memory_bytes.apply(stored.dbt_memory_bytes),
            identity_cpu_millis: self.identity_cpu_millis.apply(stored.identity_cpu_millis),
            identity_memory_bytes: self
                .identity_memory_bytes
                .apply(stored.identity_memory_bytes),
            dbt_query_memory_bytes: self
                .dbt_query_memory_bytes
                .apply(stored.dbt_query_memory_bytes),
        }
    }
}

#[derive(Debug, Default, Clone, Copy)]
enum Edit<T> {
    #[default]
    Keep,
    Clear,
    Set(T),
}

impl<T: Copy> Edit<T> {
    fn apply(self, stored: Option<T>) -> Option<T> {
        match self {
            Self::Keep => stored,
            Self::Clear => None,
            Self::Set(value) => Some(value),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Edit<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Option::deserialize(deserializer)?.map_or(Self::Clear, Self::Set))
    }
}

#[derive(Debug, Default, Serialize, utoipa::ToSchema)]
pub(crate) struct ResourceState {
    pub requested: Resources,
    pub live: Option<Resources>,
    pub inherited: Option<Resources>,
    pub status: Option<ScheduleStatus>,
    pub read_error: Option<String>,
}

impl toolkit::api::api_dto::RequestApiDto for Resources {}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn resource_patch_clears_null_and_keeps_absent_fields() -> anyhow::Result<()> {
        let stored = Resources {
            dbt_cpu_millis: Some(500),
            dbt_memory_bytes: Some(1 << 30),
            ..Resources::default()
        };
        let patch: ResourcePatch = serde_json::from_value(json!({"dbt_cpu_millis": null}))?;
        let merged = patch.merge(&stored);
        assert_eq!(merged.dbt_cpu_millis, None);
        assert_eq!(merged.dbt_memory_bytes, stored.dbt_memory_bytes);
        Ok(())
    }
}
