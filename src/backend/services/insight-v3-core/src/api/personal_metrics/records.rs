use serde::Serialize;

use crate::api::metric_drilldown::{ColumnOut, RowOut, column_out, rows_out};
use crate::domain::drilldown::{Column, Page};

#[derive(Debug, Serialize)]
pub(super) struct RecordsResponse {
    columns: Vec<ColumnOut>,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
    rows: Vec<RowOut>,
    next_cursor: Option<String>,
}

pub(super) fn records_out(page: Page, value_field: &str) -> RecordsResponse {
    let value = page
        .columns
        .iter()
        .any(|column| column.key == value_field)
        .then(|| value_field.to_owned());

    RecordsResponse {
        columns: page.columns.iter().map(titled).collect(),
        value,
        rows: rows_out(page.rows),
        next_cursor: page.next_cursor,
    }
}

fn titled(column: &Column) -> ColumnOut {
    let mut out = column_out(column, false);
    out.label = title(&column.key);

    out
}

pub(super) fn title(key: &str) -> String {
    let spaced = key.replace('_', " ").to_lowercase();
    let mut letters = spaced.chars();

    match letters.next() {
        Some(first) => first.to_uppercase().chain(letters).collect(),
        None => String::new(),
    }
}
