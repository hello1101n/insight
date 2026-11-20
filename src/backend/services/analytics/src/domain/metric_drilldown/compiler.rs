use std::fmt::Write;

use insight_clickhouse::{Param, Sql, sql};
use toolkit_canonical_errors::CanonicalError;

use crate::domain::metric_definitions::ComputationSpec;
use crate::domain::metric_definitions::definition::{MetricInputRole, RatioDenominatorAggregation};
use crate::domain::metric_definitions::evidence_presentation::RECORD_REF_KEY;
use crate::domain::metric_results::compiler::{
    ACCOUNT_ASSIGNMENT_RELATION, PERSON_MAP_RELATION, account_id_expr, account_source_uuid_expr,
    sql_string_literal, tenant_predicate,
};

use super::cursor::CursorKey;
use super::dto::{
    EvidenceInput, EvidenceQueryRow, MetricDrilldownColumn, MetricDrilldownEntity,
    MetricDrilldownFilter, ValidatedMetricDrilldown,
};
use super::error::config_error;
use super::presentation::presentation_columns;
use super::row_shape::{RowShape, record_parts};
use super::sort::{
    ColumnSql, MetricDrilldownSort, MetricDrilldownSortDirection, PARTS_KEY, PERSON_KEY,
    column_sql, dimension_text, empty_flag,
};

const NAMED_RECORD_PARTS: usize = 3;

const RATIO_TIEBREAKERS: &[&str] = &[
    "role",
    "metric_date",
    "observed_at",
    "source_key",
    "measure_key",
    "record_id",
    "record_kind",
    "subject_key",
    "entity_id",
];

pub fn compile_query(req: &ValidatedMetricDrilldown) -> Result<Sql, CanonicalError> {
    let shape = RowShape::of(&req.plan);
    match shape {
        RowShape::Record => compile_value_query(req, shape, None),
        RowShape::FoldedRecord => compile_value_query(req, shape, record_parts(&req.plan)),
        RowShape::DailyRatio | RowShape::RecordRatio | RowShape::RecordsPerSubject => {
            compile_ratio_query(req, shape)
        }
    }
}

fn compile_value_query(
    req: &ValidatedMetricDrilldown,
    shape: RowShape,
    parts: Option<&str>,
) -> Result<Sql, CanonicalError> {
    let (database, table) = req.plan.relation.table_ref();
    let columns = presentation_columns(
        &req.plan,
        &req.selection.filters,
        &req.selection.display_dimensions,
        &req.selection.entity,
    );
    let order = OrderKey::build(&columns, &req.selection.sort, shape)?;

    let person = person_projection(&req.selection.entity, &columns);
    let scope = evidence_scope(req);
    let (rows, scope) = if let Some(parts) = parts {
        (folded_record_source(database, table, scope, parts), None)
    } else {
        (
            Sql::raw(format!("{database}.{table} AS evidence")),
            Some(scope),
        )
    };

    let search = search_predicate(
        req.selection.search.as_deref(),
        &columns,
        shape,
        &person,
        &req.search_person_ids,
    );
    let cursor = order.cursor_predicate(
        req.cursor.as_ref(),
        "role, toString(evidence.metric_date), ifNull(toString(evidence.observed_at), ''), evidence.source_key, evidence.measure_key, evidence.record_id, evidence.record_kind, ifNull(evidence.subject_key, ''), evidence.entity_id",
    );
    let order_by = order.order_by(&[
        "role",
        "metric_date",
        "ifNull(toString(observed_at), '')",
        "source_key",
        "measure_key",
        "record_id",
        "record_kind",
        "ifNull(subject_key, '')",
        "entity_id",
    ]);
    Ok(sql!(
        "WITH {role_expr} AS role, {sort_source} \
         SELECT role, evidence.entity_id AS entity_id, toString(evidence.metric_date) AS metric_date, ifNull(toString(evidence.observed_at), '') AS observed_at, \
                evidence.source_key, evidence.measure_key, evidence.record_id, evidence.record_kind, \
                evidence.contribution, CAST(NULL AS Nullable(Float64)) AS numerator, \
                CAST(NULL AS Nullable(Float64)) AS denominator, \
                ifNull(evidence.subject_key, '') AS subject_key, \
                toJSONString(evidence.dimensions) AS dimensions_json, evidence.details, \
                {person} AS person_id, {projection} \
         FROM {rows}{person_join}{where_sql} \
         ORDER BY {order_by} \
         LIMIT {limit}",
        role_expr = role_expression(&req.plan.inputs),
        sort_source = Sql::raw(order.source()),
        person = Sql::raw(person.expression),
        projection = Sql::raw(order.projection()),
        rows = rows,
        person_join = person.join,
        where_sql = where_clause([scope, search, cursor]),
        order_by = Sql::raw(order_by),
        limit = Sql::raw((req.limit + 1).to_string()),
    ))
}

fn evidence_scope(req: &ValidatedMetricDrilldown) -> Sql {
    sql!(
        "{tenant} AND evidence.source_key = {source_key} AND evidence.entity_type = {entity_type} AND {entity} \
         AND evidence.metric_date >= {from} AND evidence.metric_date <= {to} \
         AND evidence.measure_key IN {measure_keys}{filter_sql}",
        tenant = tenant_predicate(req.tenant_id, req.enforce_tenant_scope),
        source_key = Param::string(req.plan.source_key.clone()),
        entity_type = Param::string(req.selection.entity.entity_type()),
        entity = entity_predicate(&req.selection.entity),
        from = Param::date(req.from),
        to = Param::date(req.to),
        measure_keys = Param::strings(
            req.plan
                .inputs
                .iter()
                .map(|input| input.measure_key.clone())
        ),
        filter_sql = filter_predicate(&req.selection.filters),
    )
}

fn folded_record_source(database: &str, table: &str, scope: Sql, parts: &str) -> Sql {
    sql!(
        "(SELECT evidence.entity_id AS entity_id, \
                 evidence.account_source_type AS account_source_type, \
                 evidence.account_source_id AS account_source_id, \
                 evidence.account_id AS account_id, \
                 evidence.source_key AS source_key, \
                 evidence.measure_key AS measure_key, \
                 {record_key} AS record_id, \
                 max(evidence.metric_date) AS metric_date, \
                 max(evidence.observed_at) AS observed_at, \
                 any(evidence.record_kind) AS record_kind, \
                 sum(evidence.contribution) AS contribution, \
                 any(evidence.subject_key) AS subject_key, \
                 groupArrayIntersect(evidence.dimensions) AS dimensions, \
                 mapUpdate(any(evidence.details), map({parts_key}, {parts})) AS details \
          FROM {relation} AS evidence \
          WHERE {scope} \
          GROUP BY evidence.entity_id, evidence.account_source_type, \
                   evidence.account_source_id, evidence.account_id, \
                   evidence.source_key, evidence.measure_key, record_id) AS evidence",
        record_key = Sql::raw(record_key_expr()),
        parts_key = Sql::raw(sql_string_literal(PARTS_KEY)),
        parts = Sql::raw(parts_expr(parts)),
        relation = Sql::raw(format!("{database}.{table}")),
        scope = scope,
    )
}

fn parts_expr(dimension: &str) -> String {
    let part = dimension_text(&sql_string_literal(dimension));
    let totals = format!("sumMap([{part}], [ifNull(evidence.contribution, 0)])");
    let nonzero = format!(
        "arrayFilter(part -> part.2 != 0, arrayZip(tupleElement({totals}, 1), tupleElement({totals}, 2)))"
    );
    let largest_first = format!("arrayReverseSort(part -> part.2, {nonzero})");
    let named = |parts: &str| {
        format!("arrayMap(part -> concat(part.1, ' ', toString(round(part.2, 2))), {parts})")
    };
    let rest = format!(
        "arraySlice({largest_first}, {first_unnamed})",
        first_unnamed = NAMED_RECORD_PARTS + 1
    );
    format!(
        "arrayStringConcat(if(length({largest_first}) > {foldable}, \
             arrayConcat({top}, \
                         [concat(toString(length({rest})), ' other types ', \
                                 toString(round(arraySum(part -> part.2, {rest}), 2)))]), \
             {all}), ' · ')",
        foldable = NAMED_RECORD_PARTS + 1,
        top = named(&format!(
            "arraySlice({largest_first}, 1, {NAMED_RECORD_PARTS})"
        )),
        all = named(&largest_first),
    )
}

fn record_key_expr() -> String {
    format!(
        "concat(evidence.record_kind, ':', evidence.details['source_id'], ':', \
                arrayFirst(dimension -> dimension.1 = 'repository', evidence.dimensions).2, ':', \
                evidence.details[{reference}])",
        reference = sql_string_literal(RECORD_REF_KEY),
    )
}

struct PersonProjection {
    expression: &'static str,
    join: Sql,
}

impl PersonProjection {
    fn unresolved() -> Self {
        Self {
            expression: "''",
            join: Sql::default(),
        }
    }

    fn resolves(&self) -> bool {
        !self.join.is_empty()
    }
}

fn person_projection(
    entity: &MetricDrilldownEntity,
    columns: &[MetricDrilldownColumn],
) -> PersonProjection {
    let MetricDrilldownEntity::Persons { ids } = entity else {
        return PersonProjection::unresolved();
    };
    if ids.is_empty() || !columns.iter().any(|column| column.key == PERSON_KEY) {
        return PersonProjection::unresolved();
    }

    PersonProjection {
        expression: resolved_person_expr(),
        join: sql!(
            " LEFT JOIN (SELECT source_type, source_id, account_id, person_id \
                  FROM {ACCOUNT_ASSIGNMENT_RELATION} WHERE person_id IN {roster}) AS account_map \
                  ON account_map.source_type = evidence.account_source_type \
                 AND account_map.source_id = {account_source_uuid} \
                 AND account_map.account_id = {account_id} \
              LEFT JOIN (SELECT email, person_id FROM {PERSON_MAP_RELATION} \
                  WHERE person_id IN {roster}) AS person_map \
                  ON person_map.email = evidence.entity_id",
            roster = Param::strings(ids.iter().cloned()),
            account_source_uuid = Sql::raw(account_source_uuid_expr("evidence")),
            account_id = Sql::raw(account_id_expr("evidence")),
        ),
    }
}

fn ratio_halves(
    req: &ValidatedMetricDrilldown,
) -> Result<(&EvidenceInput, &EvidenceInput, RatioDenominatorAggregation), CanonicalError> {
    let numerator = req
        .plan
        .inputs
        .iter()
        .find(|input| input.role == MetricInputRole::Numerator)
        .ok_or_else(config_error)?;
    let denominator = req
        .plan
        .inputs
        .iter()
        .find(|input| input.role == MetricInputRole::Denominator)
        .ok_or_else(config_error)?;
    let ComputationSpec::Ratio {
        denominator_aggregation,
        ..
    } = &req.plan.definition.spec
    else {
        return Err(config_error());
    };
    Ok((numerator, denominator, *denominator_aggregation))
}

fn compile_ratio_query(
    req: &ValidatedMetricDrilldown,
    shape: RowShape,
) -> Result<Sql, CanonicalError> {
    let (database, table) = req.plan.relation.table_ref();
    let (numerator, denominator, aggregation) = ratio_halves(req)?;
    let rows = RatioRowSql::of(shape, aggregation, denominator)?;
    let columns = presentation_columns(
        &req.plan,
        &req.selection.filters,
        &req.selection.display_dimensions,
        &req.selection.entity,
    );
    let order = OrderKey::build(&columns, &req.selection.sort, shape)?;
    let search = search_predicate(
        req.selection.search.as_deref(),
        &columns,
        shape,
        &PersonProjection::unresolved(),
        &[],
    );
    let cursor = order.cursor_predicate(req.cursor.as_ref(), &RATIO_TIEBREAKERS.join(", "));
    Ok(sql!(
        "WITH {sort_source} \
         SELECT *, {projection} FROM (\
            SELECT 'value' AS role, '' AS entity_id, '' AS person_id, {outer_row}, \
                   CAST(NULL AS Nullable(Float64)) AS contribution, \
                   sumIf(collapsed.contribution, collapsed.measure_key = {numerator_key}) AS numerator, \
                   {denominator} AS denominator, \
                   '' AS subject_key, any(collapsed.dimensions_json) AS dimensions_json, \
                   {outer_details} \
            FROM (\
                SELECT evidence.metric_date AS metric_date, \
                       any(evidence.source_key) AS source_key, \
                       evidence.measure_key AS measure_key, \
                       evidence.subject_key AS subject_key, {resolved_person} AS person_key, \
                       toJSONString(evidence.dimensions) AS dimensions_json, \
                       {collapsed} AS contribution{record_columns} \
                FROM {relation} AS evidence \
                LEFT JOIN {ACCOUNT_ASSIGNMENT_RELATION} AS account_map \
                    ON account_map.source_type = evidence.account_source_type \
                   AND account_map.source_id = {account_source_uuid} \
                   AND account_map.account_id = {account_id} \
                LEFT JOIN {PERSON_MAP_RELATION} AS person_map \
                    ON person_map.email = evidence.entity_id \
                WHERE {scope} \
                GROUP BY evidence.metric_date, evidence.measure_key, \
                         evidence.subject_key, toJSONString(evidence.dimensions), \
                         {resolved_person}{record_group}\
            ) AS collapsed \
            GROUP BY {outer_group}\
         ) AS evidence{outer_sql} \
         ORDER BY {order_by} \
         LIMIT {limit}",
        sort_source = Sql::raw(order.source()),
        projection = Sql::raw(order.projection()),
        outer_row = Sql::raw(rows.outer_row),
        numerator_key = Param::string(numerator.measure_key.clone()),
        denominator = rows.denominator,
        outer_details = Sql::raw(rows.outer_details),
        resolved_person = Sql::raw(resolved_person_expr()),
        collapsed = collapsed_evidence_value(numerator, denominator),
        record_columns = Sql::raw(rows.inner_columns),
        relation = Sql::raw(format!("{database}.{table}")),
        account_source_uuid = Sql::raw(account_source_uuid_expr("evidence")),
        account_id = Sql::raw(account_id_expr("evidence")),
        scope = evidence_scope(req),
        record_group = Sql::raw(rows.inner_group),
        outer_group = Sql::raw(rows.outer_group),
        outer_sql = where_clause([search, cursor]),
        order_by = Sql::raw(order.order_by(RATIO_TIEBREAKERS)),
        limit = Sql::raw((req.limit + 1).to_string()),
    ))
}

struct RatioRowSql {
    outer_row: &'static str,
    denominator: Sql,
    outer_details: &'static str,
    outer_group: &'static str,
    inner_columns: String,
    inner_group: &'static str,
}

impl RatioRowSql {
    fn of(
        shape: RowShape,
        aggregation: RatioDenominatorAggregation,
        denominator: &EvidenceInput,
    ) -> Result<Self, CanonicalError> {
        let denominator_key = Param::string(denominator.measure_key.clone());
        let summed = || {
            sql!(
                "sumIf(collapsed.contribution, collapsed.measure_key = {denominator_key})",
                denominator_key = denominator_key.clone(),
            )
        };
        match shape {
            RowShape::RecordRatio | RowShape::RecordsPerSubject => {
                let (denominator, subject_records) = match aggregation {
                    RatioDenominatorAggregation::Sum => (summed(), ""),
                    RatioDenominatorAggregation::DistinctCount => (
                        sql!(
                            "toFloat64(anyIf(collapsed.subject_records, collapsed.measure_key = {denominator_key} AND collapsed.subject_key IS NOT NULL))",
                            denominator_key = denominator_key.clone(),
                        ),
                        ", count() OVER (PARTITION BY evidence.measure_key, person_key, evidence.subject_key) AS subject_records",
                    ),
                };
                Ok(Self {
                    outer_row: "toString(max(collapsed.metric_date)) AS metric_date, '' AS observed_at, \
                                any(collapsed.source_key) AS source_key, '' AS measure_key, \
                                collapsed.record_key AS record_id, any(collapsed.record_kind) AS record_kind",
                    denominator,
                    outer_details: "any(collapsed.dimensions) AS dimensions, any(collapsed.details) AS details",
                    outer_group: "collapsed.record_key HAVING numerator != 0 OR denominator != 0",
                    inner_columns: format!(
                        ", {record_key} AS record_key, any(evidence.record_kind) AS record_kind, \
                         any(evidence.dimensions) AS dimensions, any(evidence.details) AS details{subject_records}",
                        record_key = record_key_expr(),
                    ),
                    inner_group: ", record_key",
                })
            }
            RowShape::DailyRatio => Ok(Self {
                outer_row: "toString(collapsed.metric_date) AS metric_date, '' AS observed_at, \
                            any(collapsed.source_key) AS source_key, '' AS measure_key, \
                            toString(collapsed.metric_date) AS record_id, 'daily_ratio' AS record_kind",
                denominator: match aggregation {
                    RatioDenominatorAggregation::Sum => summed(),
                    RatioDenominatorAggregation::DistinctCount => sql!(
                        "toFloat64(uniqExactIf((collapsed.person_key, collapsed.subject_key), collapsed.measure_key = {denominator_key} AND collapsed.subject_key IS NOT NULL))",
                        denominator_key = denominator_key.clone(),
                    ),
                },
                outer_details: "CAST(map() AS Map(String, String)) AS details",
                outer_group: "collapsed.metric_date",
                inner_columns: String::new(),
                inner_group: "",
            }),
            RowShape::Record | RowShape::FoldedRecord => Err(config_error()),
        }
    }
}

fn resolved_person_expr() -> &'static str {
    "multiIf(coalesce(account_map.account_id, '') != '', \
      toString(assumeNotNull(account_map.person_id)), \
      coalesce(person_map.email, '') != '', \
      toString(assumeNotNull(person_map.person_id)), \
      evidence.entity_id)"
}

fn collapsed_evidence_value(numerator: &EvidenceInput, denominator: &EvidenceInput) -> Sql {
    let arms = [numerator, denominator]
        .into_iter()
        .filter(|input| input.alias_collapse.needs_pre_collapse())
        .map(|input| {
            sql!(
                "evidence.measure_key = {measure_key}, {aggregate}(ifNull(evidence.contribution, 0)), ",
                measure_key = Param::string(input.measure_key.clone()),
                aggregate = Sql::raw(input.alias_collapse.aggregate_fn()),
            )
        })
        .collect::<Vec<_>>();
    if arms.is_empty() {
        return Sql::raw("sum(ifNull(evidence.contribution, 0))");
    }
    sql!(
        "multiIf({arms}sum(ifNull(evidence.contribution, 0)))",
        arms = Sql::join(arms, "")
    )
}

fn account_binding_key(alias: &str) -> String {
    format!(
        "({alias}.account_source_type, {source_uuid}, {account_id})",
        source_uuid = account_source_uuid_expr(alias),
        account_id = account_id_expr(alias),
    )
}

fn entity_predicate(entity: &MetricDrilldownEntity) -> Sql {
    let account_key = Sql::raw(account_binding_key("evidence"));
    match entity {
        MetricDrilldownEntity::Person { id } => sql!(
            "({account_key} IN (SELECT source_type, source_id, account_id \
             FROM {ACCOUNT_ASSIGNMENT_RELATION} WHERE person_id = {person_id}) \
             OR ({account_key} NOT IN (SELECT source_type, source_id, account_id \
             FROM {ACCOUNT_ASSIGNMENT_RELATION}) \
             AND evidence.entity_id IN (SELECT email FROM {PERSON_MAP_RELATION} WHERE person_id = {person_id})))",
            account_key = account_key,
            person_id = Param::string(id.clone()),
        ),
        MetricDrilldownEntity::Persons { ids } if !ids.is_empty() => sql!(
            "({account_key} IN (SELECT source_type, source_id, account_id \
             FROM {ACCOUNT_ASSIGNMENT_RELATION} WHERE person_id IN {person_ids}) \
             OR ({account_key} NOT IN (SELECT source_type, source_id, account_id \
             FROM {ACCOUNT_ASSIGNMENT_RELATION}) \
             AND evidence.entity_id IN (SELECT email FROM {PERSON_MAP_RELATION} WHERE person_id IN {person_ids})))",
            account_key = account_key,
            person_ids = Param::strings(ids.iter().cloned()),
        ),
        MetricDrilldownEntity::Tenant {} => Sql::raw("evidence.entity_id = evidence.tenant_id"),
        MetricDrilldownEntity::Persons { .. } | MetricDrilldownEntity::Unknown => Sql::raw("1 = 0"),
    }
}

fn filter_predicate(filters: &[MetricDrilldownFilter]) -> Sql {
    let terms = filters.iter().map(|filter| {
        sql!(
            " AND indexOf(evidence.dimensions.1, {filter_dimension}) > 0 AND evidence.dimensions.2[indexOf(evidence.dimensions.1, {filter_dimension})] IN {filter_values}",
            filter_dimension = Param::string(filter.dimension.clone()),
            filter_values = Param::strings(filter.values.iter().cloned()),
        )
    });
    Sql::join(terms, "")
}

const SORT_SOURCE: &str = "sort_source";

struct OrderKey {
    source: String,
    flag: String,
    key: String,
    column: ColumnSql,
    direction: MetricDrilldownSortDirection,
}

impl OrderKey {
    fn build(
        columns: &[MetricDrilldownColumn],
        sort: &MetricDrilldownSort,
        shape: RowShape,
    ) -> Result<Self, CanonicalError> {
        let column = columns
            .iter()
            .find(|column| column.key == sort.key)
            .and_then(|column| column_sql(&column.key, column.r#type, shape))
            .ok_or_else(config_error)?;
        Ok(Self {
            flag: empty_flag(SORT_SOURCE, sort.direction),
            key: column.order_key(SORT_SOURCE),
            source: column.as_text().to_owned(),
            column,
            direction: sort.direction,
        })
    }

    fn source(&self) -> String {
        format!("{source} AS {SORT_SOURCE}", source = self.source)
    }

    fn projection(&self) -> String {
        format!(
            "{flag} AS sort_flag, {key} AS sort_key, toString(sort_key) AS sort_value",
            flag = self.flag,
            key = self.key,
        )
    }

    fn order_by(&self, tiebreakers: &[&str]) -> String {
        let direction = self.direction.as_sql();
        let mut sql = format!("sort_flag {direction}, sort_key {direction}");
        for tiebreaker in tiebreakers {
            let _ = write!(sql, ", {tiebreaker} {direction}");
        }
        sql
    }

    fn cursor_predicate(&self, cursor: Option<&CursorKey>, key_tuple: &str) -> Option<Sql> {
        let cursor = cursor?;
        Some(sql!(
            "tuple({flag}, {key}, {key_tuple}) {operator} \
             tuple(toUInt8({cursor_flag}), {cursor_sort_value}, {cursor_role}, {cursor_metric_date}, \
             {cursor_observed_at}, {cursor_source_key}, {cursor_measure_key}, {cursor_record_id}, \
             {cursor_record_kind}, {cursor_subject_key}, {cursor_entity_id})",
            flag = Sql::raw(self.flag.clone()),
            key = Sql::raw(self.key.clone()),
            key_tuple = Sql::raw(key_tuple),
            operator = Sql::raw(self.direction.cursor_operator()),
            cursor_flag = Param::bool(cursor.sort_flag),
            cursor_sort_value = self.column.cursor_binding(&cursor.sort_value),
            cursor_role = Param::string(cursor.role.clone()),
            cursor_metric_date = Param::string(cursor.metric_date.clone()),
            cursor_observed_at = Param::string(cursor.observed_at.clone()),
            cursor_source_key = Param::string(cursor.source_key.clone()),
            cursor_measure_key = Param::string(cursor.measure_key.clone()),
            cursor_record_id = Param::string(cursor.record_id.clone()),
            cursor_record_kind = Param::string(cursor.record_kind.clone()),
            cursor_subject_key = Param::string(cursor.subject_key.clone()),
            cursor_entity_id = Param::string(cursor.entity_id.clone()),
        ))
    }
}

fn search_predicate(
    search: Option<&str>,
    columns: &[MetricDrilldownColumn],
    shape: RowShape,
    person: &PersonProjection,
    person_ids: &[String],
) -> Option<Sql> {
    let needle = search?;
    let mut matches = columns
        .iter()
        .filter_map(|column| column_sql(&column.key, column.r#type, shape))
        .map(|column| {
            sql!(
                "positionCaseInsensitiveUTF8({column}, {needle}) > 0",
                column = Sql::raw(column.as_text()),
                needle = Param::string(needle),
            )
        })
        .collect::<Vec<_>>();
    if person.resolves() && !person_ids.is_empty() {
        matches.push(sql!(
            "{expression} IN {search_person_ids}",
            expression = Sql::raw(person.expression),
            search_person_ids = Param::strings(person_ids.iter().cloned()),
        ));
    }
    if matches.is_empty() {
        return None;
    }
    Some(sql!("({matches})", matches = Sql::join(matches, " OR ")))
}

fn where_clause<const N: usize>(predicates: [Option<Sql>; N]) -> Sql {
    let present = predicates.into_iter().flatten().collect::<Vec<_>>();
    if present.is_empty() {
        return Sql::default();
    }
    sql!(
        " WHERE {predicates}",
        predicates = Sql::join(present, " AND ")
    )
}

fn role_expression(inputs: &[EvidenceInput]) -> Sql {
    let branches = inputs.iter().map(|input| {
        sql!(
            "evidence.measure_key = {measure_key}, {role}",
            measure_key = Param::string(input.measure_key.clone()),
            role = Param::string(input.role.as_db()),
        )
    });
    sql!(
        "multiIf({branches}, 'value')",
        branches = Sql::join(branches, ", ")
    )
}

pub fn decode_evidence_rows(bytes: &[u8]) -> Result<Vec<EvidenceQueryRow>, serde_json::Error> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(serde_json::from_slice)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::metric_definitions::definition::AliasCollapse;
    use crate::domain::metric_definitions::{
        EvidenceGranularity, EvidencePresentation, RatioDenominatorAggregation,
    };
    use crate::domain::metric_drilldown::test_support::{
        TEST_PERSON, TEST_TENANT, commit_input, commit_presentation, input, plan, ratio_over,
        validated,
    };
    use chrono::NaiveDate;
    use insight_clickhouse::sql::Rendered;
    use uuid::Uuid;

    fn compiled(request: &ValidatedMetricDrilldown) -> Rendered {
        compile_query(request)
            .unwrap_or_else(|error| panic!("query must compile: {error}"))
            .render()
    }

    fn named(name: &str, param: Param) -> (String, Param) {
        (name.to_owned(), param)
    }

    fn day(raw: &str) -> Param {
        Param::date(
            NaiveDate::parse_from_str(raw, "%Y-%m-%d")
                .unwrap_or_else(|error| panic!("fixture date must parse: {error}")),
        )
    }

    fn scope_params(measure_keys: &[&str]) -> Vec<(String, Param)> {
        vec![
            named("tenant", Param::string(TEST_TENANT.to_string())),
            named("source_key", Param::string("git")),
            named("entity_type", Param::string("person")),
            named("person_id", Param::string(TEST_PERSON.to_string())),
            named("from", day("2026-07-01")),
            named("to", day("2026-07-31")),
            named("measure_keys", Param::strings(measure_keys.iter().copied())),
            named("filter_dimension", Param::string("repository")),
            named("filter_values", Param::strings(["org/repo"])),
        ]
    }

    #[test]
    fn value_query_binds_filters_and_cursor() {
        let value = input(MetricInputRole::Value, "commit_count");
        let plan = plan(
            ComputationSpec::Sum {
                value: value.clone(),
            },
            vec![EvidenceInput {
                role: MetricInputRole::Value,
                alias_collapse: AliasCollapse::Sum,
                measure_key: value.measure_key,
                presentation: commit_presentation(),
            }],
        );
        let mut request = validated(plan);
        request.cursor = Some(CursorKey {
            sort_flag: false,
            sort_value: "2026-07-01".to_owned(),
            entity_id: "person@example.com".to_owned(),
            role: "value".to_owned(),
            metric_date: "2026-07-01".to_owned(),
            observed_at: String::new(),
            source_key: "git".to_owned(),
            measure_key: "commit_count".to_owned(),
            record_id: "abc".to_owned(),
            record_kind: "commit".to_owned(),
            subject_key: String::new(),
        });
        let rendered = compiled(&request);
        assert!(rendered.sql.contains("insight.git_metric_evidence"));
        assert!(
            rendered
                .sql
                .contains("indexOf(evidence.dimensions.1, {filter_dimension:String})")
        );
        assert!(rendered.sql.contains("LIMIT 2"));
        let mut expected = vec![
            named("measure_key", Param::string("commit_count")),
            named("role", Param::string("value")),
        ];
        expected.extend(scope_params(&["commit_count"]));
        expected.extend([
            named("cursor_flag", Param::bool(false)),
            named("cursor_sort_value", Param::string("2026-07-01")),
            named("cursor_role", Param::string("value")),
            named("cursor_metric_date", Param::string("2026-07-01")),
            named("cursor_observed_at", Param::string("")),
            named("cursor_source_key", Param::string("git")),
            named("cursor_measure_key", Param::string("commit_count")),
            named("cursor_record_id", Param::string("abc")),
            named("cursor_record_kind", Param::string("commit")),
            named("cursor_subject_key", Param::string("")),
            named("cursor_entity_id", Param::string("person@example.com")),
        ]);
        assert_eq!(rendered.params, expected);
    }

    #[test]
    fn tenant_query_matches_the_entity_to_its_storage_partition() {
        let value = input(MetricInputRole::Value, "commit_count");
        let plan = plan(
            ComputationSpec::Sum {
                value: value.clone(),
            },
            vec![EvidenceInput {
                role: MetricInputRole::Value,
                alias_collapse: AliasCollapse::Sum,
                measure_key: value.measure_key,
                presentation: commit_presentation(),
            }],
        );
        let mut request = validated(plan);
        request.selection.entity = super::super::dto::MetricDrilldownEntity::Tenant {};

        let rendered = compiled(&request);

        assert!(
            rendered
                .sql
                .contains("evidence.entity_id = evidence.tenant_id")
        );
        assert!(
            !rendered
                .params
                .iter()
                .any(|(_, param)| *param == Param::string("default"))
        );
    }

    #[test]
    fn a_roster_query_binds_its_people_as_one_array() {
        let value = input(MetricInputRole::Value, "commit_count");
        let plan = plan(
            ComputationSpec::Sum {
                value: value.clone(),
            },
            vec![EvidenceInput {
                role: MetricInputRole::Value,
                alias_collapse: AliasCollapse::Sum,
                measure_key: value.measure_key,
                presentation: commit_presentation(),
            }],
        );
        let second = Uuid::from_u128(0x019e_2830_0000_7000_8000_0000_0000_0002);
        let mut request = validated(plan);
        request.selection.entity = super::super::dto::MetricDrilldownEntity::Persons {
            ids: vec![TEST_PERSON.to_string(), second.to_string()],
        };

        let rendered = compiled(&request);

        assert!(
            rendered
                .sql
                .contains("WHERE person_id IN {person_ids:Array(String)}"),
            "account arm"
        );
        assert!(
            rendered.sql.contains(
                "AND evidence.entity_id IN (SELECT email FROM identity.person_map WHERE person_id IN {person_ids:Array(String)})"
            ),
            "email fallback arm"
        );
        assert!(
            rendered
                .params
                .contains(&named("entity_type", Param::string("person")))
        );
        assert!(rendered.params.contains(&named(
            "person_ids",
            Param::strings([TEST_PERSON.to_string(), second.to_string()])
        )));
    }

    #[test]
    fn ratio_query_uses_named_inputs() {
        let numerator = input(MetricInputRole::Numerator, "focus_hours");
        let denominator = input(MetricInputRole::Denominator, "work_hours");
        let plan = plan(
            ComputationSpec::Ratio {
                numerator: numerator.clone(),
                denominator: denominator.clone(),
                scale: 100.0,
                denominator_aggregation: RatioDenominatorAggregation::Sum,
            },
            vec![
                EvidenceInput {
                    role: MetricInputRole::Numerator,
                    alias_collapse: AliasCollapse::Sum,
                    measure_key: numerator.measure_key,
                    presentation: EvidencePresentation::undeclared(
                        EvidenceGranularity::SourceSummary,
                    ),
                },
                EvidenceInput {
                    role: MetricInputRole::Denominator,
                    alias_collapse: AliasCollapse::Sum,
                    measure_key: denominator.measure_key,
                    presentation: EvidencePresentation::undeclared(
                        EvidenceGranularity::SourceSummary,
                    ),
                },
            ],
        );
        let request = validated(plan);
        let rendered = compiled(&request);
        assert!(rendered.sql.contains(
            "sumIf(collapsed.contribution, collapsed.measure_key = {numerator_key:String}) AS numerator"
        ));
        assert!(rendered.sql.contains(
            "sumIf(collapsed.contribution, collapsed.measure_key = {denominator_key:String}) AS denominator"
        ));
        assert!(rendered.sql.contains("daily_ratio"));
        let mut expected = vec![
            named("numerator_key", Param::string("focus_hours")),
            named("denominator_key", Param::string("work_hours")),
        ];
        expected.extend(scope_params(&["focus_hours", "work_hours"]));
        assert_eq!(rendered.params, expected);
    }

    #[test]
    fn a_drilldown_scopes_to_every_identity_the_person_resolves_from() {
        let request = validated(plan(
            ComputationSpec::Sum {
                value: input(MetricInputRole::Value, "commit_count"),
            },
            vec![EvidenceInput {
                role: MetricInputRole::Value,
                alias_collapse: AliasCollapse::Sum,
                measure_key: "commit_count".to_owned(),
                presentation: commit_presentation(),
            }],
        ));
        let rendered = compiled(&request);

        assert!(
            rendered.sql.contains(
                "AND evidence.entity_id IN (SELECT email FROM identity.person_map WHERE person_id = {person_id:String})"
            ),
            "scoped by the person's identity set, not one id"
        );
        assert!(
            rendered.sql.contains(
                "IN (SELECT source_type, source_id, account_id FROM identity.account_assignment WHERE person_id = {person_id:String})"
            ),
            "the account binding is consulted first"
        );
        assert!(
            rendered.sql.contains(
                "NOT IN (SELECT source_type, source_id, account_id FROM identity.account_assignment)"
            ),
            "a bound account never falls back to the email map — an excluded binding terminates"
        );
        assert!(
            rendered
                .sql
                .contains("sipHash128(coalesce(evidence.account_source_id, ''))"),
            "the binding key uses identity's minted source id form"
        );
        assert!(
            rendered
                .params
                .contains(&named("person_id", Param::string(TEST_PERSON.to_string()))),
            "the person is still what the request binds"
        );
    }

    #[test]
    fn the_ordering_key_ends_with_the_source_identity() {
        let request = validated(plan(
            ComputationSpec::Sum {
                value: input(MetricInputRole::Value, "commit_count"),
            },
            vec![EvidenceInput {
                role: MetricInputRole::Value,
                alias_collapse: AliasCollapse::Sum,
                measure_key: "commit_count".to_owned(),
                presentation: commit_presentation(),
            }],
        ));
        let sql = compiled(&request).sql;

        assert!(sql.contains("ORDER BY sort_flag DESC, sort_key DESC, role DESC"));
        assert!(
            sql.contains("ifNull(subject_key, '') DESC, entity_id DESC"),
            "identity is the last ordering column"
        );
    }

    fn commit_plan() -> ValidatedMetricDrilldown {
        validated(plan(
            ComputationSpec::Sum {
                value: input(MetricInputRole::Value, "commit_count"),
            },
            vec![EvidenceInput {
                role: MetricInputRole::Value,
                alias_collapse: AliasCollapse::Sum,
                measure_key: "commit_count".to_owned(),
                presentation: commit_presentation(),
            }],
        ))
    }

    fn roster_plan(ids: &[Uuid]) -> ValidatedMetricDrilldown {
        let mut request = commit_plan();
        request.selection.entity = MetricDrilldownEntity::Persons {
            ids: ids.iter().map(Uuid::to_string).collect(),
        };
        request
    }

    #[test]
    fn a_roster_resolves_who_through_identity_narrowed_to_that_roster() {
        let rendered = compiled(&roster_plan(&[TEST_PERSON]));

        assert!(rendered.sql.contains("AS person_id"));
        assert!(
            rendered.sql.contains(
                "FROM identity.account_assignment WHERE person_id IN {roster:Array(String)}"
            ),
            "the account side reads the roster, not the tenant: {}",
            rendered.sql
        );
        assert!(
            rendered
                .sql
                .contains("FROM identity.person_map WHERE person_id IN {roster:Array(String)}"),
            "the email side reads the roster, not the tenant: {}",
            rendered.sql
        );
        assert!(
            rendered
                .params
                .contains(&named("roster", Param::strings([TEST_PERSON.to_string()])))
        );
    }

    #[test]
    fn one_person_pays_for_no_identity_join() {
        let sql = compiled(&commit_plan()).sql;

        assert!(sql.contains("'' AS person_id"));
        assert!(!sql.contains("AS account_map"));
        assert!(!sql.contains("AS person_map"));
    }

    #[test]
    fn an_ascending_sort_leads_the_key_with_the_emptiness_flag() {
        let mut request = commit_plan();
        request.selection.sort = MetricDrilldownSort {
            key: "ref".to_owned(),
            direction: MetricDrilldownSortDirection::Asc,
        };
        let sql = compiled(&request).sql;

        assert!(sql.contains("ORDER BY sort_flag ASC, sort_key ASC, role ASC"));
        assert!(
            sql.contains("evidence.details['ref']"),
            "the order reads the same cell the row projection does: {sql}"
        );
        assert!(
            sql.contains("= '') AS sort_flag"),
            "ascending pushes the blank cells past the filled ones: {sql}"
        );
    }

    #[test]
    fn a_descending_page_walks_the_cursor_the_other_way() {
        let mut request = commit_plan();
        request.cursor = Some(CursorKey {
            sort_flag: true,
            sort_value: "2026-07-01".to_owned(),
            entity_id: "person@example.com".to_owned(),
            role: "value".to_owned(),
            metric_date: "2026-07-01".to_owned(),
            observed_at: String::new(),
            source_key: "git".to_owned(),
            measure_key: "commit_count".to_owned(),
            record_id: "abc".to_owned(),
            record_kind: "commit".to_owned(),
            subject_key: String::new(),
        });
        let rendered = compiled(&request);

        assert!(rendered.sql.contains("< tuple(toUInt8({cursor_flag:Bool})"));
        assert!(
            rendered
                .params
                .contains(&named("cursor_flag", Param::bool(true))),
            "the flag is replayed too"
        );
    }

    #[test]
    fn a_number_sort_replays_its_cursor_value_as_a_number() {
        let mut request = commit_plan();
        request.selection.sort = MetricDrilldownSort {
            key: "lines_added".to_owned(),
            direction: MetricDrilldownSortDirection::Asc,
        };
        request.cursor = Some(CursorKey {
            sort_flag: false,
            sort_value: "12".to_owned(),
            entity_id: "person@example.com".to_owned(),
            role: "value".to_owned(),
            metric_date: "2026-07-01".to_owned(),
            observed_at: String::new(),
            source_key: "git".to_owned(),
            measure_key: "commit_count".to_owned(),
            record_id: "abc".to_owned(),
            record_kind: "commit".to_owned(),
            subject_key: String::new(),
        });
        let rendered = compiled(&request);

        assert!(
            rendered.sql.contains(
                "> tuple(toUInt8({cursor_flag:Bool}), toFloat64({cursor_sort_value:String}), {cursor_role:String}"
            ),
            "{}",
            rendered.sql
        );
        assert!(
            rendered
                .params
                .contains(&named("cursor_sort_value", Param::string("12")))
        );
    }

    #[test]
    fn a_search_reads_every_column_the_reader_can_see() {
        let mut request = commit_plan();
        request.selection.search = Some("fix".to_owned());
        let rendered = compiled(&request);

        assert_eq!(
            rendered.sql.matches("{needle:String}) > 0").count(),
            rendered.sql.matches("positionCaseInsensitiveUTF8").count(),
            "every searched column reads the one bound needle"
        );
        assert_eq!(
            rendered
                .params
                .iter()
                .filter(|(_, param)| *param == Param::string("fix"))
                .count(),
            1
        );
        assert!(rendered.sql.contains("evidence.details['title']"));
        assert!(rendered.sql.contains("toString(evidence.metric_date)"));
    }

    #[test]
    fn a_search_reaches_the_who_column_through_the_people_it_names() {
        let mut request = roster_plan(&[TEST_PERSON]);
        request.selection.search = Some("ada".to_owned());
        request.search_person_ids = vec![TEST_PERSON.to_string()];
        let rendered = compiled(&request);

        assert!(
            rendered
                .sql
                .contains("OR multiIf(coalesce(account_map.account_id"),
            "the needle's people join the same OR chain: {}",
            rendered.sql
        );
        assert!(
            rendered
                .sql
                .contains("IN {search_person_ids:Array(String)})")
        );
        assert!(rendered.params.contains(&named(
            "search_person_ids",
            Param::strings([TEST_PERSON.to_string()])
        )));
    }

    #[test]
    fn a_search_matching_nobody_adds_no_identity_term() {
        let mut request = roster_plan(&[TEST_PERSON]);
        request.selection.search = Some("nobody".to_owned());
        let rendered = compiled(&request);

        assert!(
            !rendered
                .sql
                .contains("OR multiIf(coalesce(account_map.account_id")
        );
        assert!(!rendered.sql.contains("search_person_ids"));
    }

    #[test]
    fn a_ratio_narrows_and_orders_outside_its_aggregation() {
        let mut request = ratio_plan(AliasCollapse::Sum, RatioDenominatorAggregation::Sum);
        request.selection.search = Some("7".to_owned());
        request.selection.sort = MetricDrilldownSort {
            key: "numerator".to_owned(),
            direction: MetricDrilldownSortDirection::Desc,
        };
        let sql = compiled(&request).sql;

        assert!(sql.contains(") AS evidence WHERE (positionCaseInsensitiveUTF8"));
        assert!(sql.contains("ORDER BY sort_flag DESC, sort_key DESC"));
    }

    fn ratio_plan(
        denominator_collapse: AliasCollapse,
        denominator_aggregation: RatioDenominatorAggregation,
    ) -> ValidatedMetricDrilldown {
        let numerator = input(MetricInputRole::Numerator, "commit_count");
        let denominator = input(MetricInputRole::Denominator, "commit_day");
        validated(plan(
            ComputationSpec::Ratio {
                numerator: numerator.clone(),
                denominator: denominator.clone(),
                scale: 1.0,
                denominator_aggregation,
            },
            vec![
                EvidenceInput {
                    role: MetricInputRole::Numerator,
                    alias_collapse: AliasCollapse::Sum,
                    measure_key: numerator.measure_key,
                    presentation: EvidencePresentation::undeclared(
                        EvidenceGranularity::SourceSummary,
                    ),
                },
                EvidenceInput {
                    role: MetricInputRole::Denominator,
                    alias_collapse: denominator_collapse,
                    measure_key: denominator.measure_key,
                    presentation: EvidencePresentation::undeclared(
                        EvidenceGranularity::SourceSummary,
                    ),
                },
            ],
        ))
    }

    fn record_ratio_plan(aggregation: RatioDenominatorAggregation) -> ValidatedMetricDrilldown {
        validated(ratio_over(commit_input, aggregation))
    }

    #[test]
    fn a_ratio_of_records_answers_one_row_per_record_it_counts() {
        let mut request = record_ratio_plan(RatioDenominatorAggregation::Sum);
        request.selection.search = Some("fix".to_owned());
        request.selection.sort = MetricDrilldownSort {
            key: "title".to_owned(),
            direction: MetricDrilldownSortDirection::Asc,
        };
        let rendered = compiled(&request);

        assert!(
            rendered.sql.contains(
                "GROUP BY collapsed.record_key HAVING numerator != 0 OR denominator != 0"
            )
        );
        assert!(!rendered.sql.contains("daily_ratio"));
        assert!(
            rendered
                .sql
                .contains("toJSONString(evidence.dimensions), multiIf(coalesce(account_map"),
            "records of different people never merge: {}",
            rendered.sql
        );
        assert!(
            rendered.sql.contains("evidence.details['ref']"),
            "the record is named by its source ref: {}",
            rendered.sql
        );
        assert!(rendered.sql.contains("evidence.details['title']"));
        assert_eq!(
            rendered.params[..3],
            [
                named("numerator_key", Param::string("focus_hours")),
                named("denominator_key", Param::string("work_hours")),
                named("tenant", Param::string(TEST_TENANT.to_string())),
            ]
        );
    }

    #[test]
    fn a_ratio_of_records_counting_distinct_days_counts_the_records_sharing_each_day() {
        let sql = compiled(&record_ratio_plan(
            RatioDenominatorAggregation::DistinctCount,
        ))
        .sql;

        assert!(
            sql.contains("GROUP BY collapsed.record_key HAVING numerator != 0 OR denominator != 0")
        );
        assert!(!sql.contains("daily_ratio"));
        assert!(!sql.contains("subject_share"));
        assert!(
            sql.contains(
                "count() OVER (PARTITION BY evidence.measure_key, person_key, evidence.subject_key) AS subject_records"
            ),
            "a record knows how many records share its day: {sql}"
        );
        assert!(
            sql.contains(
                "toFloat64(anyIf(collapsed.subject_records, collapsed.measure_key = {denominator_key:String} AND collapsed.subject_key IS NOT NULL)) AS denominator"
            ),
            "the row carries that whole count: {sql}"
        );
    }

    #[test]
    fn a_ratio_of_records_that_sums_its_denominator_counts_no_subject_records() {
        let sql = compiled(&record_ratio_plan(RatioDenominatorAggregation::Sum)).sql;

        assert!(!sql.contains("subject_records"));
    }

    fn folded_plan(entity: MetricDrilldownEntity) -> ValidatedMetricDrilldown {
        let mut lines = commit_input(MetricInputRole::Value, "code_lines_added");
        lines.presentation.show_value = true;
        lines.presentation.record_parts = Some("file_extension".to_owned());
        let mut request = validated(plan(
            ComputationSpec::Sum {
                value: input(MetricInputRole::Value, "code_lines_added"),
            },
            vec![lines],
        ));
        request.selection.entity = entity;
        request
    }

    #[test]
    fn a_record_split_into_parts_answers_as_one_row_listing_them() {
        let rendered = compiled(&folded_plan(MetricDrilldownEntity::Person {
            id: TEST_PERSON.to_string(),
        }));

        assert!(
            rendered
                .sql
                .contains("sum(evidence.contribution) AS contribution")
        );
        assert!(
            rendered
                .sql
                .contains("groupArrayIntersect(evidence.dimensions) AS dimensions"),
            "only what every part shares stays a dimension of the record: {}",
            rendered.sql
        );
        assert!(
            rendered.sql.contains("map('parts', arrayStringConcat("),
            "the record lists its parts: {}",
            rendered.sql
        );
        assert!(rendered.sql.contains("dimension.1 = 'file_extension'"));
        assert!(
            rendered
                .sql
                .contains("evidence.source_key, evidence.measure_key, record_id) AS evidence")
        );
        let mut expected = vec![
            named("measure_key", Param::string("code_lines_added")),
            named("role", Param::string("value")),
        ];
        expected.extend(scope_params(&["code_lines_added"]));
        assert_eq!(rendered.params, expected);
    }

    #[test]
    fn a_record_split_into_many_parts_names_the_largest_three_and_totals_the_other_types() {
        let sql = compiled(&folded_plan(MetricDrilldownEntity::Person {
            id: TEST_PERSON.to_string(),
        }))
        .sql;

        assert!(
            sql.contains(", 1, 3)"),
            "only the three largest parts are named: {sql}"
        );
        assert!(
            sql.contains("' other types '") && !sql.contains("' more '"),
            "the parts beyond them read as the other types they are: {sql}"
        );
        assert!(
            sql.contains(") > 4,"),
            "a single leftover part is named rather than folded: {sql}"
        );
    }

    #[test]
    fn a_record_is_keyed_by_its_repository_value_not_its_label() {
        let key = "concat(evidence.record_kind, ':', evidence.details['source_id'], ':', \
                   arrayFirst(dimension -> dimension.1 = 'repository', evidence.dimensions).2, ':', \
                   evidence.details['ref'])";
        for plan in [
            folded_plan(MetricDrilldownEntity::Person {
                id: TEST_PERSON.to_string(),
            }),
            record_ratio_plan(RatioDenominatorAggregation::Sum),
        ] {
            let sql = compiled(&plan).sql;
            assert!(
                sql.split_whitespace()
                    .collect::<String>()
                    .contains(&key.split_whitespace().collect::<String>()),
                "two repositories sharing a label stay two records: {sql}"
            );
        }
    }

    #[test]
    fn a_roster_names_who_after_folding_each_record() {
        let rendered = compiled(&folded_plan(MetricDrilldownEntity::Persons {
            ids: vec![TEST_PERSON.to_string()],
        }));

        let folded = rendered
            .sql
            .find("record_id) AS evidence")
            .unwrap_or_else(|| panic!("the rows fold: {}", rendered.sql));
        let joined = rendered
            .sql
            .find("AS account_map")
            .unwrap_or_else(|| panic!("the roster resolves who: {}", rendered.sql));
        assert!(
            folded < joined,
            "the identity join reads the folded rows: {}",
            rendered.sql
        );
        assert_eq!(
            rendered.params.last(),
            Some(&named("roster", Param::strings([TEST_PERSON.to_string()]))),
            "the roster binds where its join reads it, after the scope"
        );
    }

    #[test]
    fn a_ratio_drilldown_collapses_a_flag_denominator_before_the_daily_rollup() {
        let rendered = compiled(&ratio_plan(
            AliasCollapse::Max,
            RatioDenominatorAggregation::Sum,
        ));

        assert!(
            rendered.sql.contains(
                "multiIf(evidence.measure_key = {measure_key:String}, max(ifNull(evidence.contribution, 0)), sum(ifNull(evidence.contribution, 0)))"
            ),
            "the flagged half collapses with max, the additive half still sums"
        );
        assert!(
            rendered
                .params
                .contains(&named("measure_key", Param::string("commit_day")))
        );
        assert!(
            rendered
                .sql
                .contains("GROUP BY evidence.metric_date, evidence.measure_key"),
            "collapse happens at the evidence grain, under the daily rollup"
        );
    }

    #[test]
    fn a_ratio_drilldown_collapses_an_inverse_flag_denominator_with_min() {
        let sql = compiled(&ratio_plan(
            AliasCollapse::Min,
            RatioDenominatorAggregation::Sum,
        ))
        .sql;

        assert!(sql.contains("min(ifNull(evidence.contribution, 0))"));
        assert!(!sql.contains("max(ifNull(evidence.contribution, 0))"));
    }

    #[test]
    fn an_all_additive_ratio_drilldown_has_no_collapse_branch() {
        let sql = compiled(&ratio_plan(
            AliasCollapse::Sum,
            RatioDenominatorAggregation::Sum,
        ))
        .sql;

        assert!(!sql.contains("max(ifNull(evidence.contribution, 0))"));
        assert!(!sql.contains("min(ifNull(evidence.contribution, 0))"));
        assert!(sql.contains("sum(ifNull(evidence.contribution, 0))"));
    }

    #[test]
    fn the_ratio_collapse_groups_by_the_resolved_person() {
        let sql = compiled(&ratio_plan(
            AliasCollapse::Max,
            RatioDenominatorAggregation::Sum,
        ))
        .sql;

        assert!(
            sql.contains("LEFT JOIN identity.account_assignment AS account_map"),
            "the collapse resolves the person account-first"
        );
        assert!(
            sql.contains("toJSONString(evidence.dimensions), multiIf(coalesce(account_map"),
            "the resolved person closes the collapse GROUP BY"
        );
    }

    #[test]
    fn ratio_query_uses_distinct_denominator_aggregation() {
        let sql = compiled(&ratio_plan(
            AliasCollapse::Max,
            RatioDenominatorAggregation::DistinctCount,
        ))
        .sql;

        assert!(sql.contains("uniqExactIf((collapsed.person_key, collapsed.subject_key)"));
    }
}
