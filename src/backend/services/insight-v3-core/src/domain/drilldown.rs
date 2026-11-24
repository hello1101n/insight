mod cursor;
mod order;
mod paged;
mod records;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::definition::DefinitionId;
use super::metric_run::{MetricRuns, Source};
use super::query::metric_query::{ColumnKind, CompiledQuery, MetricRunner};
use super::query::time_window::{Window, WindowRequest};
use super::surfaces::CustomError;

pub(crate) use cursor::CursorError;
pub(crate) use records::Records;

pub(crate) const DEFAULT_PAGE_ROWS: usize = 100;
pub(crate) const MAX_PAGE_ROWS: usize = 250;

#[derive(Debug)]
pub(crate) struct Asked {
    pub(crate) window: WindowRequest,
    pub(crate) range: Option<String>,
    pub(crate) bucket: Option<bool>,
    pub(crate) sort: Option<Sort>,
    pub(crate) limit: usize,
    pub(crate) cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Sort {
    pub(crate) key: String,
    pub(crate) descending: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct Column {
    pub(crate) key: String,
    pub(crate) kind: ColumnKind,
    pub(crate) percent: bool,
    pub(crate) exact: bool,
}

#[derive(Debug)]
pub(crate) struct Page {
    pub(crate) columns: Vec<Column>,
    pub(crate) rows: Vec<serde_json::Map<String, serde_json::Value>>,
    pub(crate) sort: Sort,
    pub(crate) next_cursor: Option<String>,
}

#[derive(Debug, Error)]
pub(crate) enum DrilldownError {
    #[error(transparent)]
    Custom(CustomError),
    #[error("`{0}` is not a column of this metric, so its rows cannot be ordered by it")]
    Sort(String),
    #[error("a page holds between 1 and {MAX_PAGE_ROWS} rows")]
    PageSize,
    #[error(transparent)]
    Cursor(#[from] CursorError),
    #[error("the table behind this metric was made again while it was being read")]
    Rebuilt,
    #[error("`{0}` is a name this read keeps for itself; give that column another `as_name`")]
    Reserved(String),
}

#[derive(Debug)]
pub(crate) struct Drilldowns<'a> {
    runs: MetricRuns<'a>,
    runner: &'a MetricRunner,
}

impl<'a> Drilldowns<'a> {
    pub(crate) fn new(runs: MetricRuns<'a>, runner: &'a MetricRunner) -> Self {
        Self { runs, runner }
    }

    pub(crate) async fn page(
        &self,
        name: &DefinitionId,
        asked: &Asked,
    ) -> Result<Page, DrilldownError> {
        page_size(asked.limit)?;

        let resume = asked.cursor.as_deref().map(cursor::decode).transpose()?;
        let window = match &resume {
            Some(envelope) => envelope.window.clone(),
            None => MetricRuns::resolve(&asked.window).map_err(DrilldownError::Custom)?,
        };
        let prepared = self
            .runs
            .prepare(name, &window)
            .await
            .map_err(DrilldownError::Custom)?;
        let columns = columns_of(&prepared.kinds, &prepared.compiled);

        let sort = match &asked.sort {
            Some(sort) => sort.clone(),
            None => default_sort(prepared.own_order.as_ref(), &columns),
        };
        let fingerprint = cursor::fingerprint(&(
            name.as_str(),
            &prepared.body,
            asked.range.as_deref(),
            asked.bucket,
            &window,
            &sort,
            &columns,
        ));

        self.ordered(Ordered {
            compiled: &prepared.compiled,
            columns,
            sort,
            source: &prepared.source,
            window: &window,
            fingerprint,
            resume,
            limit: asked.limit,
        })
        .await
    }
}

struct Ordered<'o> {
    compiled: &'o CompiledQuery,
    columns: Vec<Column>,
    sort: Sort,
    source: &'o Source,
    window: &'o Window,
    fingerprint: String,
    resume: Option<cursor::Envelope>,
    limit: usize,
}

impl Drilldowns<'_> {
    async fn ordered(&self, read: Ordered<'_>) -> Result<Page, DrilldownError> {
        let Ordered {
            compiled,
            columns,
            sort,
            source,
            window,
            fingerprint,
            resume,
            limit,
        } = read;
        if let Some(taken) = columns
            .iter()
            .find(|column| order::is_reserved(&column.key))
        {
            return Err(DrilldownError::Reserved(taken.key.clone()));
        }
        if !columns.iter().any(|column| column.key == sort.key) {
            return Err(DrilldownError::Sort(sort.key));
        }

        let snapshot = self.snapshot_of(source).await?;
        let order = order::OrderKey::build(&columns, &sort, compiled.hidden());

        let resume = resume
            .map(|envelope| resumed(envelope, &fingerprint, &snapshot, &order))
            .transpose()?;

        let (sql, binds) = paged::wrap(compiled, &order, resume.as_ref(), limit, &columns);
        let mut rows = self
            .runner
            .page(&sql, &binds)
            .await
            .map_err(|error| DrilldownError::Custom(CustomError::Run(error)))?;

        let next_cursor = if rows.len() > limit {
            rows.truncate(limit);
            match rows.last() {
                Some(last) => Some(cursor::encode(
                    &fingerprint,
                    &snapshot,
                    window,
                    order.key_of(last)?,
                )),
                None => None,
            }
        } else {
            None
        };
        let rows = rows
            .into_iter()
            .map(|row| order::presented(row, &columns, compiled.hidden()))
            .collect();

        Ok(Page {
            columns,
            rows,
            sort,
            next_cursor,
        })
    }

    async fn snapshot_of(&self, source: &Source) -> Result<String, DrilldownError> {
        match source {
            Source::Table { database, table } => Ok(self
                .runner
                .table_uuid(database.as_deref(), table)
                .await
                .map_err(|error| DrilldownError::Custom(CustomError::Run(error)))?
                .unwrap_or_default()),
            Source::Dataset { table } => Ok(table.clone()),
        }
    }
}

fn resumed(
    envelope: cursor::Envelope,
    fingerprint: &str,
    snapshot: &str,
    order: &order::OrderKey,
) -> Result<cursor::CursorKey, DrilldownError> {
    if envelope.fingerprint != fingerprint {
        return Err(CursorError::Selection.into());
    }
    if envelope.snapshot != snapshot {
        return Err(DrilldownError::Rebuilt);
    }
    order.check(&envelope.key)?;

    Ok(envelope.key)
}

fn page_size(limit: usize) -> Result<(), DrilldownError> {
    if limit == 0 || limit > MAX_PAGE_ROWS {
        return Err(DrilldownError::PageSize);
    }

    Ok(())
}

fn columns_of(kinds: &[(String, ColumnKind)], compiled: &CompiledQuery) -> Vec<Column> {
    kinds
        .iter()
        .map(|(key, kind)| Column {
            key: key.clone(),
            kind: *kind,
            percent: compiled.percents().contains(key),
            exact: compiled.exacts().contains(key),
        })
        .collect()
}

fn default_sort(own: Option<&(String, bool)>, columns: &[Column]) -> Sort {
    if let Some((key, descending)) = own
        && columns.iter().any(|column| &column.key == key)
    {
        return Sort {
            key: key.clone(),
            descending: *descending,
        };
    }

    Sort {
        key: columns
            .first()
            .map(|column| column.key.clone())
            .unwrap_or_default(),
        descending: false,
    }
}

#[cfg(test)]
mod tests;
