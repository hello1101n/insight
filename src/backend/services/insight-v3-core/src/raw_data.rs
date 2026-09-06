use std::fmt;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

const RAW_DATA_TABLE: &str = "raw_data";
pub(crate) const MAX_TABLE_NAME_CHARS: usize = 128;

#[derive(Debug)]
pub(crate) struct RawDataRecord {
    table_name: TableName,
    raw_data: String,
}

impl RawDataRecord {
    pub(crate) fn parse(
        table_name: &str,
        raw_data: &serde_json::Value,
    ) -> Result<Self, RawDataError> {
        let table_name = TableName::parse(table_name)?;
        let raw_data = serde_json::to_string(raw_data)?;

        Ok(Self {
            table_name,
            raw_data,
        })
    }

    #[cfg(test)]
    fn table_name(&self) -> &str {
        self.table_name.as_str()
    }

    fn into_row(self) -> RawDataRow {
        RawDataRow {
            id: Uuid::now_v7(),
            table_name: self.table_name.into_string(),
            raw_data: self.raw_data,
            received_at: Utc::now(),
        }
    }
}

#[derive(Debug)]
struct TableName(String);

impl TableName {
    fn parse(value: &str) -> Result<Self, RawDataError> {
        let value = value.trim();
        if value.is_empty() {
            return Err(RawDataError::EmptyTableName);
        }
        if value.chars().count() > MAX_TABLE_NAME_CHARS {
            return Err(RawDataError::TableNameTooLong);
        }

        Ok(Self(value.to_owned()))
    }

    #[cfg(test)]
    fn as_str(&self) -> &str {
        &self.0
    }

    fn into_string(self) -> String {
        self.0
    }
}

pub(crate) struct RawDataStore {
    client: insight_clickhouse::Client,
}

impl RawDataStore {
    pub(crate) fn new(client: insight_clickhouse::Client) -> Self {
        Self { client }
    }

    pub(crate) async fn insert(&self, record: RawDataRecord) -> Result<(), StoreError> {
        let row = record.into_row();
        let mut insert = self
            .client
            .inner()
            .insert::<RawDataRow>(RAW_DATA_TABLE)
            .await?;
        insert.write(&row).await?;
        insert.end().await?;

        Ok(())
    }
}

impl fmt::Debug for RawDataStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RawDataStore")
            .field("table", &RAW_DATA_TABLE)
            .finish()
    }
}

#[derive(Debug, Error)]
pub(crate) enum RawDataError {
    #[error("table must not be blank")]
    EmptyTableName,
    #[error("table must be at most {MAX_TABLE_NAME_CHARS} characters")]
    TableNameTooLong,
    #[error("raw_data could not be serialized")]
    Serialization(#[from] serde_json::Error),
}

#[derive(Debug, Error)]
#[error("failed to insert raw data")]
pub(crate) struct StoreError(#[from] clickhouse::error::Error);

#[derive(Debug, Serialize, Deserialize, clickhouse::Row)]
struct RawDataRow {
    #[serde(with = "clickhouse::serde::uuid")]
    id: Uuid,
    table_name: String,
    raw_data: String,
    #[serde(with = "clickhouse::serde::chrono::datetime64::millis")]
    received_at: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use clickhouse::test::{Mock, handlers};
    use serde_json::json;

    use super::*;

    #[test]
    fn logical_table_name_is_trimmed() {
        let record = RawDataRecord::parse("  synthetic.events  ", &json!({"value": 1}))
            .unwrap_or_else(|error| panic!("record must parse: {error}"));

        assert_eq!(record.table_name(), "synthetic.events");
    }

    #[test]
    fn arbitrary_json_values_are_accepted() {
        for value in [
            serde_json::Value::Null,
            json!(true),
            json!(42),
            json!("text"),
            json!([1, {"nested": false}]),
            json!({"nested": [1, 2, 3]}),
        ] {
            assert!(
                RawDataRecord::parse("synthetic.events", &value).is_ok(),
                "every JSON shape must be accepted"
            );
        }
    }

    #[test]
    fn blank_and_overlong_table_names_are_rejected() {
        for table in ["", "   ", &"x".repeat(MAX_TABLE_NAME_CHARS + 1)] {
            assert!(
                RawDataRecord::parse(table, &json!(null)).is_err(),
                "must reject logical table name: {table:?}"
            );
        }
    }

    #[tokio::test]
    async fn insert_writes_the_fixed_table_row() {
        let mock = Mock::new();
        let recording = mock.add(handlers::record::<RawDataRow>());
        let client =
            insight_clickhouse::Client::new(insight_clickhouse::Config::new(mock.url(), "insight"));
        let store = RawDataStore::new(client);
        let record = RawDataRecord::parse("synthetic.events", &json!({"nested": [1, true, null]}))
            .unwrap_or_else(|error| panic!("record must parse: {error}"));

        store
            .insert(record)
            .await
            .unwrap_or_else(|error| panic!("insert must succeed: {error}"));
        let rows: Vec<RawDataRow> = recording.collect().await;

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].table_name, "synthetic.events");
        assert_eq!(rows[0].raw_data, r#"{"nested":[1,true,null]}"#);
        assert_ne!(rows[0].id, uuid::Uuid::nil());
    }
}
