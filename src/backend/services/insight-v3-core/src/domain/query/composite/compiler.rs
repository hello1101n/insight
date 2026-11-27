use std::collections::{BTreeMap, HashMap};

use super::{Admitted, Alias, Composite, Field, RESERVED_PREFIX};
use crate::domain::kinds::dataset::declaration::BUCKET_COLUMN;
use crate::domain::query::metric_query::{
    Bound, CompiledQuery, FieldType, FilterBind, MetricQuery, OrderBy, Unit, bound_by, ratio_sql,
};

#[derive(Debug)]
pub(crate) struct Stacked<'a> {
    pub(crate) alias: &'a Alias,
    pub(crate) query: &'a MetricQuery,
    pub(crate) compiled: CompiledQuery,
}

#[derive(Debug, Default)]
struct Folded {
    parts: Vec<String>,
    column_types: HashMap<String, FieldType>,
    percents: Vec<String>,
    exacts: Vec<String>,
    units: BTreeMap<String, Unit>,
}

impl Folded {
    fn carry(&mut self, child: &Stacked<'_>, column: &str, as_name: &str) {
        if let Some(field_type) = child.compiled.column_type(column) {
            self.column_types.insert(as_name.to_owned(), field_type);
        }
        if child.compiled.percents().iter().any(|name| name == column) {
            self.percents.push(as_name.to_owned());
        }
        if child.compiled.exacts().iter().any(|name| name == column) {
            self.exacts.push(as_name.to_owned());
        }
        if let Some(unit) = child.compiled.unit_of(column) {
            self.units.insert(as_name.to_owned(), unit);
        }
    }
}

impl Composite {
    // INVARIANT: stacked and folded, never joined. A join fills a side with
    // no row with its type's default unless `join_use_nulls` is set, and
    // leaves two copies of each key to merge; the fold has neither problem.
    pub(crate) fn compile(
        &self,
        admitted: &Admitted,
        children: &[Stacked<'_>],
        windowed: bool,
    ) -> CompiledQuery {
        let bucketed = windowed && admitted.dated();
        let mut keys: Vec<String> = Vec::with_capacity(self.group_by.len() + 1);
        if bucketed {
            keys.push(BUCKET_COLUMN.to_owned());
        }
        keys.extend(self.group_by.iter().cloned());
        let backticked: Vec<String> = keys.iter().map(|key| format!("`{key}`")).collect();

        let (arms, binds) = self.stacked(children, &backticked);
        let folded = self.folded(children);

        let mut selected = backticked.clone();
        selected.extend(folded.parts);
        let mut sql = format!(
            "SELECT {} FROM ({})",
            selected.join(", "),
            arms.join(" UNION ALL ")
        );
        if !backticked.is_empty() {
            sql.push_str(" GROUP BY ");
            sql.push_str(&backticked.join(", "));
        }

        bound_by(
            &mut sql,
            Bound::Whole,
            self.limit,
            self.ordering(bucketed),
            &keys,
            &[],
        );

        CompiledQuery::composed(
            sql,
            binds,
            folded.column_types,
            folded.percents,
            folded.exacts,
            folded.units,
        )
    }

    fn ordering(&self, bucketed: bool) -> Option<&OrderBy> {
        self.order_by
            .as_ref()
            .filter(|order| bucketed || order.field != BUCKET_COLUMN)
    }

    fn stacked(&self, children: &[Stacked<'_>], keys: &[String]) -> (Vec<String>, Vec<FilterBind>) {
        let mut arms = Vec::with_capacity(children.len());
        let mut binds = Vec::new();

        for child in children {
            let mut columns = keys.to_vec();
            for (index, field) in self.fields.iter().enumerate() {
                let Field::Pick { alias, column, .. } = field else {
                    continue;
                };
                let value = if alias == child.alias.as_str() {
                    format!("`{column}`")
                } else {
                    "NULL".to_owned()
                };
                columns.push(format!("{value} AS `{}`", slot(index)));
            }

            arms.push(format!(
                "SELECT {} FROM ({})",
                columns.join(", "),
                child.compiled.sql()
            ));
            binds.extend_from_slice(child.compiled.binds());
        }

        (arms, binds)
    }

    fn folded(&self, children: &[Stacked<'_>]) -> Folded {
        let mut folded = Folded::default();
        if let Some(first) = children.first() {
            for key in &self.group_by {
                if let Some(field_type) = first.compiled.column_type(key) {
                    folded.column_types.insert(key.clone(), field_type);
                }
            }
        }

        for (index, field) in self.fields.iter().enumerate() {
            let expression = match field {
                Field::Pick {
                    as_name,
                    alias,
                    column,
                    ..
                } => {
                    let read = children.iter().find(|child| child.alias.as_str() == alias);
                    if let Some(child) = read {
                        folded.carry(child, column, as_name);
                    }

                    picked(index, read.is_some_and(|child| child.query.adds_up(column)))
                }
                Field::Ratio {
                    as_name,
                    numerator,
                    denominator,
                    percent,
                    ..
                } => {
                    folded
                        .column_types
                        .insert(as_name.clone(), FieldType::Float);
                    if *percent {
                        folded.percents.push(as_name.clone());
                    }

                    ratio_sql(numerator, denominator, *percent)
                }
            };
            if let Some(unit) = field.unit() {
                folded.units.insert(field.as_name().to_owned(), unit);
            }
            folded
                .parts
                .push(format!("{expression} AS `{}`", field.as_name()));
        }

        folded
    }
}

fn picked(index: usize, adds_up: bool) -> String {
    let one = format!("any(`{}`)", slot(index));

    if adds_up {
        format!("coalesce({one}, 0)")
    } else {
        one
    }
}

fn slot(index: usize) -> String {
    format!("{RESERVED_PREFIX}c{index}")
}
