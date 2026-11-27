use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;

use super::clock::{TimeField, add_window_predicates, bucket_expression, clock_expression};
use super::field::{Field, FieldType, OrderBy, Unit, is_identifier};
use super::filter::FilterBind;
use super::over::Over;
use super::people::{People, PersonHandle};
use super::{
    ColumnKind, CompiledQuery, FACT_ALIAS, MetricQuery, MetricQueryError, RECORD_COLUMN,
    RECORD_TIME_COLUMN, TWIN_COLUMN, UndatedQuery, carried_column,
};
use crate::domain::access::PersonId;
use crate::domain::kinds::dataset::declaration::{BUCKET_COLUMN, Declaration};
use crate::domain::kinds::dataset::read::Form;
use crate::domain::kinds::metric::answerable::effective_clock;
use crate::domain::personal::{MarkError, PersonalMark};
use crate::domain::query::metric_query::TableEngine;
use crate::domain::query::time_window::Window;

const DEFAULT_LIMIT: u32 = 1000;
const MAX_LIMIT: u32 = 10000;
const PERSON_COLUMN: &str = "__person_id";
const ROWS_COLUMN: &str = "__rows";

impl super::MetricQuery {
    pub(crate) fn imposed_limit(&self) -> Option<u32> {
        imposed_limit(self.limit)
    }
}

pub(crate) fn imposed_limit(limit: Option<u32>) -> Option<u32> {
    match limit {
        None => Some(DEFAULT_LIMIT),
        Some(limit) if limit > MAX_LIMIT => Some(MAX_LIMIT),
        Some(_) => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Bound {
    Whole,
    Paged,
    Subquery,
}

#[derive(Debug)]
struct Selection<'a> {
    parts: Vec<String>,
    as_names: HashSet<&'a str>,
    column_types: HashMap<String, FieldType>,
    joins: String,
    handles: Vec<PersonHandle>,
    binds: Vec<FilterBind>,
}

impl MetricQuery {
    fn time_expression(
        &self,
        window: &Window,
        over: Option<Over<'_>>,
        qualifier: Option<&str>,
        as_names: &HashSet<&str>,
    ) -> Result<Option<String>, MetricQueryError> {
        if let Some(over) = over {
            return self.dataset_clock(window, over, qualifier, as_names);
        }

        let clock = self.time.as_ref().map(TimeField::source).transpose()?;
        if matches!(window, Window::Requested { .. }) && clock.is_none() {
            return Err(MetricQueryError::ClocklessWindow);
        }

        if let Some(maximum) = self.maximum()?
            && !maximum.allows(window)
        {
            return Err(MetricQueryError::RangeExceedsMaximum(
                self.max_range.clone().unwrap_or_default(),
            ));
        }

        if let Some(clock) = clock {
            let filters = self
                .filters
                .iter()
                .chain(self.fields.iter().flat_map(|field| &field.when));
            for filter in filters {
                if filter.source()? == clock {
                    return Err(MetricQueryError::ClockFilter(clock.name().to_owned()));
                }
            }
        }
        if window.grain().is_some() && as_names.contains("bucket") {
            return Err(MetricQueryError::BucketAlias);
        }

        clock
            .map(|source| clock_expression(source, qualifier))
            .transpose()
    }

    fn dataset_clock(
        &self,
        window: &Window,
        over: Over<'_>,
        qualifier: Option<&str>,
        as_names: &HashSet<&str>,
    ) -> Result<Option<String>, MetricQueryError> {
        let clock = effective_clock(self, over.declaration).map(|(field, _)| field);
        if matches!(window, Window::Requested { .. }) && clock.is_none() {
            return Err(MetricQueryError::ClocklessWindow);
        }

        if let Some(maximum) = self.maximum()?
            && !maximum.allows(window)
        {
            return Err(MetricQueryError::RangeExceedsMaximum(
                self.max_range.clone().unwrap_or_default(),
            ));
        }
        if window.grain().is_some() && as_names.contains(BUCKET_COLUMN) {
            return Err(MetricQueryError::BucketAlias);
        }

        clock
            .map(|field| over.read_as(Some(field), "time", qualifier, Form::Raw))
            .transpose()
    }

    pub(crate) fn groups_its_rows(&self) -> bool {
        !self.group_by.is_empty() || self.fields.iter().any(|field| field.agg.is_some())
    }

    fn names_marked(&self, marked: fn(&Field) -> bool) -> Vec<String> {
        self.fields
            .iter()
            .filter(|field| marked(field))
            .map(|field| field.as_name.clone())
            .collect()
    }

    fn units(&self) -> BTreeMap<String, Unit> {
        self.fields
            .iter()
            .filter_map(|field| Some((field.as_name.clone(), field.unit?)))
            .collect()
    }

    fn check_grouping(&self, as_names: &HashSet<&str>) -> Result<(), MetricQueryError> {
        for group in &self.group_by {
            if !is_identifier(group) {
                return Err(MetricQueryError::Identifier(group.clone()));
            }
            if group != BUCKET_COLUMN && !as_names.contains(group.as_str()) {
                return Err(MetricQueryError::GroupBy(group.clone()));
            }
        }

        if !self.fields.iter().any(|field| field.agg.is_some()) {
            return Ok(());
        }

        for field in &self.fields {
            let derived = field.agg.is_some() || field.divide.is_some();
            if !derived && !self.group_by.contains(&field.as_name) {
                return Err(MetricQueryError::Ungrouped(field.as_name.clone()));
            }
        }

        Ok(())
    }

    fn selection(
        &self,
        over: Option<Over<'_>>,
        qualifier: Option<&str>,
    ) -> Result<Selection<'_>, MetricQueryError> {
        let mut selection = Selection {
            parts: Vec::with_capacity(self.fields.len()),
            as_names: HashSet::with_capacity(self.fields.len()),
            column_types: HashMap::with_capacity(self.fields.len()),
            joins: String::new(),
            handles: Vec::new(),
            binds: Vec::new(),
        };

        for (index, field) in self.fields.iter().enumerate() {
            if !is_identifier(&field.as_name) {
                return Err(MetricQueryError::Identifier(field.as_name.clone()));
            }
            let result_type = match over {
                Some(over) => field.result_type_over(over),
                None => field.result_type(),
            };
            if field.unit.is_some() && result_type == FieldType::String {
                return Err(MetricQueryError::UnitOnText(field.as_name.clone()));
            }
            selection
                .column_types
                .insert(field.as_name.clone(), result_type);

            if let Some(ratio) = field.ratio(&selection.as_names)? {
                selection.as_names.insert(field.as_name.as_str());
                selection
                    .parts
                    .push(format!("{ratio} AS `{}`", field.as_name));
                continue;
            }
            selection.as_names.insert(field.as_name.as_str());

            let expression = match handle_of(field, over) {
                Some(handle) => {
                    if !selection.handles.contains(&handle) {
                        selection.handles.push(handle);
                    }
                    let alias =
                        join_person(field, index, handle, over, qualifier, &mut selection.joins)?;
                    let resolved = shown_person(field, &alias, over, qualifier)?;
                    let condition = field.condition(over, qualifier, &mut selection.binds)?;

                    field.aggregated_if(resolved, condition)
                }
                None => field.expression(over, qualifier, &mut selection.binds)?,
            };
            selection
                .parts
                .push(format!("{expression} AS `{}`", field.as_name));
        }

        Ok(selection)
    }

    #[cfg(test)]
    pub(crate) fn compile(&self, people: &People) -> Result<CompiledQuery, MetricQueryError> {
        self.compile_window(people, &Window::legacy(), TableEngine::Other, None)
    }

    pub(crate) fn compile_over(
        &self,
        people: &People,
        window: &Window,
        over: Over<'_>,
    ) -> Result<CompiledQuery, MetricQueryError> {
        self.compile_window(people, window, TableEngine::Other, Some(over))
    }

    pub(crate) fn compile_window(
        &self,
        people: &People,
        window: &Window,
        engine: TableEngine,
        over: Option<Over<'_>>,
    ) -> Result<CompiledQuery, MetricQueryError> {
        self.assemble(people, window, engine, over, Bound::Whole, &[])
    }

    pub(crate) fn compile_subquery(
        &self,
        people: &People,
        window: &Window,
        engine: TableEngine,
        over: Option<Over<'_>>,
    ) -> Result<CompiledQuery, MetricQueryError> {
        self.assemble(people, window, engine, over, Bound::Subquery, &[])
    }

    pub(crate) fn compile_paged(
        &self,
        people: &People,
        window: &Window,
        engine: TableEngine,
        over: Option<Over<'_>>,
        carried: &[&str],
    ) -> Result<CompiledQuery, MetricQueryError> {
        self.assemble(people, window, engine, over, Bound::Paged, carried)
    }

    fn assemble(
        &self,
        people: &People,
        window: &Window,
        engine: TableEngine,
        over: Option<Over<'_>>,
        bound: Bound,
        carried: &[&str],
    ) -> Result<CompiledQuery, MetricQueryError> {
        if self.fields.is_empty() {
            return Err(MetricQueryError::NoFields);
        }
        let (_, table) = self.split();
        if over.is_none() {
            self.validate_shape(table)?;
        }

        let joins_a_person = self
            .fields
            .iter()
            .any(|field| handle_of(field, over).is_some());
        let qualifier = joins_a_person.then_some(FACT_ALIAS);
        let Selection {
            mut parts,
            as_names,
            column_types,
            joins,
            handles,
            mut binds,
        } = self.selection(over, qualifier)?;

        let time_expression = self.time_expression(window, over, qualifier, &as_names)?;
        let bucket = window.grain().zip(time_expression.as_deref());
        let mut as_names = as_names;
        if let Some((grain, clock)) = bucket {
            parts.insert(
                0,
                format!("{} AS `{BUCKET_COLUMN}`", bucket_expression(grain, clock)),
            );
            as_names.insert(BUCKET_COLUMN);
        }

        self.check_grouping(&as_names)?;

        let (hidden, numbered) =
            self.distinguished(bound, over.is_some(), qualifier, carried, &mut parts);

        let mut where_parts = Vec::with_capacity(self.filters.len() + 2);
        binds.reserve(self.filters.len() + 2);
        add_window_predicates(
            window,
            time_expression.as_deref(),
            &mut where_parts,
            &mut binds,
        )?;
        self.add_filters(over, qualifier, &mut where_parts, &mut binds)?;

        let from = self.table_source(over, qualifier, engine);
        let prelude = if handles.is_empty() {
            String::new()
        } else {
            people.prelude(&handles)?
        };
        let mut sql = format!("{prelude}SELECT {} FROM {from}{joins}", parts.join(", "));
        if !where_parts.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&where_parts.join(" AND "));
        }
        let mut groups: Vec<String> = self
            .group_by
            .iter()
            .filter(|group| *group != BUCKET_COLUMN)
            .cloned()
            .collect();
        if bucket.is_some() && self.groups_its_rows() {
            groups.insert(0, BUCKET_COLUMN.to_owned());
        }
        let ordering = match &self.order_by {
            Some(order) if as_names.contains(order.field.as_str()) => Some(order),
            Some(order) if order.field == BUCKET_COLUMN => None,
            Some(order) => return Err(MetricQueryError::OrderBy(order.field.clone())),
            None => None,
        };

        let backticked: Vec<String> = groups.iter().map(|group| format!("`{group}`")).collect();
        if !groups.is_empty() {
            sql.push_str(" GROUP BY ");
            sql.push_str(&backticked.join(", "));
        }

        let mut columns: Vec<String> = self
            .fields
            .iter()
            .map(|field| field.as_name.clone())
            .collect();
        if bucket.is_some() {
            columns.insert(0, BUCKET_COLUMN.to_owned());
        }
        let carried: &[String] = if numbered { &[] } else { &hidden };
        let ordered: Vec<String> = columns.iter().chain(carried.iter()).cloned().collect();
        bound_by(&mut sql, bound, self.limit, ordering, &groups, &ordered);

        Ok(CompiledQuery {
            sql,
            binds,
            column_types,
            percents: self.names_marked(|field| field.percent),
            exacts: self.names_marked(|field| field.exact),
            units: self.units(),
            hidden,
            numbered,
        })
    }

    fn distinguished(
        &self,
        bound: Bound,
        over_a_dataset: bool,
        qualifier: Option<&str>,
        carried: &[&str],
        parts: &mut Vec<String>,
    ) -> (Vec<String>, bool) {
        if bound != Bound::Paged || self.groups_its_rows() {
            return (Vec::new(), false);
        }
        if !over_a_dataset {
            let mut hidden = Vec::with_capacity(carried.len() + 1);
            for column in carried {
                let name = carried_column(column);
                let read = match qualifier {
                    Some(alias) => format!("`{alias}`.`{column}`"),
                    None => format!("`{column}`"),
                };
                parts.push(format!("toString({read}) AS `{name}`"));
                hidden.push(name);
            }
            hidden.push(TWIN_COLUMN.to_owned());

            return (hidden, true);
        }

        identified(over_a_dataset, qualifier, parts)
    }

    fn add_filters(
        &self,
        over: Option<Over<'_>>,
        qualifier: Option<&str>,
        where_parts: &mut Vec<String>,
        binds: &mut Vec<FilterBind>,
    ) -> Result<(), MetricQueryError> {
        for filter in &self.filters {
            let (condition, bound) = filter.predicate(over, qualifier)?;
            where_parts.push(condition);
            binds.push(bound);
        }

        Ok(())
    }

    fn table_source(
        &self,
        over: Option<Over<'_>>,
        qualifier: Option<&str>,
        engine: TableEngine,
    ) -> String {
        if let Some(over) = over {
            return over.relation(qualifier);
        }

        let (database, table) = self.split();
        let mut from = match database {
            Some(database) => format!("`{database}`.`{table}`"),
            None => format!("`{table}`"),
        };

        if let Some(alias) = qualifier {
            let _ = write!(from, " AS `{alias}`");
        }
        if engine.requires_final() {
            from.push_str(" FINAL");
        }

        from
    }

    pub(crate) fn undated_query(
        &self,
        engine: TableEngine,
        over: Option<Over<'_>>,
    ) -> Result<Option<UndatedQuery>, MetricQueryError> {
        let (_, table) = self.split();
        if over.is_none() {
            self.validate_shape(table)?;
        }

        let Some(clock) = self.undated_clock(over)? else {
            return Ok(None);
        };

        let mut where_parts = Vec::with_capacity(self.filters.len());
        let mut binds = Vec::with_capacity(self.filters.len());
        self.add_filters(over, None, &mut where_parts, &mut binds)?;

        let mut sql = format!(
            "SELECT countIf(isNull({clock})) AS undated FROM {}",
            self.table_source(over, None, engine)
        );
        if !where_parts.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&where_parts.join(" AND "));
        }

        Ok(Some(UndatedQuery { sql, binds }))
    }

    fn undated_clock(&self, over: Option<Over<'_>>) -> Result<Option<String>, MetricQueryError> {
        let Some(over) = over else {
            return self
                .time
                .as_ref()
                .map(|time| clock_expression(time.source()?, None))
                .transpose();
        };

        effective_clock(self, over.declaration)
            .map(|(field, _)| over.read_as(Some(field), "time", None, Form::Raw))
            .transpose()
    }

    pub(crate) fn check_table(&self) -> Result<(), MetricQueryError> {
        self.validate_shape(self.split().1)
    }

    fn validate_shape(&self, table: &str) -> Result<(), MetricQueryError> {
        if table.is_empty() {
            return Err(MetricQueryError::NoTable);
        }
        if !is_identifier(table) {
            return Err(MetricQueryError::Identifier(self.table.clone()));
        }
        if let Some(database) = self.database()
            && !is_identifier(database)
        {
            return Err(MetricQueryError::Identifier(database.to_owned()));
        }
        if self.fields.is_empty() {
            return Err(MetricQueryError::NoFields);
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
struct Personal {
    person: usize,
    handle: PersonHandle,
    value: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Spread {
    PerPerson,
    Together,
}

impl MetricQuery {
    pub(crate) fn personal_values(
        &self,
        mark: &PersonalMark,
        persons: &[PersonId],
        window: &Window,
        people: &People,
        engine: TableEngine,
        over: Option<Over<'_>>,
    ) -> Result<CompiledQuery, MetricQueryError> {
        self.valued(
            mark,
            persons,
            window,
            people,
            engine,
            over,
            Spread::PerPerson,
        )
    }

    pub(crate) fn team_value(
        &self,
        mark: &PersonalMark,
        persons: &[PersonId],
        window: &Window,
        people: &People,
        engine: TableEngine,
        over: Option<Over<'_>>,
    ) -> Result<CompiledQuery, MetricQueryError> {
        self.valued(
            mark,
            persons,
            window,
            people,
            engine,
            over,
            Spread::Together,
        )
    }

    pub(crate) fn personal_records(
        &self,
        mark: &PersonalMark,
        person: PersonId,
        window: &Window,
        people: &People,
        engine: TableEngine,
        over: Option<Over<'_>>,
    ) -> Result<CompiledQuery, MetricQueryError> {
        let personal = self.personal(mark, over)?;
        let qualifier = Some(FACT_ALIAS);
        let window = window.clone().unbucketed();
        let time = self.time_expression(&window, over, qualifier, &HashSet::new())?;

        let mut parts = Vec::with_capacity(self.fields.len() + 2);
        let mut column_types = HashMap::with_capacity(self.fields.len() + 1);
        let mut joins = String::new();
        let mut handles = vec![personal.handle];
        let mut binds = Vec::new();
        join_person(
            &self.fields[personal.person],
            personal.person,
            personal.handle,
            over,
            qualifier,
            &mut joins,
        )?;
        if let Some(clock) = time.as_deref() {
            parts.push(format!("{clock} AS `{RECORD_TIME_COLUMN}`"));
            column_types.insert(RECORD_TIME_COLUMN.to_owned(), FieldType::String);
        }

        for (index, field) in self.record_fields() {
            if !is_identifier(&field.as_name) {
                return Err(MetricQueryError::Identifier(field.as_name.clone()));
            }
            if time.is_some() && field.as_name == RECORD_TIME_COLUMN {
                return Err(MetricQueryError::RecordTime);
            }

            let (expression, read_type) = match handle_of(field, over) {
                Some(handle) => {
                    let alias = if index == personal.person {
                        person_alias(index)
                    } else {
                        if !handles.contains(&handle) {
                            handles.push(handle);
                        }
                        join_person(field, index, handle, over, qualifier, &mut joins)?
                    };

                    (
                        shown_person(field, &alias, over, qualifier)?,
                        FieldType::String,
                    )
                }
                None => (
                    field.read(over, qualifier, &mut binds)?,
                    field.read_type(over),
                ),
            };
            parts.push(format!("{expression} AS `{}`", field.as_name));
            column_types.insert(field.as_name.clone(), read_type);
        }

        let (hidden, numbered) = identified(over.is_some(), qualifier, &mut parts);

        let mut where_parts = Vec::with_capacity(self.filters.len() + 4);
        add_window_predicates(&window, time.as_deref(), &mut where_parts, &mut binds)?;
        self.add_filters(over, qualifier, &mut where_parts, &mut binds)?;
        where_parts.push(format!(
            "`{}`.`person_id` = ?",
            person_alias(personal.person)
        ));
        binds.push(FilterBind::Str(person.to_string()));

        let valued = &self.fields[personal.value];
        if valued.divide.is_none()
            && let Some(condition) = valued.condition(over, qualifier, &mut binds)?
        {
            where_parts.push(condition);
        }

        let sql = format!(
            "{}SELECT {} FROM {}{joins} WHERE {}",
            people.prelude(&handles)?,
            parts.join(", "),
            self.table_source(over, qualifier, engine),
            where_parts.join(" AND ")
        );

        Ok(CompiledQuery {
            sql,
            binds,
            column_types,
            percents: Vec::new(),
            exacts: self
                .record_fields()
                .filter(|(_, field)| field.exact)
                .map(|(_, field)| field.as_name.clone())
                .collect(),
            units: self.record_units(),
            hidden,
            numbered,
        })
    }

    pub(crate) fn personal_record_kinds(
        &self,
        declaration: Option<&Declaration>,
    ) -> Vec<(String, ColumnKind)> {
        let clocked = match declaration {
            Some(declaration) => effective_clock(self, declaration).is_some(),
            None => self.has_clock().unwrap_or(false),
        };

        let mut kinds = Vec::with_capacity(self.fields.len() + 1);
        if clocked {
            kinds.push((RECORD_TIME_COLUMN.to_owned(), ColumnKind::Date));
        }
        for (_, field) in self.record_fields() {
            let output = super::Output { field, declaration };
            let kind = if output.carries_a_person() {
                ColumnKind::Text
            } else {
                super::read_kind(field, declaration)
            };
            kinds.push((field.as_name.clone(), kind));
        }

        kinds
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "the two public reads share every argument but the spread"
    )]
    fn valued(
        &self,
        mark: &PersonalMark,
        persons: &[PersonId],
        window: &Window,
        people: &People,
        engine: TableEngine,
        over: Option<Over<'_>>,
        spread: Spread,
    ) -> Result<CompiledQuery, MetricQueryError> {
        if persons.is_empty() {
            return Err(MetricQueryError::NoPersons);
        }
        let personal = self.personal(mark, over)?;
        let qualifier = Some(FACT_ALIAS);
        let window = window.clone().unbucketed();
        let alias = person_alias(personal.person);

        let mut joins = String::new();
        join_person(
            &self.fields[personal.person],
            personal.person,
            personal.handle,
            over,
            qualifier,
            &mut joins,
        )?;

        let mut inner = Vec::with_capacity(self.fields.len() + 1);
        inner.push(match spread {
            Spread::PerPerson => format!("`{alias}`.`person_id` AS `{PERSON_COLUMN}`"),
            Spread::Together => format!("count() AS `{ROWS_COLUMN}`"),
        });
        let mut binds = Vec::new();
        let mut selected = HashSet::new();
        for index in self.needed_for(personal.value)? {
            let field = &self.fields[index];
            if !is_identifier(&field.as_name) {
                return Err(MetricQueryError::Identifier(field.as_name.clone()));
            }

            let expression = match field.ratio(&selected)? {
                Some(ratio) => ratio,
                None => field.expression(over, qualifier, &mut binds)?,
            };
            selected.insert(field.as_name.as_str());
            inner.push(format!("{expression} AS `{}`", field.as_name));
        }

        let time = self.time_expression(&window, over, qualifier, &HashSet::new())?;
        let mut where_parts = Vec::with_capacity(self.filters.len() + 3);
        add_window_predicates(&window, time.as_deref(), &mut where_parts, &mut binds)?;
        self.add_filters(over, qualifier, &mut where_parts, &mut binds)?;
        where_parts.push(format!(
            "`{alias}`.`person_id` IN ({})",
            vec!["?"; persons.len()].join(", ")
        ));
        binds.extend(
            persons
                .iter()
                .map(|person| FilterBind::Str(person.to_string())),
        );

        let mut counted = format!(
            "SELECT {} FROM {}{joins} WHERE {}",
            inner.join(", "),
            self.table_source(over, qualifier, engine),
            where_parts.join(" AND ")
        );
        let valued = &self.fields[personal.value];
        let outer = match spread {
            Spread::PerPerson => {
                let _ = write!(counted, " GROUP BY `{alias}`.`person_id`");

                format!(
                    "`{PERSON_COLUMN}` AS `person_id`, `{}` AS `value`",
                    valued.as_name
                )
            }
            Spread::Together => format!(
                "if(`{ROWS_COLUMN}` = 0, NULL, `{}`) AS `value`",
                valued.as_name
            ),
        };
        let sql = format!(
            "{}SELECT {outer} FROM ({counted})",
            people.prelude(&[personal.handle])?
        );

        let mut column_types = HashMap::from([(
            "value".to_owned(),
            match over {
                Some(over) => valued.result_type_over(over),
                None => valued.result_type(),
            },
        )]);
        if spread == Spread::PerPerson {
            column_types.insert("person_id".to_owned(), FieldType::String);
        }

        Ok(CompiledQuery {
            sql,
            binds,
            column_types,
            percents: named_value(valued.percent),
            exacts: named_value(valued.exact),
            units: valued
                .unit
                .map(|unit| ("value".to_owned(), unit))
                .into_iter()
                .collect(),
            hidden: Vec::new(),
            numbered: false,
        })
    }

    fn personal(
        &self,
        mark: &PersonalMark,
        over: Option<Over<'_>>,
    ) -> Result<Personal, MetricQueryError> {
        if over.is_none() {
            self.validate_shape(self.split().1)?;
        }
        mark.check(self, over.map(|over| over.declaration))?;

        let position = |as_name: &str| {
            self.fields
                .iter()
                .position(|field| field.as_name == as_name)
        };
        let person = position(&mark.person_field)
            .ok_or_else(|| MarkError::NoPersonField(mark.person_field.clone()))?;
        let handle = handle_of(&self.fields[person], over)
            .ok_or_else(|| MarkError::NoPersonHandle(mark.person_field.clone()))?;
        let value = position(&mark.value_field)
            .ok_or_else(|| MarkError::NoValueField(mark.value_field.clone()))?;

        Ok(Personal {
            person,
            handle,
            value,
        })
    }

    fn needed_for(&self, value: usize) -> Result<Vec<usize>, MetricQueryError> {
        let mut needed = vec![false; value + 1];
        if let Some(last) = needed.last_mut() {
            *last = true;
        }

        for index in (0..=value).rev() {
            if !needed.get(index).copied().unwrap_or(false) {
                continue;
            }
            let field = &self.fields[index];
            let Some((numerator, denominator)) = field.divided()? else {
                continue;
            };

            for name in [numerator, denominator] {
                let earlier = self.fields[..index]
                    .iter()
                    .rposition(|field| field.as_name == name)
                    .ok_or_else(|| field.divides_no_earlier(name))?;
                if let Some(marked) = needed.get_mut(earlier) {
                    *marked = true;
                }
            }
        }

        Ok(needed
            .iter()
            .enumerate()
            .filter_map(|(index, needed)| needed.then_some(index))
            .collect())
    }

    fn record_fields(&self) -> impl Iterator<Item = (usize, &Field)> {
        self.fields
            .iter()
            .enumerate()
            .filter(|(_, field)| field.divide.is_none() && !field.reads_nothing())
    }

    fn record_units(&self) -> BTreeMap<String, Unit> {
        self.record_fields()
            .filter_map(|(_, field)| Some((field.as_name.clone(), field.unit?)))
            .collect()
    }
}

fn named_value(marked: bool) -> Vec<String> {
    if marked {
        vec!["value".to_owned()]
    } else {
        Vec::new()
    }
}

fn handle_of(field: &Field, over: Option<Over<'_>>) -> Option<PersonHandle> {
    match over {
        Some(over) => over.person_of(field.declared.as_deref()),
        None => field.person,
    }
}

fn person_alias(index: usize) -> String {
    format!("__p{index}")
}

fn person_read(
    field: &Field,
    over: Option<Over<'_>>,
    qualifier: Option<&str>,
    form: Form,
) -> Result<String, MetricQueryError> {
    match over {
        Some(over) => over.read_as(field.declared.as_deref(), "a person field", qualifier, form),
        None => field.source()?.sql(field.r#type, qualifier),
    }
}

fn join_person(
    field: &Field,
    index: usize,
    handle: PersonHandle,
    over: Option<Over<'_>>,
    qualifier: Option<&str>,
    joins: &mut String,
) -> Result<String, MetricQueryError> {
    let read = person_read(field, over, qualifier, Form::Raw)?;
    let alias = person_alias(index);
    let _ = write!(
        joins,
        " LEFT JOIN {} AS `{alias}` ON `{alias}`.`handle` = {}",
        handle.cte(),
        handle.key(&read)
    );

    Ok(alias)
}

fn shown_person(
    field: &Field,
    alias: &str,
    over: Option<Over<'_>>,
    qualifier: Option<&str>,
) -> Result<String, MetricQueryError> {
    let shown = person_read(field, over, qualifier, Form::Presented)?;

    Ok(format!(
        "coalesce(nullIf(`{alias}`.`display_name`, ''), {shown})"
    ))
}

fn identified(
    over_a_dataset: bool,
    qualifier: Option<&str>,
    parts: &mut Vec<String>,
) -> (Vec<String>, bool) {
    if !over_a_dataset {
        return (vec![TWIN_COLUMN.to_owned()], true);
    }

    let id = match qualifier {
        Some(alias) => format!("`{alias}`.`id`"),
        None => "`id`".to_owned(),
    };
    parts.push(format!("{id} AS `{RECORD_COLUMN}`"));

    (vec![RECORD_COLUMN.to_owned()], false)
}

pub(crate) fn bound_by(
    sql: &mut String,
    bound: Bound,
    limit: Option<u32>,
    ordering: Option<&OrderBy>,
    groups: &[String],
    columns: &[String],
) {
    let limit = match bound {
        Bound::Whole => Some(limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT)),
        Bound::Paged => limit.map(|limit| limit.min(MAX_LIMIT)),
        Bound::Subquery => None,
    };
    let Some(limit) = limit else {
        return;
    };

    let mut terms: Vec<String> = match ordering {
        Some(order) => vec![format!("`{}` {}", order.field, order.direction.sql())],
        None => groups.iter().map(|group| format!("`{group}`")).collect(),
    };
    if bound == Bound::Paged {
        let named: Vec<&str> = match ordering {
            Some(order) => vec![order.field.as_str()],
            None => groups.iter().map(String::as_str).collect(),
        };
        terms.extend(
            columns
                .iter()
                .filter(|column| !named.contains(&column.as_str()))
                .map(|column| format!("`{column}`")),
        );
    }
    if !terms.is_empty() {
        sql.push_str(" ORDER BY ");
        sql.push_str(&terms.join(", "));
    }
    let _ = write!(sql, " LIMIT {limit}");
}
