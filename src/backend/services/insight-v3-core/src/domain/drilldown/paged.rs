use insight_clickhouse::{Sql, sql};

use super::Column;
use super::cursor::CursorKey;
use super::order::{INNER, OrderKey};
use crate::domain::query::metric_query::{CompiledQuery, TWIN_COLUMN};

const INNERMOST: &str = "__i";

pub(super) fn wrap(
    inner: &CompiledQuery,
    order: &OrderKey,
    resume: Option<&CursorKey>,
    limit: usize,
    columns: &[Column],
) -> Sql {
    let mut sql = sql!(
        "SELECT {INNER}.*{projection} FROM ({source}) AS {INNER}",
        projection = Sql::raw(order.projection()),
        source = source(inner, columns),
    );

    if let Some(key) = resume {
        sql.push(sql!(
            " WHERE {predicate}",
            predicate = order.cursor_predicate(key)
        ));
    }

    sql.push(Sql::raw(format!(
        " ORDER BY {} LIMIT {}",
        order.order_by(),
        limit.saturating_add(1)
    )));

    sql
}

/// INVARIANT: numbered before the cursor is compared, in a layer of their
/// own. A window function is computed after `WHERE`, so a comparison in the
/// same select could not see the number.
fn source(inner: &CompiledQuery, columns: &[Column]) -> Sql {
    if !inner.numbered() {
        return inner.sql().clone();
    }

    let partition: Vec<String> = columns
        .iter()
        .map(|column| format!("{INNERMOST}.`{}`", column.key))
        .collect();

    sql!(
        "SELECT {INNERMOST}.*, row_number() OVER (PARTITION BY {partition}) AS `{TWIN_COLUMN}` FROM ({inner}) AS {INNERMOST}",
        partition = Sql::raw(partition.join(", ")),
        inner = inner.sql().clone(),
    )
}
