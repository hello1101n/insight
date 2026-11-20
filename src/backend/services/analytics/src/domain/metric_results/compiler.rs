use std::collections::{BTreeSet, HashMap};
use std::fmt::Write;

use insight_clickhouse::{Param, Sql, sql};
use serde::Deserialize;
use uuid::Uuid;

use super::batch::{
    PeerPopulation, ResolvedGroupLimit, peer_aliases, period_alias, period_compare_alias,
};
use super::validation::{
    DateWindow, HISTOGRAM_BINS, ValidatedDimensionFilter, ValidatedEntitySelection,
    ValidatedMetricResultsRequest, query_row_limit,
};
use super::view::Bucket;
use crate::domain::metric_definitions::{
    AliasCollapse, CohortSource, ComputationSpec, MetricDefinition, MetricInput, ObservationSource,
    RatioDenominatorAggregation,
};

pub(crate) const UNKNOWN_DIMENSION_VALUE: &str = "__unknown__";
pub(crate) const UNKNOWN_DIMENSION_LABEL: &str = "Unknown";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QueryBucket {
    Day,
    Week,
    Month,
    Quarter,
    Year,
}

impl From<Bucket> for QueryBucket {
    fn from(bucket: Bucket) -> Self {
        match bucket {
            Bucket::Day => Self::Day,
            Bucket::Week => Self::Week,
            Bucket::Month => Self::Month,
        }
    }
}

pub(crate) const PERSON_MAP_RELATION: &str = "identity.person_map";

pub(crate) const ACCOUNT_ASSIGNMENT_RELATION: &str = "identity.account_assignment";

const EXCLUDED_PERSON_ID: &str = "ffffffff-ffff-ffff-ffff-ffffffffffff";

/// The median a reader means: the average of the two middle values on an even
/// sample. `quantileExact` takes an index instead, so it answers with the upper
/// middle — a person with two observations is reported at the slower of them,
/// and on a `lower_is_better` metric that always reads unfavourably.
/// `quantileExactInclusive` interpolates to the textbook definition and stays
/// exact, so nothing is approximated by a sketch. A percentile keeps
/// `quantileExact`: unlike the median it has no second definition to match.
/// #3362
const MEDIAN_AGGREGATE: &str = "quantileExactInclusiveIf";

const MEDIAN_AGGREGATE_OR_NULL: &str = "quantileExactInclusiveIfOrNull";

const RESOLVED_OBSERVATION_COLUMNS: &str = "tenant_id, entity_type, source_key, measure_key, metric_date, observed_at, value, \
     subject_key, dimensions";

pub(crate) const MIN_PEER_N: u32 = 5;

#[derive(Debug)]
pub struct CompiledQuery {
    pub sql: Sql,
}

#[derive(Debug, Deserialize)]
pub struct PeriodQueryRow {
    pub entity_id: String,
    pub value: Option<f64>,
    #[serde(default)]
    pub compare_to: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct TimeseriesQueryRow {
    pub entity_id: String,
    pub bucket_start: String,
    pub value: Option<f64>,
    #[serde(default)]
    pub numerator: Option<f64>,
    #[serde(default)]
    pub denominator: Option<f64>,
    pub is_total: u8,
    pub rank: Option<u32>,
    pub remainder: u8,
    pub group_label: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct RankingQueryRow {
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct PeerQueryRow {
    pub entity_id: String,
    pub target_value: Option<f64>,
    pub p25: Option<f64>,
    pub median: Option<f64>,
    pub p75: Option<f64>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    #[serde(default, deserialize_with = "optional_u64")]
    pub n: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct BreakdownQueryRow {
    pub entity_id: String,
    pub value: Option<f64>,
    #[serde(rename = "link_source_provider")]
    pub source_provider: Option<String>,
    #[serde(rename = "link_source_id")]
    pub source_id: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct UnattributedQueryRow {
    pub value: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct RollupQueryRow {
    pub value: Option<f64>,
    #[serde(default, deserialize_with = "optional_u64")]
    pub contributing_entity_count: Option<u64>,
    pub rank: Option<u32>,
    pub remainder: u8,
    pub group_label: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct HistogramQueryRow {
    pub entity_id: String,
    pub bin_idx: u32,
    pub entity_lo: f64,
    pub entity_hi: f64,
    #[serde(default, deserialize_with = "optional_u64")]
    pub bin_count: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct PooledHistogramQueryRow {
    pub bin_idx: u32,
    pub group_lo: f64,
    pub group_hi: f64,
    #[serde(default, deserialize_with = "optional_u64")]
    pub bin_count: Option<u64>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

pub(crate) fn compile_period_batch_query(
    defs: &[&MetricDefinition],
    req: &ValidatedMetricResultsRequest,
    filters: &[ValidatedDimensionFilter],
) -> CompiledQuery {
    let mut selects = item_value_selects(defs, period_alias, primary_window(req));
    if let Some(compare_to) = req.compare_to {
        selects.push(item_value_selects(
            defs,
            period_compare_alias,
            Some(compare_to),
        ));
    }
    let read = batch_resolved_observation_from(defs, req, ScanScope::WithComparison);
    let metric_scope =
        shared_observation_where_within(defs, req, filters, ScanScope::WithComparison);
    let entity_scope = read.entity_scope(req);
    let inner = sql!(
        r"
        SELECT
            entity_id{selects}
        FROM {observation_table}
        WHERE {metric_scope}{entity_scope}
        GROUP BY entity_id
        LIMIT {limit}
        ",
        selects = selects,
        observation_table = read.from,
        metric_scope = metric_scope,
        entity_scope = entity_scope,
        limit = row_limit(),
    );
    let sql = transformed_batch(defs, inner, req.compare_to.is_some());
    CompiledQuery { sql }
}

fn primary_window(req: &ValidatedMetricResultsRequest) -> Option<DateWindow> {
    req.compare_to.map(|_| DateWindow {
        from: req.from,
        to: req.to,
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ScanScope {
    PrimaryOnly,
    WithComparison,
}

impl ScanScope {
    fn windows(self, req: &ValidatedMetricResultsRequest) -> Vec<DateWindow> {
        let primary = DateWindow {
            from: req.from,
            to: req.to,
        };
        match (self, req.compare_to) {
            (Self::WithComparison, Some(compare_to)) => vec![primary, compare_to],
            (Self::WithComparison, None) | (Self::PrimaryOnly, _) => vec![primary],
        }
    }
}

fn scan_window_predicate(
    req: &ValidatedMetricResultsRequest,
    column: &str,
    separator: &str,
    scope: ScanScope,
) -> Sql {
    let mut terms = scope
        .windows(req)
        .into_iter()
        .map(|window| {
            sql!(
                "{column} >= {from}{separator}AND {column} <= {to}",
                column = Sql::raw(column),
                separator = Sql::raw(separator),
                from = Param::date(window.from),
                to = Param::date(window.to),
            )
        })
        .collect::<Vec<_>>();
    if terms.len() == 1 {
        return terms.pop().unwrap_or_default();
    }
    let alternatives = terms.into_iter().map(|term| sql!("({term})", term = term));
    sql!("({terms})", terms = Sql::join(alternatives, " OR "))
}

fn window_term(window: Option<DateWindow>) -> Sql {
    let Some(window) = window else {
        return Sql::default();
    };
    sql!(
        " AND metric_date >= {from} AND metric_date <= {to}",
        from = Param::date(window.from),
        to = Param::date(window.to),
    )
}

pub(crate) fn compile_timeseries_query(
    def: &MetricDefinition,
    req: &ValidatedMetricResultsRequest,
    bucket: QueryBucket,
    dimensions: &[String],
    filters: &[ValidatedDimensionFilter],
    group_limit: Option<&ResolvedGroupLimit>,
) -> CompiledQuery {
    if let Some(group_limit) = group_limit {
        return compile_capped_timeseries_query(def, req, bucket, dimensions, filters, group_limit);
    }
    let read = single_resolved_observation_from(def, req, ScanScope::PrimaryOnly);
    let entity_scope = read.entity_scope(req);
    let bucket = bucket_expr(bucket);
    let (dim_select, dim_group) = dimension_select_group(dimensions);
    let bucket_group = if dim_group.is_empty() {
        format!("entity_id, {bucket}")
    } else {
        format!("entity_id, {bucket}, {dim_group}")
    };
    let total_group = if dim_group.is_empty() {
        "entity_id".to_owned()
    } else {
        format!("entity_id, {dim_group}")
    };
    let inner = sql!(
        r"
        SELECT
            entity_id,
            toString({bucket}) AS bucket_start{dim_select},
            {value_expr} AS value{sides_select},
            toUInt8(grouping({bucket})) AS is_total,
            CAST(NULL AS Nullable(UInt32)) AS rank,
            toUInt8(0) AS remainder,
            CAST(NULL AS Nullable(String)) AS group_label
        FROM {observation_table} AS {OBS}
        WHERE {metric_where}
          {filter_where}{entity_scope}
        GROUP BY GROUPING SETS (({bucket_group}), ({total_group}))
        ORDER BY entity_id, is_total, bucket_start
        LIMIT {limit}
        ",
        bucket = Sql::raw(bucket),
        dim_select = Sql::raw(dim_select),
        value_expr = grouped_value_expr(def, None),
        sides_select = ratio_sides_expr(def),
        observation_table = read.from,
        metric_where = metric_where(def, req, ScanScope::PrimaryOnly),
        filter_where = dimension_filter_where(filters),
        entity_scope = entity_scope,
        bucket_group = Sql::raw(bucket_group),
        total_group = Sql::raw(total_group),
        limit = row_limit(),
    );
    let sql = transformed_single(def, inner);
    CompiledQuery { sql }
}

pub(crate) fn compile_report_timeseries_query(
    def: &MetricDefinition,
    tenant_id: uuid::Uuid,
    entity: ValidatedEntitySelection,
    from: chrono::NaiveDate,
    to: chrono::NaiveDate,
    enforce_tenant_scope: bool,
    bucket: QueryBucket,
) -> CompiledQuery {
    let request = ValidatedMetricResultsRequest {
        tenant_id,
        entity,
        from,
        to,
        metrics: Vec::new(),
        enforce_tenant_scope,
        compare_to: None,
    };

    compile_timeseries_query(def, &request, bucket, &[], &[], None)
}

pub(crate) fn compile_group_ranking_query(
    def: &MetricDefinition,
    req: &ValidatedMetricResultsRequest,
    dimensions: &[String],
    filters: &[ValidatedDimensionFilter],
    count: usize,
) -> CompiledQuery {
    let read = single_resolved_observation_from(def, req, ScanScope::PrimaryOnly);
    let entity_scope = read.entity_scope(req);
    let (dim_select, dim_group, dim_order) = ranking_dimension_select_group(dimensions);
    let inner = sql!(
        r"
        SELECT
            {dim_select},
            {value_expr} AS value
        FROM {observation_table}
        WHERE {metric_where}
          {filter_where}{entity_scope}
        GROUP BY {dim_group}
        ",
        dim_select = Sql::raw(dim_select),
        value_expr = grouped_value_expr(def, None),
        observation_table = read.from,
        metric_where = metric_where(def, req, ScanScope::PrimaryOnly),
        filter_where = dimension_filter_where(filters),
        entity_scope = entity_scope,
        dim_group = Sql::raw(dim_group),
    );
    let sql = sql!(
        r"
        SELECT *
        FROM ({transformed})
        WHERE value IS NOT NULL
        ORDER BY value DESC, {dim_order}
        LIMIT {count}
        ",
        transformed = transformed_single(def, inner),
        dim_order = Sql::raw(dim_order),
        count = Sql::raw(count.to_string()),
    );
    CompiledQuery { sql }
}

fn compile_capped_timeseries_query(
    def: &MetricDefinition,
    req: &ValidatedMetricResultsRequest,
    bucket: QueryBucket,
    dimensions: &[String],
    filters: &[ValidatedDimensionFilter],
    group_limit: &ResolvedGroupLimit,
) -> CompiledQuery {
    let read = single_resolved_observation_from(def, req, ScanScope::PrimaryOnly);
    let entity_scope = read.entity_scope(req);
    let bucket = bucket_expr(bucket);
    let remainder_filter = if group_limit.include_remainder {
        ""
    } else {
        "WHERE group_rank > 0"
    };
    let sql = sql!(
        r"
        WITH scoped AS (
            SELECT
                *,
                {bucket} AS bucket_start
                {raw_dimensions}
            FROM {observation_table}
            WHERE {metric_where}
              {filter_where}{entity_scope}
        ),
        ranked AS (
            SELECT
                *,
                {rank_expr} AS group_rank
            FROM scoped
        ),
        filtered AS (
            SELECT *
            FROM ranked
            {remainder_filter}
        ),
        aggregated AS (
            SELECT
                entity_id,
                bucket_start,
                group_rank,
                {value_expr} AS value,
                toUInt8(grouping(bucket_start)) AS is_total
            FROM filtered
            GROUP BY GROUPING SETS (
                (entity_id, bucket_start, group_rank),
                (entity_id, group_rank)
            )
        )
        SELECT
            entity_id,
            toString(bucket_start) AS bucket_start
            {dimension_select},
            {value} AS value,
            is_total,
            if(group_rank = 0, CAST(NULL AS Nullable(UInt32)), toNullable(group_rank)) AS rank,
            toUInt8(group_rank = 0) AS remainder,
            if(group_rank = 0, toNullable('Other'), CAST(NULL AS Nullable(String))) AS group_label
        FROM aggregated
        ORDER BY entity_id, group_rank, is_total, bucket_start
        LIMIT {limit}
        ",
        bucket = Sql::raw(bucket),
        raw_dimensions = Sql::raw(raw_dimension_selects(dimensions)),
        observation_table = read.from,
        metric_where = metric_where(def, req, ScanScope::PrimaryOnly),
        filter_where = dimension_filter_where(filters),
        entity_scope = entity_scope,
        rank_expr = capped_rank_expr(group_limit, dimensions.len()),
        remainder_filter = Sql::raw(remainder_filter),
        value_expr = grouped_value_expr(def, None),
        dimension_select = capped_dimension_select(group_limit, dimensions),
        value = Sql::raw(transformed(def, "value".to_owned())),
        limit = row_limit(),
    );
    CompiledQuery { sql }
}

fn raw_dimension_selects(dimensions: &[String]) -> String {
    dimensions
        .iter()
        .enumerate()
        .fold(String::new(), |mut raw_dimensions, (index, dimension)| {
            let _ = write!(
                raw_dimensions,
                ", {} AS raw_dim_{index}",
                dimension_value_expr(dimension)
            );
            raw_dimensions
        })
}

fn capped_rank_expr(group_limit: &ResolvedGroupLimit, dimension_count: usize) -> Sql {
    if group_limit.groups.is_empty() {
        return Sql::raw("toUInt32(0)");
    }
    let mut branches = Vec::with_capacity(group_limit.groups.len() * 2 + 1);
    for group in &group_limit.groups {
        let comparisons = (0..dimension_count)
            .zip(&group.dimensions)
            .map(|(index, dimension)| {
                sql!(
                    "{column} = {group_value}",
                    column = Sql::raw(format!("raw_dim_{index}")),
                    group_value = Param::string(dimension.value.clone()),
                )
            });
        branches.push(sql!(
            "({comparisons})",
            comparisons = Sql::join(comparisons, " AND ")
        ));
        branches.push(Sql::raw(format!("toUInt32({})", group.rank)));
    }
    branches.push(Sql::raw("toUInt32(0)"));
    sql!("multiIf({branches})", branches = Sql::join(branches, ", "))
}

fn capped_dimension_select(group_limit: &ResolvedGroupLimit, dimensions: &[String]) -> Sql {
    let mut select = Sql::default();
    for (index, _) in dimensions.iter().enumerate() {
        let (value_alias, label_alias) = dimension_aliases(index);
        if group_limit.groups.is_empty() {
            select.push(Sql::raw(format!(
                ", CAST(NULL AS Nullable(String)) AS {value_alias}, CAST(NULL AS Nullable(String)) AS {label_alias}"
            )));
            continue;
        }
        let mut value_branches = Vec::with_capacity(group_limit.groups.len() * 2 + 1);
        let mut label_branches = Vec::with_capacity(group_limit.groups.len() * 2 + 1);
        for group in &group_limit.groups {
            let dimension = &group.dimensions[index];
            let rank_matches = format!("group_rank = {}", group.rank);
            value_branches.push(Sql::raw(rank_matches.clone()));
            value_branches.push(sql!(
                "toNullable({group_value})",
                group_value = Param::string(dimension.value.clone()),
            ));
            label_branches.push(Sql::raw(rank_matches));
            label_branches.push(match &dimension.label {
                Some(label) => sql!(
                    "toNullable({group_label})",
                    group_label = Param::string(label.clone()),
                ),
                None => Sql::raw("CAST(NULL AS Nullable(String))"),
            });
        }
        value_branches.push(Sql::raw("CAST(NULL AS Nullable(String))"));
        label_branches.push(Sql::raw("CAST(NULL AS Nullable(String))"));
        select.push(sql!(
            ", multiIf({values}) AS {value_alias}, multiIf({labels}) AS {label_alias}",
            values = Sql::join(value_branches, ", "),
            value_alias = Sql::raw(value_alias),
            labels = Sql::join(label_branches, ", "),
            label_alias = Sql::raw(label_alias),
        ));
    }
    select
}

pub(crate) fn compile_breakdown_query(
    def: &MetricDefinition,
    req: &ValidatedMetricResultsRequest,
    dimensions: &[String],
    filters: &[ValidatedDimensionFilter],
) -> CompiledQuery {
    let mut value_selects = Sql::default();
    for (staged, presence_alias, window) in breakdown_columns(req) {
        value_selects.push(sql!(
            ",
            {expr} AS {staged}",
            expr = grouped_value_expr(def, window),
            staged = Sql::raw(staged),
        ));
        let (Some(window), Some(presence_alias)) = (window, presence_alias) else {
            continue;
        };
        value_selects.push(sql!(
            ",
            {presence} AS {presence_alias}",
            presence = window_presence_expr(window),
            presence_alias = Sql::raw(presence_alias),
        ));
    }
    let read = single_resolved_observation_from(def, req, ScanScope::WithComparison);
    let entity_scope = read.entity_scope(req);
    let (dim_select, dim_group) = dimension_select_group(dimensions);
    let (source_select, source_group) = hidden_source_context(dimensions);
    let group = if dim_group.is_empty() {
        "entity_id".to_owned()
    } else {
        format!("entity_id, {dim_group}")
    };
    let inner = sql!(
        r"
        SELECT
            entity_id{dim_select}{source_select}{value_selects}
        FROM {observation_table}
        WHERE {metric_where}
          {filter_where}{entity_scope}
        GROUP BY {group}
        ORDER BY entity_id
        LIMIT {limit}
        ",
        dim_select = Sql::raw(dim_select),
        source_select = Sql::raw(source_select),
        value_selects = value_selects,
        observation_table = read.from,
        metric_where = metric_where(def, req, ScanScope::WithComparison),
        filter_where = dimension_filter_where(filters),
        entity_scope = entity_scope,
        group = Sql::raw(format!("{group}{source_group}")),
        limit = row_limit(),
    );
    let sql = if req.compare_to.is_none() {
        transformed_single(def, inner)
    } else {
        projected_breakdown_columns(def, inner)
    };
    CompiledQuery { sql }
}

/// INVARIANT: a windowed breakdown must NOT alias any aggregate `value`. The
/// aggregates read a column of that name, and a sibling's argument resolves to
/// the alias instead of the column — which ClickHouse rejects outright as an
/// aggregate inside an aggregate. The wire names are put back by
/// `projected_breakdown_columns`.
type BreakdownColumn = (&'static str, Option<&'static str>, Option<DateWindow>);

fn breakdown_columns(req: &ValidatedMetricResultsRequest) -> Vec<BreakdownColumn> {
    let Some(compare_to) = req.compare_to else {
        return vec![("value", None, None)];
    };
    let primary = DateWindow {
        from: req.from,
        to: req.to,
    };
    vec![
        (STAGED_VALUE, Some(PRESENT), Some(primary)),
        (STAGED_COMPARE, Some(PRESENT_COMPARE), Some(compare_to)),
    ]
}

const STAGED_VALUE: &str = "staged_value";
const STAGED_COMPARE: &str = "staged_compare";
pub(crate) const PRESENT: &str = "present";
pub(crate) const PRESENT_COMPARE: &str = "present_compare";
pub(crate) const VALUE_COMPARE: &str = "value_compare";

fn window_presence_expr(window: DateWindow) -> Sql {
    sql!(
        "countIf(metric_date >= {from} AND metric_date <= {to}) > 0",
        from = Param::date(window.from),
        to = Param::date(window.to),
    )
}

fn projected_breakdown_columns(def: &MetricDefinition, inner: Sql) -> Sql {
    let mut selects = String::new();
    for (staged, wire) in [(STAGED_VALUE, "value"), (STAGED_COMPARE, VALUE_COMPARE)] {
        let expr = transformed(def, staged.to_owned());
        let _ = write!(
            selects,
            ",
            {expr} AS {wire}"
        );
    }
    sql!(
        r"
        SELECT
            * EXCEPT ({STAGED_VALUE}, {STAGED_COMPARE}){selects}
        FROM ({inner})
        ",
        selects = Sql::raw(selects),
        inner = inner,
    )
}

pub(crate) fn compile_rollup_query(
    def: &MetricDefinition,
    req: &ValidatedMetricResultsRequest,
    dimensions: &[String],
    filters: &[ValidatedDimensionFilter],
    group_limit: Option<&ResolvedGroupLimit>,
) -> CompiledQuery {
    match group_limit {
        Some(group_limit) => {
            compile_capped_rollup_query(def, req, dimensions, filters, group_limit)
        }
        None => compile_uncapped_rollup_query(def, req, dimensions, filters),
    }
}

fn compile_uncapped_rollup_query(
    def: &MetricDefinition,
    req: &ValidatedMetricResultsRequest,
    dimensions: &[String],
    filters: &[ValidatedDimensionFilter],
) -> CompiledQuery {
    let read = single_resolved_observation_from(def, req, ScanScope::PrimaryOnly);
    let entity_scope = read.entity_scope(req);
    let (dim_select, dim_group, dim_order) = ranking_dimension_select_group(dimensions);
    let inner = sql!(
        r"
        SELECT
            {dim_select},
            {value_expr} AS value,
            uniqExact(entity_id) AS contributing_entity_count,
            CAST(NULL AS Nullable(UInt32)) AS rank,
            toUInt8(0) AS remainder,
            CAST(NULL AS Nullable(String)) AS group_label
        FROM {observation_table}
        WHERE {metric_where}
          {filter_where}{entity_scope}
        GROUP BY {dim_group}
        ORDER BY {dim_order}
        LIMIT {limit}
        ",
        dim_select = Sql::raw(dim_select),
        value_expr = grouped_value_expr(def, None),
        observation_table = read.from,
        metric_where = metric_where(def, req, ScanScope::PrimaryOnly),
        filter_where = dimension_filter_where(filters),
        entity_scope = entity_scope,
        dim_group = Sql::raw(dim_group),
        dim_order = Sql::raw(dim_order),
        limit = row_limit(),
    );
    let sql = transformed_single(def, inner);
    CompiledQuery { sql }
}

fn compile_capped_rollup_query(
    def: &MetricDefinition,
    req: &ValidatedMetricResultsRequest,
    dimensions: &[String],
    filters: &[ValidatedDimensionFilter],
    group_limit: &ResolvedGroupLimit,
) -> CompiledQuery {
    let read = single_resolved_observation_from(def, req, ScanScope::PrimaryOnly);
    let entity_scope = read.entity_scope(req);
    let remainder_filter = if group_limit.include_remainder {
        ""
    } else {
        "WHERE group_rank > 0"
    };
    let sql = sql!(
        r"
        WITH scoped AS (
            SELECT
                *
                {raw_dimensions}
            FROM {observation_table}
            WHERE {metric_where}
              {filter_where}{entity_scope}
        ),
        ranked AS (
            SELECT
                *,
                {rank_expr} AS group_rank
            FROM scoped
        ),
        filtered AS (
            SELECT *
            FROM ranked
            {remainder_filter}
        ),
        aggregated AS (
            SELECT
                group_rank,
                {value_expr} AS value,
                uniqExact(entity_id) AS contributing_entity_count
            FROM filtered
            GROUP BY group_rank
        )
        SELECT
            group_rank{dimension_select},
            {value} AS value,
            contributing_entity_count,
            if(group_rank = 0, CAST(NULL AS Nullable(UInt32)), toNullable(group_rank)) AS rank,
            toUInt8(group_rank = 0) AS remainder,
            if(group_rank = 0, toNullable('Other'), CAST(NULL AS Nullable(String))) AS group_label
        FROM aggregated
        ORDER BY group_rank = 0, group_rank
        LIMIT {limit}
        ",
        raw_dimensions = Sql::raw(raw_dimension_selects(dimensions)),
        observation_table = read.from,
        metric_where = metric_where(def, req, ScanScope::PrimaryOnly),
        filter_where = dimension_filter_where(filters),
        entity_scope = entity_scope,
        rank_expr = capped_rank_expr(group_limit, dimensions.len()),
        remainder_filter = Sql::raw(remainder_filter),
        value_expr = grouped_value_expr(def, None),
        dimension_select = capped_dimension_select(group_limit, dimensions),
        value = Sql::raw(transformed(def, "value".to_owned())),
        limit = row_limit(),
    );
    CompiledQuery { sql }
}

fn grouped_value_expr(def: &MetricDefinition, window: Option<DateWindow>) -> Sql {
    match &def.spec {
        ComputationSpec::Sum { .. } => {
            sql!(
                "sumIf(value, value IS NOT NULL{window})",
                window = window_term(window)
            )
        }
        ComputationSpec::Ratio {
            numerator,
            denominator,
            scale,
            denominator_aggregation,
        } => {
            let denominator_key = Param::string(denominator.measure_key.clone());
            let denominator = ratio_denominator_expr(
                *denominator_aggregation,
                sql!(
                    "measure_key = {denominator_key} AND value IS NOT NULL{window}",
                    denominator_key = denominator_key.clone(),
                    window = window_term(window),
                ),
                sql!(
                    "measure_key = {denominator_key} AND subject_key IS NOT NULL{window}",
                    denominator_key = denominator_key,
                    window = window_term(window),
                ),
            );
            sql!(
                "{scale} * sumIfOrNull(value, measure_key = {numerator_key} AND value IS NOT NULL{window}) / nullIf({denominator}, 0)",
                scale = Sql::raw(scale.to_string()),
                numerator_key = Param::string(numerator.measure_key.clone()),
                window = window_term(window),
                denominator = denominator,
            )
        }
        ComputationSpec::Median { .. } => {
            sql!(
                "{MEDIAN_AGGREGATE}(0.5)(value, value IS NOT NULL{window})",
                window = window_term(window)
            )
        }
        ComputationSpec::Percentile { q, .. } => {
            sql!(
                "quantileExactIf({q})(value, value IS NOT NULL{window})",
                q = Sql::raw(q.to_string()),
                window = window_term(window),
            )
        }
        ComputationSpec::Stddev { .. } => {
            sql!(
                "stddevSampIf(value, value IS NOT NULL{window})",
                window = window_term(window)
            )
        }
        ComputationSpec::DistinctCount { .. } => {
            sql!(
                "toFloat64(uniqExactIf(subject_key, subject_key IS NOT NULL{window}))",
                window = window_term(window)
            )
        }
    }
}

pub(crate) fn compile_unattributed_query(
    def: &MetricDefinition,
    req: &ValidatedMetricResultsRequest,
    filters: &[ValidatedDimensionFilter],
) -> CompiledQuery {
    let read = resolved_observation_from(
        def.observation_source(),
        &PersonScope::Unattributed(req),
        &[],
        ScanScope::PrimaryOnly,
    );
    let inner = sql!(
        r"
        SELECT
            {value_expr} AS value
        FROM {observation_table}
        WHERE {metric_where}
          {filter_where}
        ",
        value_expr = grouped_value_expr(def, None),
        observation_table = read.from,
        metric_where = metric_where(def, req, ScanScope::PrimaryOnly),
        filter_where = dimension_filter_where(filters),
    );
    let sql = transformed_single(def, inner);
    CompiledQuery { sql }
}

pub(crate) fn compile_histogram_query(
    def: &MetricDefinition,
    req: &ValidatedMetricResultsRequest,
    filters: &[ValidatedDimensionFilter],
) -> CompiledQuery {
    let read = single_resolved_observation_from(def, req, ScanScope::PrimaryOnly);
    let entity_scope = read.entity_scope(req);
    let bins = HISTOGRAM_BINS;
    let max_bin = HISTOGRAM_BINS - 1;
    let sql = sql!(
        r"
        WITH raw_events AS (
            SELECT
                entity_id,
                assumeNotNull({event_value}) AS event_value
            FROM {observation_table}
            WHERE {metric_where}
              {filter_where}{entity_scope}
              AND value IS NOT NULL
        ),
        events AS (
            SELECT
                entity_id,
                event_value,
                min(event_value) OVER (PARTITION BY entity_id) AS entity_lo,
                max(event_value) OVER (PARTITION BY entity_id) AS entity_hi
            FROM raw_events
        )
        SELECT
            toString(assumeNotNull(events.entity_id)) AS entity_id,
            if(
                events.entity_hi = events.entity_lo,
                0,
                toUInt32(least({max_bin}, toInt64(floor(
                    (events.event_value - events.entity_lo) * {bins} / (events.entity_hi - events.entity_lo)
                ))))
            ) AS bin_idx,
            any(events.entity_lo) AS entity_lo,
            any(events.entity_hi) AS entity_hi,
            toUInt64(count()) AS bin_count
        FROM events
        GROUP BY entity_id, bin_idx
        ORDER BY entity_id, bin_idx
        LIMIT {limit}
        ",
        event_value = Sql::raw(transformed(def, "value".to_owned())),
        observation_table = read.from,
        metric_where = metric_where(def, req, ScanScope::PrimaryOnly),
        filter_where = dimension_filter_where(filters),
        entity_scope = entity_scope,
        max_bin = Sql::raw(max_bin.to_string()),
        bins = Sql::raw(bins.to_string()),
        limit = row_limit(),
    );
    CompiledQuery { sql }
}

pub(crate) fn compile_pooled_histogram_query(
    def: &MetricDefinition,
    req: &ValidatedMetricResultsRequest,
    dimensions: &[String],
    filters: &[ValidatedDimensionFilter],
) -> CompiledQuery {
    let read = single_resolved_observation_from(def, req, ScanScope::PrimaryOnly);
    let entity_scope = read.entity_scope(req);
    let (dim_select, dim_group) = dimension_select_group(dimensions);
    let bins = HISTOGRAM_BINS;
    let max_bin = HISTOGRAM_BINS - 1;
    let sql = sql!(
        r"
        WITH raw_events AS (
            SELECT
                assumeNotNull({event_value}) AS event_value{dim_select}
            FROM {observation_table}
            WHERE {metric_where}
              {filter_where}{entity_scope}
              AND value IS NOT NULL
        ),
        events AS (
            SELECT
                *,
                min(event_value) OVER (PARTITION BY {dim_group}) AS group_lo,
                max(event_value) OVER (PARTITION BY {dim_group}) AS group_hi
            FROM raw_events
        )
        SELECT
            {dim_group},
            if(
                events.group_hi = events.group_lo,
                0,
                toUInt32(least({max_bin}, toInt64(floor(
                    (events.event_value - events.group_lo) * {bins} / (events.group_hi - events.group_lo)
                ))))
            ) AS bin_idx,
            any(events.group_lo) AS group_lo,
            any(events.group_hi) AS group_hi,
            toUInt64(count()) AS bin_count
        FROM events
        GROUP BY {dim_group}, bin_idx
        ORDER BY {dim_group}, bin_idx
        LIMIT {limit}
        ",
        event_value = Sql::raw(transformed(def, "value".to_owned())),
        dim_select = Sql::raw(dim_select),
        observation_table = read.from,
        metric_where = metric_where(def, req, ScanScope::PrimaryOnly),
        filter_where = dimension_filter_where(filters),
        entity_scope = entity_scope,
        dim_group = Sql::raw(dim_group),
        max_bin = Sql::raw(max_bin.to_string()),
        bins = Sql::raw(bins.to_string()),
        limit = row_limit(),
    );
    CompiledQuery { sql }
}

// WORKAROUND: ClickHouse inlines a WITH body once per reference, so a second
// reference to entity_values re-scans the whole observation window. Both
// shapes reference it exactly once and extract the target's own value from
// the peer rows with a conditional aggregate.
pub(crate) fn compile_peer_batch_query(
    defs: &[&MetricDefinition],
    req: &ValidatedMetricResultsRequest,
    cohort_key: &str,
    peer_population: PeerPopulation,
    filters: &[ValidatedDimensionFilter],
) -> CompiledQuery {
    match peer_population {
        PeerPopulation::DeclaredCohort => {
            compile_declared_cohort_peer_batch_query(defs, req, cohort_key, filters)
        }
        PeerPopulation::Tenant => compile_tenant_peer_batch_query(defs, req, filters),
    }
}

fn compile_declared_cohort_peer_batch_query(
    defs: &[&MetricDefinition],
    req: &ValidatedMetricResultsRequest,
    cohort_key: &str,
    filters: &[ValidatedDimensionFilter],
) -> CompiledQuery {
    let collapses = batch_alias_collapses(defs);
    let observation_table = resolved_observation_from(
        batch_observation_source(defs),
        &PersonScope::CohortMembers(req),
        &collapses,
        ScanScope::PrimaryOnly,
    )
    .from;
    let cohort_scope = sql!(
        "{tenant} AND entity_type = {entity_type}
              AND cohort_key = {cohort_key}",
        tenant = tenant_predicate(req.tenant_id, req.enforce_tenant_scope),
        entity_type = entity_type_param(req),
        cohort_key = Param::string(cohort_key),
    );
    let sql = sql!(
        r"
        WITH
        targets AS (
            SELECT entity_id, cohort_id
            FROM {cohort_table}
            WHERE {cohort_scope}
              AND entity_id IN {entity_ids}
        ),
        cohort AS (
            SELECT entity_id, cohort_id
            FROM {cohort_table}
            WHERE {cohort_scope}
              AND cohort_id IN (SELECT cohort_id FROM targets)
        ),
        metric_values AS (
            SELECT
                entity_id{value_selects}
            FROM {observation_table}
            WHERE {metric_scope}
            GROUP BY entity_id
        ),
        entity_values AS (
            SELECT
                cohort.entity_id AS entity_id,
                cohort.cohort_id AS cohort_id{carried}
            FROM cohort
            LEFT JOIN metric_values
                ON metric_values.entity_id = cohort.entity_id
        )
        SELECT
            targets.entity_id AS entity_id{stats_selects}
        FROM targets
        LEFT JOIN entity_values AS peer
            ON peer.cohort_id = targets.cohort_id
        GROUP BY targets.entity_id
        LIMIT {limit}
        SETTINGS join_use_nulls = 1
        ",
        cohort_table = Sql::raw(cohort_table(CohortSource::MetricEntityCohortsCurrent)),
        cohort_scope = cohort_scope,
        entity_ids = entity_ids_param(req),
        value_selects = item_value_selects(defs, period_alias, None),
        observation_table = observation_table,
        metric_scope = shared_observation_where_within(defs, req, filters, ScanScope::PrimaryOnly),
        carried = Sql::raw(peer_carried_selects(defs)),
        stats_selects = Sql::raw(per_target_aggregate_selects(defs)),
        limit = row_limit(),
    );
    CompiledQuery { sql }
}

fn compile_tenant_peer_batch_query(
    defs: &[&MetricDefinition],
    req: &ValidatedMetricResultsRequest,
    filters: &[ValidatedDimensionFilter],
) -> CompiledQuery {
    let collapses = batch_alias_collapses(defs);
    let observation_table = resolved_observation_from(
        batch_observation_source(defs),
        &PersonScope::TenantWide(req),
        &collapses,
        ScanScope::PrimaryOnly,
    )
    .from;
    let sql = sql!(
        r"
        WITH
        targets AS (
            SELECT arrayJoin({entity_ids}) AS entity_id
        ),
        metric_values AS (
            SELECT
                entity_id{value_selects}
            FROM {observation_table}
            WHERE {metric_scope}
            GROUP BY entity_id
        ),
        entity_values AS (
            SELECT
                entity_id{carried}
            FROM metric_values
        ),
        population_stats AS (
            SELECT
                groupArrayIf({captured_tuple}, peer.entity_id IN (SELECT entity_id FROM targets)) AS target_rows{population_stat_selects}
            FROM entity_values AS peer
        )
        SELECT
            targets.entity_id AS entity_id{result_selects}
        FROM targets
        CROSS JOIN population_stats
        LIMIT {limit}
        SETTINGS join_use_nulls = 1
        ",
        entity_ids = entity_ids_param(req),
        value_selects = item_value_selects(defs, period_alias, None),
        observation_table = observation_table,
        metric_scope = shared_observation_where_within(defs, req, filters, ScanScope::PrimaryOnly),
        carried = Sql::raw(peer_carried_selects(defs)),
        captured_tuple = Sql::raw(captured_target_tuple(defs)),
        population_stat_selects = Sql::raw(population_stat_selects(defs)),
        result_selects = Sql::raw(tenant_result_selects(defs)),
        limit = row_limit(),
    );
    CompiledQuery { sql }
}

fn per_target_aggregate_selects(defs: &[&MetricDefinition]) -> String {
    let mut stats_selects = String::new();
    for item_index in 0..defs.len() {
        let value = period_alias(item_index);
        let aliases = peer_aliases(item_index);
        let _ = write!(
            stats_selects,
            ",
            maxIf(peer.{value}, peer.entity_id = targets.entity_id) AS {target}",
            target = aliases.target,
        );
        push_peer_stat_selects(&mut stats_selects, item_index);
    }
    stats_selects
}

fn peer_carried_selects(defs: &[&MetricDefinition]) -> String {
    let mut carried = String::new();
    for (item_index, def) in defs.iter().enumerate() {
        let value = period_alias(item_index);
        let carried_value = transformed(def, format!("metric_values.{value}"));
        let _ = write!(
            carried,
            ",
                {carried_value} AS {value}"
        );
    }
    carried
}

fn captured_target_tuple(defs: &[&MetricDefinition]) -> String {
    let mut tuple = "tuple(peer.entity_id".to_owned();
    for item_index in 0..defs.len() {
        let value = period_alias(item_index);
        let _ = write!(tuple, ", peer.{value}");
    }
    tuple.push(')');
    tuple
}

fn population_stat_selects(defs: &[&MetricDefinition]) -> String {
    let mut selects = String::new();
    for item_index in 0..defs.len() {
        push_peer_stat_selects(&mut selects, item_index);
    }
    selects
}

fn tenant_result_selects(defs: &[&MetricDefinition]) -> String {
    let mut result_selects = String::new();
    for item_index in 0..defs.len() {
        let aliases = peer_aliases(item_index);
        // SAFETY: arrayFirst yields the default tuple when the target was not
        // captured; its Nullable elements read NULL, so an unmeasured target
        // stays NULL. Element 1 is the entity id, values start at 2.
        let _ = write!(
            result_selects,
            ",
            tupleElement(arrayFirst(t -> t.1 = targets.entity_id, population_stats.target_rows), {position}) AS {target},
            population_stats.{p25} AS {p25},
            population_stats.{median} AS {median},
            population_stats.{p75} AS {p75},
            population_stats.{min} AS {min},
            population_stats.{max} AS {max},
            population_stats.{n} AS {n}",
            position = item_index + 2,
            target = aliases.target,
            p25 = aliases.p25,
            median = aliases.median,
            p75 = aliases.p75,
            min = aliases.min,
            max = aliases.max,
            n = aliases.n,
        );
    }
    result_selects
}

fn push_peer_stat_selects(selects: &mut String, item_index: usize) {
    let value = period_alias(item_index);
    let aliases = peer_aliases(item_index);
    let observed = format!("peer.{value} IS NOT NULL");
    let pool = format!("uniqExactIf(peer.entity_id, {observed})");
    let quantiles = format!("quantilesExactIf(0.25, 0.75)(peer.{value}, {observed})");
    let median_expr = format!("{MEDIAN_AGGREGATE}(0.5)(peer.{value}, {observed})");
    let _ = write!(
        selects,
        ",
            if({pool} >= {min_peer_n}, toNullable({quantiles}[1]), NULL) AS {p25},
            if({pool} >= {min_peer_n}, toNullable({median_expr}), NULL) AS {median},
            if({pool} >= {min_peer_n}, toNullable({quantiles}[2]), NULL) AS {p75},
            if({pool} >= {min_peer_n}, minIfOrNull(peer.{value}, {observed}), NULL) AS {min},
            if({pool} >= {min_peer_n}, maxIfOrNull(peer.{value}, {observed}), NULL) AS {max},
            toUInt64({pool}) AS {n}",
        p25 = aliases.p25,
        median = aliases.median,
        p75 = aliases.p75,
        min = aliases.min,
        max = aliases.max,
        n = aliases.n,
        min_peer_n = MIN_PEER_N,
    );
}

fn item_value_selects(
    defs: &[&MetricDefinition],
    alias: impl Fn(usize) -> String,
    window: Option<DateWindow>,
) -> Sql {
    let mut selects = Sql::default();
    for (item_index, def) in defs.iter().enumerate() {
        selects.push(sql!(
            ",
                {expr} AS {alias}",
            expr = item_value_expr(def, window),
            alias = Sql::raw(alias(item_index)),
        ));
    }
    selects
}

fn input_scope(input: &MetricInput) -> Sql {
    sql!(
        "source_key = {source_key} AND measure_key = {measure_key}",
        source_key = Param::string(input.source_key.clone()),
        measure_key = Param::string(input.measure_key.clone()),
    )
}

// sumIfOrNull, not sumIf: a plain sumIf yields 0 when the item matches no
// rows of an entity that has rows for other items, fabricating an
// observation the peer pool must not see. OrNull pins NULL-on-no-match.
fn item_value_expr(def: &MetricDefinition, window: Option<DateWindow>) -> Sql {
    match &def.spec {
        ComputationSpec::Sum { value } => sql!(
            "sumIfOrNull(value, {scope} AND value IS NOT NULL{window})",
            scope = input_scope(value),
            window = window_term(window),
        ),
        ComputationSpec::Ratio {
            numerator,
            denominator,
            scale,
            denominator_aggregation,
        } => {
            let denominator_scope = sql!(
                "source_key = {source_key} AND measure_key = {measure_key}",
                source_key = Param::string(numerator.source_key.clone()),
                measure_key = Param::string(denominator.measure_key.clone()),
            );
            let denominator = ratio_denominator_expr(
                *denominator_aggregation,
                sql!(
                    "{scope} AND value IS NOT NULL{window}",
                    scope = denominator_scope.clone(),
                    window = window_term(window),
                ),
                sql!(
                    "{scope} AND subject_key IS NOT NULL{window}",
                    scope = denominator_scope,
                    window = window_term(window),
                ),
            );
            sql!(
                "{scale} * sumIfOrNull(value, {scope} AND value IS NOT NULL{window}) / nullIf({denominator}, 0)",
                scale = Sql::raw(scale.to_string()),
                scope = input_scope(numerator),
                window = window_term(window),
                denominator = denominator,
            )
        }
        ComputationSpec::Median { value } => sql!(
            "{MEDIAN_AGGREGATE_OR_NULL}(0.5)(value, {scope} AND value IS NOT NULL{window})",
            scope = input_scope(value),
            window = window_term(window),
        ),
        ComputationSpec::Percentile { value, q } => sql!(
            "quantileExactIfOrNull({q})(value, {scope} AND value IS NOT NULL{window})",
            q = Sql::raw(q.to_string()),
            scope = input_scope(value),
            window = window_term(window),
        ),
        ComputationSpec::Stddev { value } => sql!(
            "stddevSampIfOrNull(value, {scope} AND value IS NOT NULL{window})",
            scope = input_scope(value),
            window = window_term(window),
        ),
        // toFloat64 so the wide column is Float64, not a JSON-quoted
        // UInt64 (uniqExact's native type) the f64 row decoder rejects.
        // OrNull is preserved through the cast (NULL stays NULL).
        ComputationSpec::DistinctCount { value } => sql!(
            "toFloat64(uniqExactIfOrNull(subject_key, {scope} AND subject_key IS NOT NULL{window}))",
            scope = input_scope(value),
            window = window_term(window),
        ),
    }
}

const OBS: &str = "obs_src";

fn ratio_denominator_expr_over(
    aggregation: RatioDenominatorAggregation,
    sum_column: &str,
    distinct_column: &str,
    sum_condition: Sql,
    distinct_condition: Sql,
) -> Sql {
    match aggregation {
        RatioDenominatorAggregation::Sum => sql!(
            "sumIf({column}, {condition})",
            column = Sql::raw(sum_column),
            condition = sum_condition,
        ),
        RatioDenominatorAggregation::DistinctCount => sql!(
            "uniqExactIf({column}, {condition})",
            column = Sql::raw(distinct_column),
            condition = distinct_condition,
        ),
    }
}

fn ratio_denominator_expr(
    aggregation: RatioDenominatorAggregation,
    sum_condition: Sql,
    distinct_condition: Sql,
) -> Sql {
    ratio_denominator_expr_over(
        aggregation,
        "value",
        "(entity_id, subject_key)",
        sum_condition,
        distinct_condition,
    )
}

fn transformed(def: &MetricDefinition, expr: String) -> String {
    match &def.transform {
        Some(transform) => transform.wrap_sql(&expr),
        None => expr,
    }
}

fn transformed_single(def: &MetricDefinition, inner: Sql) -> Sql {
    if def.transform.is_none() {
        return inner;
    }
    sql!(
        r"
        SELECT
            * EXCEPT (value),
            {value} AS value
        FROM ({inner})
        ",
        value = Sql::raw(transformed(def, "value".to_owned())),
        inner = inner,
    )
}

fn transformed_batch(defs: &[&MetricDefinition], inner: Sql, compared: bool) -> Sql {
    if defs.iter().all(|def| def.transform.is_none()) {
        return inner;
    }
    let mut selects = String::new();
    for (item_index, def) in defs.iter().enumerate() {
        for value in [
            Some(period_alias(item_index)),
            compared.then(|| period_compare_alias(item_index)),
        ]
        .into_iter()
        .flatten()
        {
            let expr = transformed(def, value.clone());
            let _ = write!(selects, ", {expr} AS {value}");
        }
    }
    sql!(
        r"
        SELECT
            entity_id{selects}
        FROM ({inner})
        ",
        selects = Sql::raw(selects),
        inner = inner,
    )
}

fn shared_observation_where_within(
    defs: &[&MetricDefinition],
    req: &ValidatedMetricResultsRequest,
    filters: &[ValidatedDimensionFilter],
    scope: ScanScope,
) -> Sql {
    let pairs = measure_pairs(defs)
        .into_iter()
        .map(|(source_key, measure_key)| {
            sql!(
                "({source_key}, {measure_key})",
                source_key = Param::string(source_key),
                measure_key = Param::string(measure_key),
            )
        });
    sql!(
        "{tenant} AND entity_type = {entity_type} AND {scan} AND (source_key, measure_key) IN ({pairs}){filter_where}",
        tenant = tenant_predicate(req.tenant_id, req.enforce_tenant_scope),
        entity_type = entity_type_param(req),
        scan = scan_window_predicate(req, "metric_date", " ", scope),
        pairs = Sql::join(pairs, ", "),
        filter_where = dimension_filter_where(filters),
    )
}

fn dimension_filter_where(filters: &[ValidatedDimensionFilter]) -> Sql {
    let terms = filters.iter().map(|filter| {
        sql!(
            " AND indexOf(dimensions.1, '{dimension}') > 0 AND dimensions.2[indexOf(dimensions.1, '{dimension}')] IN {filter_values}",
            dimension = Sql::raw(filter.dimension.clone()),
            filter_values = Param::strings(filter.values.iter().cloned()),
        )
    });
    Sql::join(terms, "")
}

fn measure_pairs(defs: &[&MetricDefinition]) -> BTreeSet<(String, String)> {
    defs.iter()
        .flat_map(|def| match &def.spec {
            ComputationSpec::Sum { value }
            | ComputationSpec::Median { value }
            | ComputationSpec::Percentile { value, .. }
            | ComputationSpec::Stddev { value }
            | ComputationSpec::DistinctCount { value } => {
                vec![(value.source_key.clone(), value.measure_key.clone())]
            }
            ComputationSpec::Ratio {
                numerator,
                denominator,
                ..
            } => vec![
                (numerator.source_key.clone(), numerator.measure_key.clone()),
                (
                    numerator.source_key.clone(),
                    denominator.measure_key.clone(),
                ),
            ],
        })
        .collect()
}

fn batch_observation_source<'a>(defs: &'a [&MetricDefinition]) -> &'a ObservationSource {
    defs.first()
        .unwrap_or_else(|| unreachable!("batches are planned from at least one metric view"))
        .observation_source()
}

fn batch_resolved_observation_from(
    defs: &[&MetricDefinition],
    req: &ValidatedMetricResultsRequest,
    scope: ScanScope,
) -> ObservationRead {
    let def = defs
        .first()
        .unwrap_or_else(|| unreachable!("batches are planned from at least one metric view"));
    let collapses = batch_alias_collapses(defs);
    resolved_observation_from(
        def.observation_source(),
        &PersonScope::Requested(req),
        &collapses,
        scope,
    )
}

fn single_resolved_observation_from(
    def: &MetricDefinition,
    req: &ValidatedMetricResultsRequest,
    scope: ScanScope,
) -> ObservationRead {
    let defs = [def];
    let collapses = batch_alias_collapses(&defs);
    resolved_observation_from(
        def.observation_source(),
        &PersonScope::Requested(req),
        &collapses,
        scope,
    )
}

// SAFETY: tenancy shortcut (#1829, #1967): unenforced, the predicate matches every tenant's rows.
pub(crate) fn tenant_predicate(tenant_id: Uuid, enforce: bool) -> Sql {
    let tenant = Param::string(tenant_id.to_string());
    if enforce {
        sql!("tenant_id = {tenant}", tenant = tenant)
    } else {
        sql!("(tenant_id = {tenant} OR 1 = 1)", tenant = tenant)
    }
}

fn entity_type_param(req: &ValidatedMetricResultsRequest) -> Param {
    Param::string(req.entity.entity_type())
}

fn entity_ids_param(req: &ValidatedMetricResultsRequest) -> Param {
    Param::strings(req.entity.entity_ids())
}

fn row_limit() -> Sql {
    Sql::raw(query_row_limit().to_string())
}

fn metric_where(
    def: &MetricDefinition,
    req: &ValidatedMetricResultsRequest,
    scope: ScanScope,
) -> Sql {
    let (source_key, measure_predicate) = match &def.spec {
        ComputationSpec::Sum { value }
        | ComputationSpec::Median { value }
        | ComputationSpec::Percentile { value, .. }
        | ComputationSpec::Stddev { value }
        | ComputationSpec::DistinctCount { value } => (
            &value.source_key,
            sql!(
                "measure_key = {measure_key}",
                measure_key = Param::string(value.measure_key.clone()),
            ),
        ),
        ComputationSpec::Ratio {
            numerator,
            denominator,
            ..
        } => (
            &numerator.source_key,
            sql!(
                "measure_key IN ({numerator_key}, {denominator_key})",
                numerator_key = Param::string(numerator.measure_key.clone()),
                denominator_key = Param::string(denominator.measure_key.clone()),
            ),
        ),
    };
    sql!(
        "{tenant} AND source_key = {source_key} AND entity_type = {entity_type} AND {scan} AND {measure_predicate}",
        tenant = tenant_predicate(req.tenant_id, req.enforce_tenant_scope),
        source_key = Param::string(source_key.clone()),
        entity_type = entity_type_param(req),
        scan = scan_window_predicate(req, "metric_date", " ", scope),
        measure_predicate = measure_predicate,
    )
}

fn ratio_sides_expr(def: &MetricDefinition) -> Sql {
    let ComputationSpec::Ratio {
        numerator,
        denominator,
        denominator_aggregation,
        ..
    } = &def.spec
    else {
        return Sql::raw(
            ",\n            CAST(NULL AS Nullable(Float64)) AS numerator,\n            CAST(NULL AS Nullable(Float64)) AS denominator",
        );
    };
    let denominator_key = Param::string(denominator.measure_key.clone());
    let denominator_expr = ratio_denominator_expr_over(
        *denominator_aggregation,
        &format!("{OBS}.value"),
        &format!("({OBS}.entity_id, {OBS}.subject_key)"),
        sql!(
            "{OBS}.measure_key = {denominator_key} AND {OBS}.value IS NOT NULL",
            denominator_key = denominator_key.clone(),
        ),
        sql!(
            "{OBS}.measure_key = {denominator_key} AND {OBS}.subject_key IS NOT NULL",
            denominator_key = denominator_key,
        ),
    );
    // SAFETY: toFloat64 on the denominator. A distinct-count denominator is
    // `uniqExactIf`, whose UInt64 ClickHouse JSON-quotes — the f64 row decoder
    // rejects it. Inside `grouped_value_expr` the division hides that; as an
    // output column of its own it does not. Same wrap the drilldown carries.
    //
    // SAFETY: every column here is qualified with the source alias. The value
    // column of this SELECT is itself named `value`, and an alias outranks a
    // source column throughout the list — so a bare `value` inside these
    // aggregates resolves to the ratio expression and ClickHouse rejects the
    // whole query with ILLEGAL_AGGREGATION. The drilldown qualifies for the
    // same reason.
    sql!(
        ",\n            sumIfOrNull({OBS}.value, {OBS}.measure_key = {numerator_key} AND {OBS}.value IS NOT NULL) AS numerator,\n            toFloat64({denominator_expr}) AS denominator",
        numerator_key = Param::string(numerator.measure_key.clone()),
        denominator_expr = denominator_expr,
    )
}

// INVARIANT: the bucket key must be non-nullable — a custom source may
// declare `metric_date` as `Nullable(Date)`, and GROUPING SETS fills the
// totals row's absent key with NULL instead of the default date, which the
// row parser rejects. The date-range predicate has already dropped NULL
// dates, so `assumeNotNull` never sees one.
fn bucket_expr(bucket: QueryBucket) -> &'static str {
    match bucket {
        QueryBucket::Day => "assumeNotNull(metric_date)",
        QueryBucket::Week => "toStartOfWeek(assumeNotNull(metric_date), 1)",
        QueryBucket::Month => "toStartOfMonth(assumeNotNull(metric_date))",
        QueryBucket::Quarter => "toStartOfQuarter(assumeNotNull(metric_date))",
        QueryBucket::Year => "toStartOfYear(assumeNotNull(metric_date))",
    }
}

fn observation_table(source: &ObservationSource) -> String {
    source.render_from_clause()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntityResolution {
    QueryTime,
    Canonical,
}

impl EntityResolution {
    fn of(source: &ObservationSource, entity: &ValidatedEntitySelection) -> Self {
        match (source, entity) {
            (ObservationSource::Custom(_), _)
            | (ObservationSource::Managed(_), ValidatedEntitySelection::Tenant { .. }) => {
                Self::Canonical
            }
            (ObservationSource::Managed(_), ValidatedEntitySelection::Person { .. }) => {
                Self::QueryTime
            }
        }
    }
}

enum PersonScope<'a> {
    Requested(&'a ValidatedMetricResultsRequest),
    CohortMembers(&'a ValidatedMetricResultsRequest),
    TenantWide(&'a ValidatedMetricResultsRequest),
    Unattributed(&'a ValidatedMetricResultsRequest),
}

impl PersonScope<'_> {
    fn request(&self) -> &ValidatedMetricResultsRequest {
        match self {
            Self::Requested(req)
            | Self::CohortMembers(req)
            | Self::TenantWide(req)
            | Self::Unattributed(req) => req,
        }
    }
}

struct ObservationRead {
    from: Sql,
    resolution: EntityResolution,
}

impl ObservationRead {
    fn entity_scope(&self, req: &ValidatedMetricResultsRequest) -> Sql {
        match self.resolution {
            EntityResolution::QueryTime => Sql::default(),
            EntityResolution::Canonical => match &req.entity {
                ValidatedEntitySelection::Person { .. } => sql!(
                    "\n          AND entity_id IN {entity_ids}",
                    entity_ids = entity_ids_param(req),
                ),
                ValidatedEntitySelection::Tenant { .. } => {
                    Sql::raw("\n          AND entity_id = tenant_id")
                }
            },
        }
    }
}

pub(crate) fn account_source_uuid_expr(alias: &str) -> String {
    format!("toUUID(UUIDNumToString(sipHash128(coalesce({alias}.account_source_id, ''))))")
}

pub(crate) fn account_id_expr(alias: &str) -> String {
    format!("lower(trimBoth(coalesce({alias}.account_id, '')))")
}

fn resolved_observation_from(
    source: &ObservationSource,
    person_scope: &PersonScope<'_>,
    collapses: &[(&MetricInput, AliasCollapse)],
    scan: ScanScope,
) -> ObservationRead {
    let table = observation_table(source);
    let resolution = EntityResolution::of(source, &person_scope.request().entity);
    if resolution == EntityResolution::Canonical {
        return ObservationRead {
            from: Sql::raw(table),
            resolution,
        };
    }

    let scan_of = |req: &ValidatedMetricResultsRequest| {
        scan_window_predicate(req, "obs.metric_date", "\n          ", scan)
    };
    let (inner_where, resolved_filter) = match person_scope {
        PersonScope::Requested(req) => (
            sql!(
                "(obs.entity_id IN (SELECT email FROM {PERSON_MAP_RELATION} WHERE person_id IN {person_ids}) \
                  OR coalesce(obs.account_id, '') != '')\n          AND {date_scope}",
                person_ids =
                    Param::uuids(req.entity.person_ids().unwrap_or_default().iter().copied()),
                date_scope = scan_of(req),
            ),
            sql!(
                "resolved_person_id IN {entity_ids}",
                entity_ids = entity_ids_param(req),
            ),
        ),
        PersonScope::CohortMembers(req) => (
            sql!(
                "(obs.entity_id IN (SELECT email FROM {PERSON_MAP_RELATION} \
                  WHERE toString(person_id) IN (SELECT entity_id FROM cohort)) \
                  OR coalesce(obs.account_id, '') != '')\n          AND {date_scope}",
                date_scope = scan_of(req),
            ),
            Sql::raw("resolved_person_id IN (SELECT entity_id FROM cohort)"),
        ),
        PersonScope::TenantWide(req) => (scan_of(req), Sql::raw("resolved_person_id != ''")),
        PersonScope::Unattributed(req) => (
            scan_of(req),
            Sql::raw("resolved_person_id = '' AND NOT account_bound"),
        ),
    };

    // Null-proof under EITHER join_use_nulls setting (queries differ): each
    // match test is non-Nullable via coalesce on a String column, and the
    // joined person_id is read only on its matched branch.
    let resolved = sql!(
        r"(
        SELECT
            {RESOLVED_OBSERVATION_COLUMNS},
            resolved_person_id AS entity_id
        FROM (
            SELECT
                {qualified},
                multiIf(
                    coalesce(account_map.account_id, '') != '',
                    if(
                        assumeNotNull(account_map.person_id) = toUUID('{EXCLUDED_PERSON_ID}'),
                        '',
                        toString(assumeNotNull(account_map.person_id))
                    ),
                    coalesce(person_map.email, '') != '',
                    toString(assumeNotNull(person_map.person_id)),
                    ''
                ) AS resolved_person_id,
                coalesce(account_map.account_id, '') != '' AS account_bound
            FROM {table} AS obs
            LEFT JOIN {ACCOUNT_ASSIGNMENT_RELATION} AS account_map
                ON account_map.source_type = obs.account_source_type
               AND account_map.source_id = {account_source_uuid}
               AND account_map.account_id = {account_id}
            LEFT JOIN {PERSON_MAP_RELATION} AS person_map
                ON person_map.email = obs.entity_id
            WHERE {inner_where}
        ) AS resolved
        WHERE {resolved_filter}
        )",
        qualified = Sql::raw(qualified_resolved_columns("obs")),
        table = Sql::raw(table),
        account_source_uuid = Sql::raw(account_source_uuid_expr("obs")),
        account_id = Sql::raw(account_id_expr("obs")),
        inner_where = inner_where,
        resolved_filter = resolved_filter,
    );

    ObservationRead {
        from: collapsed_observation_from(resolved, collapses),
        resolution,
    }
}

fn qualified_resolved_columns(alias: &str) -> String {
    RESOLVED_OBSERVATION_COLUMNS
        .split(", ")
        .map(|column| format!("{alias}.{column}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn collapsed_observation_from(resolved: Sql, collapses: &[(&MetricInput, AliasCollapse)]) -> Sql {
    let flagged = collapses
        .iter()
        .filter(|(_, collapse)| collapse.needs_pre_collapse())
        .collect::<Vec<_>>();
    if flagged.is_empty() {
        return resolved;
    }

    let mut value_branches = Vec::with_capacity(flagged.len());
    let mut flagged_pairs = Vec::with_capacity(flagged.len());
    for (input, collapse) in &flagged {
        let pair = sql!(
            "({source_key}, {measure_key})",
            source_key = Param::string(input.source_key.clone()),
            measure_key = Param::string(input.measure_key.clone()),
        );
        value_branches.push(sql!(
            "(source_key, measure_key) = {pair}, {aggregate}(value), ",
            pair = pair.clone(),
            aggregate = Sql::raw(collapse.aggregate_fn()),
        ));
        flagged_pairs.push(pair);
    }
    let flagged_set = Sql::join(flagged_pairs, ", ");

    sql!(
        r"(
        WITH resolved_rows AS {resolved}
        SELECT
            {COLLAPSE_GROUP_BY},
            any(observed_at) AS observed_at,
            multiIf({value_branches}sum(value)) AS value
        FROM resolved_rows
        WHERE (source_key, measure_key) IN ({flagged_set})
        GROUP BY {COLLAPSE_GROUP_BY}
        UNION ALL
        SELECT
            {COLLAPSE_GROUP_BY},
            observed_at,
            value
        FROM resolved_rows
        WHERE (source_key, measure_key) NOT IN ({flagged_set})
        )",
        resolved = resolved,
        value_branches = Sql::join(value_branches, ""),
        flagged_set = flagged_set,
    )
}

const COLLAPSE_GROUP_BY: &str = "tenant_id, entity_type, source_key, measure_key, metric_date, entity_id, \
                    dimensions, subject_key";

/// SAFETY: backslash first — it escapes in ClickHouse literals, so handling
/// quotes alone would let `x\\` swallow the closing quote.
pub(crate) fn sql_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}

fn batch_alias_collapses<'a>(
    defs: &'a [&MetricDefinition],
) -> Vec<(&'a MetricInput, AliasCollapse)> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for def in defs {
        for input in def.spec.inputs() {
            if seen.insert((input.source_key.as_str(), input.measure_key.as_str())) {
                out.push((input, input.alias_collapse));
            }
        }
    }
    out
}

fn cohort_table(source: CohortSource) -> &'static str {
    match source {
        CohortSource::MetricEntityCohortsCurrent => "insight.metric_entity_cohorts_current",
    }
}

pub(crate) fn dimension_aliases(idx: usize) -> (String, String) {
    (format!("dim_{idx}_value"), format!("dim_{idx}_label"))
}

fn dimension_select_group(dimensions: &[String]) -> (String, String) {
    let mut select = String::new();
    let mut groups = Vec::with_capacity(dimensions.len() * 2);
    for (idx, dimension) in dimensions.iter().enumerate() {
        let (value_alias, label_alias) = dimension_aliases(idx);
        let _ = write!(
            select,
            ", {value} AS {value_alias}, {label} AS {label_alias}",
            value = dimension_value_expr(dimension),
            label = dimension_label_expr(dimension)
        );
        groups.push(value_alias);
        groups.push(label_alias);
    }
    (select, groups.join(", "))
}

fn hidden_source_context(dimensions: &[String]) -> (String, String) {
    if !dimensions.iter().any(|dimension| dimension == "repository") {
        return (String::new(), String::new());
    }
    let provider = dimension_value_expr("source");
    let source_id = dimension_value_expr("source_id");
    (
        format!(", {provider} AS link_source_provider, {source_id} AS link_source_id"),
        ", link_source_provider, link_source_id".to_owned(),
    )
}

fn ranking_dimension_select_group(dimensions: &[String]) -> (String, String, String) {
    let mut select = Vec::with_capacity(dimensions.len() * 2);
    let mut group = Vec::with_capacity(dimensions.len());
    let mut order = Vec::with_capacity(dimensions.len());
    for (index, dimension) in dimensions.iter().enumerate() {
        let (value_alias, label_alias) = dimension_aliases(index);
        let value = dimension_value_expr(dimension);
        let label = dimension_label_expr(dimension);
        select.push(format!("{value} AS {value_alias}"));
        select.push(format!(
            "argMax({label}, tuple(metric_date, {label})) AS {label_alias}"
        ));
        group.push(value_alias.clone());
        order.push(value_alias);
    }
    (select.join(", "), group.join(", "), order.join(", "))
}

fn dimension_value_expr(dimension: &str) -> String {
    format!(
        r"
        if(
            indexOf(dimensions.1, '{dimension}') = 0,
            '{UNKNOWN_DIMENSION_VALUE}',
            coalesce(dimensions.2[indexOf(dimensions.1, '{dimension}')], '{UNKNOWN_DIMENSION_VALUE}')
        )
        "
    )
}

fn dimension_label_expr(dimension: &str) -> String {
    format!(
        r"
        if(
            indexOf(dimensions.1, '{dimension}') = 0,
            '{UNKNOWN_DIMENSION_LABEL}',
            coalesce(dimensions.3[indexOf(dimensions.1, '{dimension}')], '{UNKNOWN_DIMENSION_LABEL}')
        )
        "
    )
}

fn optional_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    match value {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::Number(number)) => number
            .as_u64()
            .ok_or_else(|| serde::de::Error::custom("expected unsigned integer"))
            .map(Some),
        Some(serde_json::Value::String(value)) => value
            .parse::<u64>()
            .map(Some)
            .map_err(serde::de::Error::custom),
        Some(_) => Err(serde::de::Error::custom("expected unsigned integer")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use insight_clickhouse::sql::Rendered;
    use uuid::Uuid;

    use crate::domain::metric_definitions::definition::ValueTransform;
    use crate::domain::metric_results::batch::{RankedDimension, RankedGroup};
    use crate::domain::metric_results::validation::ValidatedEntitySelection;
    use chrono::NaiveDate;

    use crate::domain::metric_definitions::definition::{
        AliasCollapse, CustomObservationSql, MetricBase, MetricDirection, MetricFormat,
        MetricInput, MetricInputRole, ObservationRelation, ObservationSource,
    };

    fn base(dimensions: Vec<&str>) -> MetricBase {
        MetricBase {
            key: "ai.accepted_lines".to_owned(),
            label: "AI-added lines".to_owned(),
            short_label: None,
            description: None,
            explanation: None,
            entity_type: "person".to_owned(),
            format: MetricFormat::Integer,
            unit: None,
            direction: MetricDirection::HigherIsBetter,
            peer_cohort_key: Some("org_unit".to_owned()),
            allowed_dimensions: dimensions.into_iter().map(str::to_owned).collect(),
        }
    }

    fn input(role: MetricInputRole, measure_key: &str) -> MetricInput {
        MetricInput {
            role,
            observation: ObservationSource::Managed(
                ObservationRelation::parse("ai_metric_observations")
                    .unwrap_or_else(|| panic!("fixture relation must parse")),
            ),
            source_key: "ai_usage".to_owned(),
            measure_key: measure_key.to_owned(),
            alias_collapse: AliasCollapse::Sum,
        }
    }

    fn median_metric() -> MetricDefinition {
        MetricDefinition {
            transform: None,
            base: base(vec!["source"]),
            spec: ComputationSpec::Median {
                value: input(MetricInputRole::Value, "pr_cycle_hours"),
            },
        }
    }

    fn distinct_count_metric() -> MetricDefinition {
        MetricDefinition {
            transform: None,
            base: base(vec!["tool"]),
            spec: ComputationSpec::DistinctCount {
                value: input(MetricInputRole::Value, "active_day"),
            },
        }
    }

    fn percentile_metric() -> MetricDefinition {
        MetricDefinition {
            transform: None,
            base: base(vec!["source"]),
            spec: ComputationSpec::Percentile {
                value: input(MetricInputRole::Value, "pr_cycle_hours"),
                q: 0.75,
            },
        }
    }

    fn sum_metric() -> MetricDefinition {
        MetricDefinition {
            transform: None,
            base: base(vec!["tool"]),
            spec: ComputationSpec::Sum {
                value: input(MetricInputRole::Value, "accepted_lines"),
            },
        }
    }

    fn ratio_metric() -> MetricDefinition {
        MetricDefinition {
            transform: None,
            base: base(vec!["tool"]),
            spec: ComputationSpec::Ratio {
                numerator: input(MetricInputRole::Numerator, "accepted_edit_actions"),
                denominator: input(MetricInputRole::Denominator, "tool_use_offered"),
                scale: 100.0,
                denominator_aggregation: RatioDenominatorAggregation::Sum,
            },
        }
    }

    fn sql_of(query: &CompiledQuery) -> String {
        query.sql.render().sql
    }

    fn named(name: &str, param: Param) -> (String, Param) {
        (name.to_owned(), param)
    }

    fn date(raw: &str) -> NaiveDate {
        NaiveDate::parse_from_str(raw, "%Y-%m-%d")
            .unwrap_or_else(|error| panic!("fixture date must parse: {error}"))
    }

    #[test]
    fn ratio_can_count_distinct_denominator_subjects() {
        let mut metric = ratio_metric();
        let ComputationSpec::Ratio {
            denominator_aggregation,
            ..
        } = &mut metric.spec
        else {
            panic!("fixture must be ratio");
        };
        *denominator_aggregation = RatioDenominatorAggregation::DistinctCount;

        let rendered =
            compile_timeseries_query(&metric, &request(), QueryBucket::Week, &[], &[], None)
                .sql
                .render();

        assert!(rendered.sql.contains(
            "uniqExactIf((entity_id, subject_key), measure_key = {denominator_key:String} AND subject_key IS NOT NULL)"
        ));
        assert!(rendered.params.contains(&named(
            "numerator_key",
            Param::string("accepted_edit_actions")
        )));
        assert!(
            rendered
                .params
                .contains(&named("denominator_key", Param::string("tool_use_offered")))
        );
    }

    const TEST_TENANT: uuid::Uuid = uuid::Uuid::from_u128(0x1967);
    const TEST_TENANT_STR: &str = "00000000-0000-0000-0000-000000001967";
    const PERSON_A: Uuid = Uuid::from_u128(0xa);
    const PERSON_B: Uuid = Uuid::from_u128(0xb);

    fn tenant_binds(rendered: &Rendered) -> usize {
        rendered
            .params
            .iter()
            .filter(|(_, param)| *param == Param::string(TEST_TENANT_STR))
            .count()
    }

    fn request() -> ValidatedMetricResultsRequest {
        ValidatedMetricResultsRequest {
            tenant_id: TEST_TENANT,
            entity: ValidatedEntitySelection::Person {
                ids: vec![PERSON_A, PERSON_B],
            },
            from: NaiveDate::from_ymd_opt(2026, 1, 1).unwrap_or_default(),
            to: NaiveDate::from_ymd_opt(2026, 1, 31).unwrap_or_default(),
            compare_to: None,
            metrics: Vec::new(),
            enforce_tenant_scope: true,
        }
    }

    fn person_ids() -> Param {
        Param::uuids([PERSON_A, PERSON_B])
    }

    fn entity_ids() -> Param {
        Param::strings([PERSON_A.to_string(), PERSON_B.to_string()])
    }

    #[test]
    fn a_period_batch_binds_each_distinct_value_once_by_name() {
        let (sum, ratio) = (sum_metric(), ratio_metric());
        let rendered = compile_period_batch_query(&[&sum, &ratio], &request(), &[])
            .sql
            .render();
        assert!(rendered.sql.contains("FROM insight.ai_metric_observations"));
        assert!(
            rendered.sql.contains(
                "WHERE tenant_id = {tenant:String} AND entity_type = {entity_type:String}"
            )
        );
        assert!(rendered.sql.contains("AS m0"));
        assert!(rendered.sql.contains("AS m1"));
        assert!(rendered.sql.contains(
            "sumIfOrNull(value, source_key = {source_key:String} AND measure_key = {measure_key:String}"
        ));
        assert!(rendered.sql.contains("nullIf"));
        assert!(rendered.sql.contains("100 *"));
        assert!(rendered.sql.contains(
            "(source_key, measure_key) IN (({source_key:String}, {measure_key_1:String}), \
             ({source_key:String}, {measure_key:String}), ({source_key:String}, {measure_key_2:String}))"
        ));
        assert!(rendered.sql.contains("GROUP BY entity_id"));
        assert_eq!(
            rendered.params,
            [
                named("source_key", Param::string("ai_usage")),
                named("measure_key", Param::string("accepted_lines")),
                named("measure_key_1", Param::string("accepted_edit_actions")),
                named("measure_key_2", Param::string("tool_use_offered")),
                named("person_ids", person_ids()),
                named("from", Param::date(date("2026-01-01"))),
                named("to", Param::date(date("2026-01-31"))),
                named("entity_ids", entity_ids()),
                named("tenant", Param::string(TEST_TENANT_STR)),
                named("entity_type", Param::string("person")),
            ]
        );
    }

    fn windowed_request() -> ValidatedMetricResultsRequest {
        let mut req = request();
        req.compare_to = Some(DateWindow {
            from: NaiveDate::from_ymd_opt(2025, 12, 1).unwrap_or_default(),
            to: NaiveDate::from_ymd_opt(2025, 12, 31).unwrap_or_default(),
        });
        req
    }

    fn date_params(rendered: &Rendered) -> Vec<(String, Param)> {
        let dates = ["2026-01-01", "2026-01-31", "2025-12-01", "2025-12-31"]
            .map(|raw| Param::date(date(raw)));
        rendered
            .params
            .iter()
            .filter(|(_, param)| dates.contains(param))
            .cloned()
            .collect()
    }

    #[test]
    fn a_compared_period_batch_scans_each_range_and_scopes_both_columns() {
        let sum = sum_metric();
        let rendered = compile_period_batch_query(&[&sum], &windowed_request(), &[])
            .sql
            .render();

        assert!(rendered.sql.contains("AS m0"));
        assert!(rendered.sql.contains("AS m0_compare"));
        assert!(rendered.sql.contains(
            "(metric_date >= {from:Date} AND metric_date <= {to:Date}) OR (metric_date >= {from_1:Date} AND metric_date <= {to_1:Date})"
        ));
        assert!(
            rendered
                .sql
                .contains("AND metric_date >= {from:Date} AND metric_date <= {to:Date}) AS m0,")
        );
        assert!(rendered.sql.contains(
            "AND metric_date >= {from_1:Date} AND metric_date <= {to_1:Date}) AS m0_compare"
        ));
        assert_eq!(
            date_params(&rendered),
            [
                named("from", Param::date(date("2026-01-01"))),
                named("to", Param::date(date("2026-01-31"))),
                named("from_1", Param::date(date("2025-12-01"))),
                named("to_1", Param::date(date("2025-12-31"))),
            ]
        );
    }

    type UnwidenedCase = (
        &'static str,
        fn(&ValidatedMetricResultsRequest) -> CompiledQuery,
    );

    #[test]
    fn only_period_and_breakdown_widen_their_scan_for_a_comparison_window() {
        let sum = sum_metric();
        let mut dimensioned = sum_metric();
        dimensioned.base.allowed_dimensions = vec!["tool".to_owned()];
        let dims = vec!["tool".to_owned()];

        let unchanged: Vec<UnwidenedCase> = vec![
            ("peer (declared cohort)", |req| {
                compile_peer_batch_query(
                    &[&sum_metric()],
                    req,
                    "org_unit",
                    PeerPopulation::DeclaredCohort,
                    &[],
                )
            }),
            ("peer (tenant)", |req| {
                compile_peer_batch_query(
                    &[&sum_metric()],
                    req,
                    "org_unit",
                    PeerPopulation::Tenant,
                    &[],
                )
            }),
            ("timeseries", |req| {
                compile_timeseries_query(&sum_metric(), req, Bucket::Week.into(), &[], &[], None)
            }),
            ("rollup", |req| {
                compile_rollup_query(
                    &sum_metric(),
                    req,
                    std::slice::from_ref(&"tool".to_owned()),
                    &[],
                    None,
                )
            }),
            ("histogram", |req| {
                compile_histogram_query(&median_metric(), req, &[])
            }),
            ("ranking", |req| {
                compile_group_ranking_query(
                    &sum_metric(),
                    req,
                    std::slice::from_ref(&"tool".to_owned()),
                    &[],
                    5,
                )
            }),
        ];
        for (name, compile) in unchanged {
            let plain = compile(&request()).sql.render();
            let compared = compile(&windowed_request()).sql.render();
            assert_eq!(plain.sql, compared.sql, "{name}: SQL must not widen");
            assert_eq!(
                plain.params, compared.params,
                "{name}: bound dates must not widen"
            );
        }

        let period_plain = compile_period_batch_query(&[&sum], &request(), &[]);
        let period_compared = compile_period_batch_query(&[&sum], &windowed_request(), &[]);
        assert_ne!(
            sql_of(&period_plain),
            sql_of(&period_compared),
            "period must widen"
        );

        let breakdown_plain = compile_breakdown_query(&dimensioned, &request(), &dims, &[]);
        let breakdown_compared =
            compile_breakdown_query(&dimensioned, &windowed_request(), &dims, &[]);
        assert_ne!(
            sql_of(&breakdown_plain),
            sql_of(&breakdown_compared),
            "breakdown must widen"
        );
    }

    #[test]
    fn an_uncompared_batch_keeps_the_single_range_form() {
        let sum = sum_metric();
        let sql = sql_of(&compile_period_batch_query(&[&sum], &request(), &[]));

        assert!(sql.contains("AND metric_date >= {from:Date} AND metric_date <= {to:Date} AND"));
        assert!(!sql.contains(" OR ("));
        assert!(!sql.contains("AS m0_compare"));
    }

    #[test]
    fn a_ratio_over_windows_scopes_both_halves_of_the_fraction() {
        let ratio = ratio_metric();
        let sql = sql_of(&compile_period_batch_query(
            &[&ratio],
            &windowed_request(),
            &[],
        ));

        for (window, alias) in [("{from:Date}", "m0"), ("{from_1:Date}", "m0_compare")] {
            let to = window.replace("from", "to");
            assert!(
                sql.contains(&format!(
                    "100 * sumIfOrNull(value, source_key = {{source_key:String}} AND measure_key = {{measure_key:String}} \
                     AND value IS NOT NULL AND metric_date >= {window} AND metric_date <= {to}) \
                     / nullIf(sumIf(value, source_key = {{source_key:String}} AND measure_key = {{measure_key_1:String}} \
                     AND value IS NOT NULL AND metric_date >= {window} AND metric_date <= {to}), 0) AS {alias}"
                )),
                "both halves of {alias} must read {window}: {sql}"
            );
        }
    }

    #[test]
    fn a_compared_breakdown_emits_a_value_and_a_presence_column_per_window() {
        let sum = sum_metric();
        let rendered = compile_breakdown_query(
            &sum,
            &windowed_request(),
            std::slice::from_ref(&"tool".to_owned()),
            &[],
        )
        .sql
        .render();

        assert!(rendered.sql.contains("AS value"));
        assert!(rendered.sql.contains("AS value_compare"));
        assert!(rendered.sql.contains("AS present"));
        assert!(rendered.sql.contains("AS present_compare"));
        for (from, to, alias) in [
            ("from", "to", "present"),
            ("from_1", "to_1", "present_compare"),
        ] {
            assert!(
                rendered.sql.contains(&format!(
                    "countIf(metric_date >= {{{from}:Date}} AND metric_date <= {{{to}:Date}}) > 0 AS {alias}"
                )),
                "one presence column per window, the primary included: {}",
                rendered.sql
            );
        }
        assert!(rendered.sql.contains("AS staged_value"));
        assert_eq!(date_params(&rendered).len(), 4);
    }

    #[test]
    fn an_uncompared_breakdown_carries_no_presence_column() {
        let sum = sum_metric();
        let sql = sql_of(&compile_breakdown_query(
            &sum,
            &request(),
            std::slice::from_ref(&"tool".to_owned()),
            &[],
        ));

        assert!(!sql.contains("present"));
        assert!(!sql.contains("staged_"));
        assert!(!sql.contains(" OR ("));
    }

    #[test]
    fn tenant_queries_match_the_entity_to_its_storage_partition() {
        let sum = sum_metric();
        let mut req = request();
        req.entity = ValidatedEntitySelection::Tenant { id: TEST_TENANT };

        let rendered = compile_period_batch_query(&[&sum], &req, &[]).sql.render();

        assert!(rendered.sql.contains("AND entity_id = tenant_id"));
        assert!(
            !rendered
                .params
                .iter()
                .any(|(_, param)| *param == Param::string("default"))
        );
    }

    const CUSTOM_SQL: &str = "SELECT tenant_id, source_key, entity_type, entity_id, \
        metric_date, measure_key, observed_at, value, subject_key, dimensions FROM joined";

    fn custom_sum_metric() -> MetricDefinition {
        MetricDefinition {
            transform: None,
            base: base(vec!["tool"]),
            spec: ComputationSpec::Sum {
                value: MetricInput {
                    role: MetricInputRole::Value,
                    observation: ObservationSource::Custom(CustomObservationSql::new(
                        CUSTOM_SQL.to_owned(),
                    )),
                    source_key: "custom_ai_usage".to_owned(),
                    measure_key: "accepted_lines".to_owned(),
                    alias_collapse: AliasCollapse::Sum,
                },
            },
        }
    }

    #[test]
    fn custom_source_reads_from_the_inline_sql_with_the_tenant_filter_outside() {
        let def = custom_sum_metric();
        let ts = compile_timeseries_query(&def, &request(), QueryBucket::Day, &[], &[], None)
            .sql
            .render();
        assert!(ts.sql.contains(&format!("FROM ({CUSTOM_SQL})")));
        assert!(!ts.sql.contains("insight.ai_metric_observations"));
        assert!(ts.sql.contains("WHERE tenant_id = {tenant:String}"));
        assert_eq!(
            ts.params.first(),
            Some(&named("tenant", Param::string(TEST_TENANT_STR)))
        );

        let batch = sql_of(&compile_period_batch_query(&[&def], &request(), &[]));
        assert!(batch.contains(&format!("FROM ({CUSTOM_SQL})")));
    }

    #[test]
    fn period_batch_of_one_uses_wide_aliases() {
        let sum = sum_metric();
        let sql = sql_of(&compile_period_batch_query(&[&sum], &request(), &[]));
        assert!(sql.contains("AS m0"));
        assert!(!sql.contains("AS value"));
    }

    #[test]
    fn a_ratio_reads_both_halves_from_the_numerator_source() {
        let mut ratio = ratio_metric();
        let ComputationSpec::Ratio { denominator, .. } = &mut ratio.spec else {
            panic!("fixture must be ratio");
        };
        denominator.source_key = "denominator_source".to_owned();

        let rendered = compile_period_batch_query(&[&ratio], &request(), &[])
            .sql
            .render();

        assert!(rendered.sql.contains(
            "nullIf(sumIf(value, source_key = {source_key:String} AND measure_key = {measure_key_1:String} AND value IS NOT NULL), 0)"
        ));
        assert!(
            !rendered
                .params
                .iter()
                .any(|(_, param)| *param == Param::string("denominator_source")),
            "the denominator's own source is never read: {:?}",
            rendered.params
        );
    }

    #[test]
    fn tenant_is_bound_from_context_once_per_contract_read() {
        let sum = sum_metric();

        let ts = compile_timeseries_query(&sum, &request(), QueryBucket::Day, &[], &[], None)
            .sql
            .render();
        assert!(
            ts.sql.contains("WHERE tenant_id = {tenant:String}"),
            "timeseries read"
        );
        assert_eq!(tenant_binds(&ts), 1);

        let rank = compile_group_ranking_query(&sum, &request(), &["tool".to_owned()], &[], 5)
            .sql
            .render();
        assert!(
            rank.sql.contains("WHERE tenant_id = {tenant:String}"),
            "ranking read"
        );
        assert_eq!(tenant_binds(&rank), 1);

        let peer = compile_peer_batch_query(
            &[&sum],
            &request(),
            "org_unit",
            PeerPopulation::DeclaredCohort,
            &[],
        )
        .sql
        .render();
        assert_eq!(peer.sql.matches("tenant_id = {tenant:String}").count(), 3);
        assert_eq!(tenant_binds(&peer), 1);
    }

    #[test]
    fn tenant_scope_disabled_bypasses_the_filter_but_still_binds_the_tenant() {
        let sum = sum_metric();
        let mut req = request();
        req.enforce_tenant_scope = false;

        let ts = compile_timeseries_query(&sum, &req, QueryBucket::Day, &[], &[], None)
            .sql
            .render();
        assert!(
            ts.sql.contains("(tenant_id = {tenant:String} OR 1 = 1)"),
            "timeseries uses the bypass term"
        );
        assert!(
            !ts.sql.contains("WHERE tenant_id = {tenant:String}"),
            "no exact-match tenant term when bypassed"
        );
        assert_eq!(tenant_binds(&ts), 1);

        let peer = sql_of(&compile_peer_batch_query(
            &[&sum],
            &req,
            "org_unit",
            PeerPopulation::DeclaredCohort,
            &[],
        ));
        assert_eq!(
            peer.matches("(tenant_id = {tenant:String} OR 1 = 1)")
                .count(),
            3
        );
    }

    #[test]
    fn timeseries_query_buckets_on_a_non_nullable_date() {
        for (bucket, expr) in [
            (QueryBucket::Day, "assumeNotNull(metric_date)"),
            (
                QueryBucket::Week,
                "toStartOfWeek(assumeNotNull(metric_date), 1)",
            ),
            (
                QueryBucket::Month,
                "toStartOfMonth(assumeNotNull(metric_date))",
            ),
            (
                QueryBucket::Quarter,
                "toStartOfQuarter(assumeNotNull(metric_date))",
            ),
            (
                QueryBucket::Year,
                "toStartOfYear(assumeNotNull(metric_date))",
            ),
        ] {
            let sql = sql_of(&compile_timeseries_query(
                &sum_metric(),
                &request(),
                bucket,
                &[],
                &[],
                None,
            ));
            assert!(sql.contains(&format!("toString({expr}) AS bucket_start")));
            assert!(sql.contains("GROUP BY GROUPING SETS"));
        }
    }

    fn resolved_limit(include_remainder: bool) -> ResolvedGroupLimit {
        ResolvedGroupLimit {
            groups: vec![
                RankedGroup {
                    rank: 1,
                    dimensions: vec![RankedDimension {
                        value: "cursor".to_owned(),
                        label: Some("Cursor".to_owned()),
                    }],
                },
                RankedGroup {
                    rank: 2,
                    dimensions: vec![RankedDimension {
                        value: UNKNOWN_DIMENSION_VALUE.to_owned(),
                        label: Some(UNKNOWN_DIMENSION_LABEL.to_owned()),
                    }],
                },
            ],
            include_remainder,
        }
    }

    #[test]
    fn ranking_query_is_global_transformed_and_deterministic() {
        let mut def = sum_metric();
        def.transform = Some(ValueTransform {
            multiplier: Some(2.0),
            ..ValueTransform::default()
        });
        let sql = sql_of(&compile_group_ranking_query(
            &def,
            &request(),
            &["tool".to_owned()],
            &[],
            10,
        ));
        assert!(!sql.contains("GROUP BY entity_id"));
        assert!(sql.contains("2.0 * (value) AS value"));
        assert!(sql.contains("WHERE value IS NOT NULL"));
        assert!(sql.contains("ORDER BY value DESC, dim_0_value"));
        assert!(sql.contains("LIMIT 10"));
    }

    #[test]
    fn capped_timeseries_freezes_groups_and_aggregates_the_remainder() {
        let dimensions = vec!["tool".to_owned()];
        for def in [
            sum_metric(),
            ratio_metric(),
            median_metric(),
            distinct_count_metric(),
        ] {
            let rendered = compile_timeseries_query(
                &def,
                &request(),
                QueryBucket::Week,
                &dimensions,
                &[],
                Some(&resolved_limit(true)),
            )
            .sql
            .render();
            assert!(rendered.sql.contains("AS group_rank"));
            assert!(rendered.sql.contains("GROUP BY GROUPING SETS"));
            assert!(rendered.sql.contains("(entity_id, group_rank)"));
            assert!(rendered.sql.contains("toNullable('Other')"));
            assert!(rendered.sql.contains("group_rank = 0"));
            assert!(!rendered.sql.contains("WHERE group_rank > 0"));
            assert!(rendered.sql.contains(
                "multiIf((raw_dim_0 = {group_value:String}), toUInt32(1), \
                 (raw_dim_0 = {group_value_1:String}), toUInt32(2), toUInt32(0))"
            ));
            assert!(rendered.sql.contains(
                "multiIf(group_rank = 1, toNullable({group_value:String}), \
                 group_rank = 2, toNullable({group_value_1:String}), CAST(NULL AS Nullable(String))) AS dim_0_value"
            ));
            assert!(rendered.sql.contains(
                "multiIf(group_rank = 1, toNullable({group_label:String}), \
                 group_rank = 2, toNullable({group_label_1:String}), CAST(NULL AS Nullable(String))) AS dim_0_label"
            ));
            for expected in [
                named("group_value", Param::string("cursor")),
                named("group_value_1", Param::string(UNKNOWN_DIMENSION_VALUE)),
                named("group_label", Param::string("Cursor")),
                named("group_label_1", Param::string(UNKNOWN_DIMENSION_LABEL)),
            ] {
                assert!(
                    rendered.params.contains(&expected),
                    "{expected:?} in {:?}",
                    rendered.params
                );
            }
        }
    }

    #[test]
    fn capped_timeseries_uses_one_aggregation_pipeline_for_points_and_totals() {
        let sql = sql_of(&compile_timeseries_query(
            &ratio_metric(),
            &request(),
            QueryBucket::Day,
            &["tool".to_owned()],
            &[],
            Some(&resolved_limit(false)),
        ));
        assert_eq!(sql.matches("sumIfOrNull(value").count(), 1);
        assert_eq!(sql.matches("nullIf(sumIf(value").count(), 1);
        assert_eq!(sql.matches("aggregated AS").count(), 1);
        assert!(sql.contains("WHERE group_rank > 0"));
    }

    #[test]
    fn rollup_aggregates_values_and_entity_counts_without_entity_grain() {
        for def in [sum_metric(), ratio_metric(), median_metric()] {
            let sql = sql_of(&compile_rollup_query(
                &def,
                &request(),
                &["tool".to_owned()],
                &[],
                None,
            ));

            assert!(sql.contains("uniqExact(entity_id) AS contributing_entity_count"));
            assert!(sql.contains("GROUP BY dim_0_value"));
            assert!(!sql.contains("GROUP BY entity_id"));
        }
    }

    #[test]
    fn unattributed_reads_the_rows_no_person_resolves_tenant_wide() {
        let rendered = compile_unattributed_query(&sum_metric(), &request(), &[])
            .sql
            .render();

        assert!(
            rendered
                .sql
                .contains("WHERE resolved_person_id = '' AND NOT account_bound"),
            "only rows resolving to nobody, an excluded binding not among them"
        );
        assert!(!rendered.sql.contains("GROUP BY"), "one tenant-wide row");
        assert!(
            !rendered
                .params
                .iter()
                .any(|(_, param)| *param == person_ids() || *param == entity_ids()),
            "the requested people do not scope the reading"
        );
        assert_eq!(tenant_binds(&rendered), 1);
    }

    #[test]
    fn person_reads_keep_the_excluded_binding_resolving_to_nobody() {
        let sql = sql_of(&compile_rollup_query(
            &sum_metric(),
            &request(),
            &["tool".to_owned()],
            &[],
            None,
        ));

        assert!(sql.contains("AS account_bound"));
        assert!(sql.contains("WHERE resolved_person_id IN {entity_ids:Array(String)}"));
    }

    #[test]
    fn capped_rollup_recomputes_values_and_entity_counts_for_remainder() {
        let sql = sql_of(&compile_rollup_query(
            &ratio_metric(),
            &request(),
            &["tool".to_owned()],
            &[],
            Some(&resolved_limit(true)),
        ));

        assert!(sql.contains("AS group_rank"));
        assert!(sql.contains("GROUP BY group_rank"));
        assert!(sql.contains("uniqExact(entity_id) AS contributing_entity_count"));
        assert!(sql.contains("toNullable('Other')"));
        assert!(sql.contains("ORDER BY group_rank = 0, group_rank"));
        assert_eq!(sql.matches("sumIfOrNull(value").count(), 1);
    }

    #[test]
    fn empty_ranking_routes_displayed_data_to_the_remainder() {
        let sql = sql_of(&compile_timeseries_query(
            &sum_metric(),
            &request(),
            QueryBucket::Day,
            &["tool".to_owned()],
            &[],
            Some(&ResolvedGroupLimit {
                groups: vec![],
                include_remainder: true,
            }),
        ));
        assert!(sql.contains("toUInt32(0) AS group_rank"));
        assert!(sql.contains("toNullable('Other')"));
    }

    #[test]
    fn dimensioned_query_emits_value_and_label_aliases() {
        let sql = sql_of(&compile_breakdown_query(
            &sum_metric(),
            &request(),
            &["tool".to_owned()],
            &[],
        ));
        assert!(sql.contains("AS dim_0_value"));
        assert!(sql.contains("AS dim_0_label"));
        assert!(sql.contains("indexOf(dimensions.1, 'tool')"));
        assert!(sql.contains("GROUP BY entity_id, dim_0_value, dim_0_label"));
    }

    #[test]
    fn a_dimension_filter_binds_its_values_as_one_array() {
        let filters = [
            ValidatedDimensionFilter {
                dimension: "tool".to_owned(),
                values: vec!["cursor".to_owned(), "copilot".to_owned()],
            },
            ValidatedDimensionFilter {
                dimension: "source".to_owned(),
                values: vec!["github".to_owned()],
            },
        ];

        let rendered = compile_breakdown_query(&sum_metric(), &request(), &[], &filters)
            .sql
            .render();

        assert!(rendered.sql.contains(
            "AND indexOf(dimensions.1, 'tool') > 0 AND dimensions.2[indexOf(dimensions.1, 'tool')] \
             IN {filter_values:Array(String)} AND indexOf(dimensions.1, 'source') > 0 \
             AND dimensions.2[indexOf(dimensions.1, 'source')] IN {filter_values_1:Array(String)}"
        ));
        assert!(rendered.params.contains(&named(
            "filter_values",
            Param::strings(["cursor", "copilot"])
        )));
        assert!(
            rendered
                .params
                .contains(&named("filter_values_1", Param::strings(["github"])))
        );
    }

    #[test]
    fn repository_breakdown_namespaces_hidden_source_context() {
        let sql = sql_of(&compile_breakdown_query(
            &sum_metric(),
            &request(),
            &["repository".to_owned()],
            &[],
        ));

        assert!(sql.contains("AS link_source_provider"));
        assert!(sql.contains("AS link_source_id"));
        assert!(sql.contains("link_source_provider, link_source_id"));
        assert!(!sql.contains(" AS source_id"));
    }

    #[test]
    fn a_cohort_peer_batch_scopes_both_cohort_reads_with_one_bound_scope() {
        let sum = sum_metric();
        let rendered = compile_peer_batch_query(
            &[&sum],
            &request(),
            "org_unit",
            PeerPopulation::DeclaredCohort,
            &[],
        )
        .sql
        .render();
        assert!(
            rendered
                .sql
                .contains("FROM insight.metric_entity_cohorts_current")
        );
        assert_eq!(
            rendered
                .sql
                .matches(
                    "WHERE tenant_id = {tenant:String} AND entity_type = {entity_type:String}\n              \
                     AND cohort_key = {cohort_key:String}"
                )
                .count(),
            2
        );
        assert!(
            rendered
                .sql
                .contains("AND entity_id IN {entity_ids:Array(String)}")
        );
        assert_eq!(
            rendered.params,
            [
                named("tenant", Param::string(TEST_TENANT_STR)),
                named("entity_type", Param::string("person")),
                named("cohort_key", Param::string("org_unit")),
                named("entity_ids", entity_ids()),
                named("source_key", Param::string("ai_usage")),
                named("measure_key", Param::string("accepted_lines")),
                named("from", Param::date(date("2026-01-01"))),
                named("to", Param::date(date("2026-01-31"))),
            ]
        );
    }

    #[test]
    fn flat_peer_batch_uses_every_measured_person_as_one_population() {
        let sum = sum_metric();
        let rendered =
            compile_peer_batch_query(&[&sum], &request(), "org_unit", PeerPopulation::Tenant, &[])
                .sql
                .render();

        assert!(!rendered.sql.contains("metric_entity_cohorts_current"));
        assert!(
            rendered
                .sql
                .contains("arrayJoin({entity_ids:Array(String)}) AS entity_id")
        );
        assert!(rendered.sql.contains("CROSS JOIN population_stats"));
        assert!(!rendered.sql.contains("ON 1 = 1"));
        assert!(rendered.sql.contains(
            "groupArrayIf(tuple(peer.entity_id, peer.m0), \
             peer.entity_id IN (SELECT entity_id FROM targets)) AS target_rows"
        ));
        assert!(rendered.sql.contains(
            "tupleElement(arrayFirst(t -> t.1 = targets.entity_id, \
             population_stats.target_rows), 2) AS m0_target"
        ));
        assert!(
            rendered
                .sql
                .contains("population_stats.m0_median AS m0_median")
        );
        assert!(
            rendered
                .sql
                .contains("toUInt64(uniqExactIf(peer.entity_id, peer.m0 IS NOT NULL)) AS m0_n"),
            "an empty observation window still yields the one aggregate row, so n reads 0"
        );
        assert_eq!(
            rendered.sql.matches("tenant_id = {tenant:String}").count(),
            1
        );
        assert_eq!(
            rendered.params,
            [
                named("entity_ids", entity_ids()),
                named("source_key", Param::string("ai_usage")),
                named("measure_key", Param::string("accepted_lines")),
                named("from", Param::date(date("2026-01-01"))),
                named("to", Param::date(date("2026-01-31"))),
                named("tenant", Param::string(TEST_TENANT_STR)),
                named("entity_type", Param::string("person")),
            ]
        );
    }

    #[test]
    fn peer_batches_read_the_observation_window_once() {
        let sum = sum_metric();
        for population in [PeerPopulation::DeclaredCohort, PeerPopulation::Tenant] {
            let sql = sql_of(&compile_peer_batch_query(
                &[&sum],
                &request(),
                "org_unit",
                population,
                &[],
            ));
            assert_eq!(
                sql.matches("entity_values").count(),
                2,
                "one definition and one reference, got:\n{sql}"
            );
            assert!(
                !sql.contains("AS target_values"),
                "the target join re-scans the window; extract from the single peer reference"
            );
        }
    }

    #[test]
    fn peer_batch_never_fabricates_zero_observations() {
        let (sum, ratio) = (sum_metric(), ratio_metric());
        let sql = sql_of(&compile_peer_batch_query(
            &[&sum, &ratio],
            &request(),
            "org_unit",
            PeerPopulation::DeclaredCohort,
            &[],
        ));
        assert!(sql.contains("sumIfOrNull"));
        assert!(!sql.contains("coalesce(metric_values"));
        assert!(!sql.contains("coalesce(peer."));
        assert!(sql.contains("metric_values.m0 AS m0"));
    }

    #[test]
    fn peer_batch_guards_every_percentile_per_item() {
        let (sum, ratio) = (sum_metric(), ratio_metric());
        let sql = sql_of(&compile_peer_batch_query(
            &[&sum, &ratio],
            &request(),
            "org_unit",
            PeerPopulation::DeclaredCohort,
            &[],
        ));
        for item in 0..2 {
            let guard =
                format!("uniqExactIf(peer.entity_id, peer.m{item} IS NOT NULL) >= {MIN_PEER_N}");
            assert_eq!(
                sql.matches(&guard).count(),
                5,
                "every percentile/min/max must carry the per-item disclosure guard"
            );
            assert!(sql.contains(&format!(
                "toUInt64(uniqExactIf(peer.entity_id, peer.m{item} IS NOT NULL)) AS m{item}_n"
            )));
            assert!(sql.contains(&format!("AS m{item}_target")));
        }
        for item in 0..2 {
            assert!(sql.contains(&format!(
                "quantilesExactIf(0.25, 0.75)(peer.m{item}, peer.m{item} IS NOT NULL)"
            )));
            assert!(sql.contains(&format!(
                "quantileExactInclusiveIf(0.5)(peer.m{item}, peer.m{item} IS NOT NULL)"
            )));
        }
        assert!(!sql.contains("quantileExactIf(0.25)"));
        assert!(
            !sql.contains("quantilesExactIf(0.25, 0.5, 0.75)"),
            "the peer median must not come back as the middle order statistic"
        );
        assert!(
            !sql.contains("HAVING"),
            "no collapsing: the cohort relation already arrives at person grain"
        );
        assert!(
            sql.contains("AND cohort_id IN (SELECT cohort_id FROM targets)"),
            "the pool is exactly the target cohorts' membership"
        );
        assert!(sql.contains("SETTINGS join_use_nulls = 1"));
        assert!(sql.contains("GROUP BY targets.entity_id"));
    }

    #[test]
    fn queries_carry_row_limit() {
        let (sum, ratio) = (sum_metric(), ratio_metric());
        let limit = format!("LIMIT {}", query_row_limit());
        assert!(sql_of(&compile_period_batch_query(&[&sum], &request(), &[])).contains(&limit));
        assert!(
            sql_of(&compile_peer_batch_query(
                &[&ratio],
                &request(),
                "org_unit",
                PeerPopulation::DeclaredCohort,
                &[],
            ))
            .contains(&limit)
        );
    }

    #[test]
    fn median_batches_as_a_quantile_ornull_column() {
        for query in [
            compile_period_batch_query(&[&median_metric()], &request(), &[]),
            compile_peer_batch_query(
                &[&median_metric()],
                &request(),
                "org_unit",
                PeerPopulation::DeclaredCohort,
                &[],
            ),
        ] {
            assert!(
                sql_of(&query).contains(
                    "quantileExactInclusiveIfOrNull(0.5)(value, source_key = {source_key:String} \
                     AND measure_key = {measure_key:String}"
                ),
                "median must batch as an OrNull quantile column, interpolating both \
                 middle values on an even sample"
            );
        }
    }

    #[test]
    fn median_single_views_use_exact_median() {
        let ts = sql_of(&compile_timeseries_query(
            &median_metric(),
            &request(),
            QueryBucket::Week,
            &[],
            &[],
            None,
        ));
        assert!(ts.contains("quantileExactInclusiveIf(0.5)(value, value IS NOT NULL)"));
        assert!(ts.contains("GROUP BY GROUPING SETS"));
        let bd = sql_of(&compile_breakdown_query(
            &median_metric(),
            &request(),
            &["source".to_owned()],
            &[],
        ));
        assert!(bd.contains("quantileExactInclusiveIf(0.5)(value, value IS NOT NULL)"));
    }

    #[test]
    fn percentile_batches_as_a_leveled_quantile_ornull_column() {
        for query in [
            compile_period_batch_query(&[&percentile_metric()], &request(), &[]),
            compile_peer_batch_query(
                &[&percentile_metric()],
                &request(),
                "org_unit",
                PeerPopulation::DeclaredCohort,
                &[],
            ),
        ] {
            assert!(
                sql_of(&query).contains(
                    "quantileExactIfOrNull(0.75)(value, source_key = {source_key:String} \
                     AND measure_key = {measure_key:String}"
                ),
                "percentile must batch as an OrNull quantile column at its level"
            );
        }
    }

    #[test]
    fn percentile_single_views_use_the_declared_level() {
        let ts = sql_of(&compile_timeseries_query(
            &percentile_metric(),
            &request(),
            QueryBucket::Week,
            &[],
            &[],
            None,
        ));
        assert!(ts.contains("quantileExactIf(0.75)(value, value IS NOT NULL)"));
        let bd = sql_of(&compile_breakdown_query(
            &percentile_metric(),
            &request(),
            &["source".to_owned()],
            &[],
        ));
        assert!(bd.contains("quantileExactIf(0.75)(value, value IS NOT NULL)"));
    }

    #[test]
    fn distinct_count_batches_as_a_uniq_ornull_column() {
        for query in [
            compile_period_batch_query(&[&distinct_count_metric()], &request(), &[]),
            compile_peer_batch_query(
                &[&distinct_count_metric()],
                &request(),
                "org_unit",
                PeerPopulation::DeclaredCohort,
                &[],
            ),
        ] {
            assert!(
                sql_of(&query).contains(
                    "uniqExactIfOrNull(subject_key, source_key = {source_key:String} \
                     AND measure_key = {measure_key:String}"
                ),
                "distinct count must batch as an OrNull uniqExact column over subject_key"
            );
        }
    }

    #[test]
    fn ratio_numerator_never_fabricates_zero() {
        let batched = sql_of(&compile_period_batch_query(
            &[&ratio_metric()],
            &request(),
            &[],
        ));
        let ts = sql_of(&compile_timeseries_query(
            &ratio_metric(),
            &request(),
            QueryBucket::Week,
            &[],
            &[],
            None,
        ));
        let bd = sql_of(&compile_breakdown_query(
            &ratio_metric(),
            &request(),
            &["tool".to_owned()],
            &[],
        ));
        assert!(batched.contains("100 * sumIfOrNull(value, source_key = {source_key:String}"));
        for sql in [&ts, &bd] {
            assert!(sql.contains("100 * sumIfOrNull(value, measure_key = {numerator_key:String}"));
            assert!(sql.contains("nullIf(sumIf(value, measure_key = {denominator_key:String}"));
        }
    }

    #[test]
    fn distinct_count_single_views_count_distinct_subject_key() {
        let ts = sql_of(&compile_timeseries_query(
            &distinct_count_metric(),
            &request(),
            QueryBucket::Week,
            &[],
            &[],
            None,
        ));
        assert!(ts.contains("uniqExactIf(subject_key, subject_key IS NOT NULL)"));
        assert!(ts.contains("GROUP BY GROUPING SETS"));
        let bd = sql_of(&compile_breakdown_query(
            &distinct_count_metric(),
            &request(),
            &["tool".to_owned()],
            &[],
        ));
        assert!(bd.contains("uniqExactIf(subject_key, subject_key IS NOT NULL)"));
    }

    #[test]
    fn histogram_query_bins_deterministically_from_entity_bounds() {
        let sql = sql_of(&compile_histogram_query(&median_metric(), &request(), &[]));
        assert!(sql.contains("min(event_value) OVER (PARTITION BY entity_id) AS entity_lo"));
        assert!(sql.contains("max(event_value) OVER (PARTITION BY entity_id) AS entity_hi"));
        assert!(sql.contains("least(9,"));
        assert!(sql.contains("* 10 /"));
        assert!(sql.contains("GROUP BY entity_id, bin_idx"));
        assert!(sql.contains("events.entity_hi = events.entity_lo"));
        assert_eq!(sql.matches("JOIN").count(), 2);
        assert!(sql.contains("JOIN identity.account_assignment"));
        assert!(sql.contains("JOIN identity.person_map"));
        assert!(!sql.contains("histogram("));
    }

    #[test]
    fn pooled_histogram_query_bins_per_dimension_tuple_without_entity_grain() {
        let sql = sql_of(&compile_pooled_histogram_query(
            &percentile_metric(),
            &request(),
            &["source".to_owned()],
            &[],
        ));
        assert!(sql.contains("min(event_value) OVER (PARTITION BY dim_0_value, dim_0_label)"));
        assert!(sql.contains("max(event_value) OVER (PARTITION BY dim_0_value, dim_0_label)"));
        assert!(sql.contains("GROUP BY dim_0_value, dim_0_label, bin_idx"));
        assert!(!sql.contains("PARTITION BY entity_id"));
        assert!(sql.contains("JOIN identity.account_assignment"));
        assert!(sql.contains("JOIN identity.person_map"));
        assert!(sql.contains("least(9,"));
        assert!(sql.contains("* 10 /"));
        assert!(!sql.contains("histogram("));
        assert!(sql.contains(&format!("LIMIT {}", query_row_limit())));
    }

    #[test]
    fn transform_wraps_every_query_shape() {
        let mut def = ratio_metric();
        def.transform = Some(ValueTransform {
            clamp_max: Some(100.0),
            ..ValueTransform::default()
        });
        let ts = sql_of(&compile_timeseries_query(
            &def,
            &request(),
            QueryBucket::Day,
            &[],
            &[],
            None,
        ));
        let bd = sql_of(&compile_breakdown_query(&def, &request(), &[], &[]));
        for sql in [&ts, &bd] {
            assert!(
                sql.contains("if((value) IS NULL, NULL, least(100.0, value)) AS value"),
                "transform must re-project the value alias: {sql}"
            );
        }
        let mut median = median_metric();
        median.transform = Some(ValueTransform {
            clamp_max: Some(100.0),
            ..ValueTransform::default()
        });
        let hist = sql_of(&compile_histogram_query(&median, &request(), &[]));
        assert!(
            hist.contains("if((value) IS NULL, NULL, least(100.0, value))")
                && hist.contains("AS event_value"),
            "histogram must transform into a distinct event_value alias: {hist}"
        );
        assert!(
            hist.contains("min(event_value) OVER") && hist.contains("max(event_value) OVER"),
            "histogram lo/hi must derive from the transformed alias: {hist}"
        );
        let pooled = sql_of(&compile_pooled_histogram_query(
            &median,
            &request(),
            &["source".to_owned()],
            &[],
        ));
        assert!(
            pooled.contains("if((value) IS NULL, NULL, least(100.0, value))")
                && pooled.contains("AS event_value"),
            "pooled histogram must transform into the event_value alias: {pooled}"
        );
        let period = sql_of(&compile_period_batch_query(&[&def], &request(), &[]));
        assert!(
            period.contains("if((m0) IS NULL, NULL, least(100.0, m0))"),
            "batch transform must wrap the item alias: {period}"
        );
        let peer = sql_of(&compile_peer_batch_query(
            &[&def],
            &request(),
            "org_unit",
            PeerPopulation::DeclaredCohort,
            &[],
        ));
        assert!(
            peer.contains("if((metric_values.m0) IS NULL, NULL,"),
            "peer carry must transform before percentiles: {peer}"
        );
    }

    fn flagged_input(
        role: MetricInputRole,
        measure_key: &str,
        collapse: AliasCollapse,
    ) -> MetricInput {
        MetricInput {
            alias_collapse: collapse,
            ..input(role, measure_key)
        }
    }

    fn flag_sum_metric() -> MetricDefinition {
        MetricDefinition {
            transform: None,
            base: base(vec!["tool"]),
            spec: ComputationSpec::Sum {
                value: flagged_input(MetricInputRole::Value, "active_day", AliasCollapse::Max),
            },
        }
    }

    fn inverse_flag_sum_metric() -> MetricDefinition {
        MetricDefinition {
            transform: None,
            base: base(vec!["tool"]),
            spec: ComputationSpec::Sum {
                value: flagged_input(
                    MetricInputRole::Value,
                    "meeting_free_day",
                    AliasCollapse::Min,
                ),
            },
        }
    }

    fn flag_ratio_metric() -> MetricDefinition {
        MetricDefinition {
            transform: None,
            base: base(vec!["tool"]),
            spec: ComputationSpec::Ratio {
                numerator: input(MetricInputRole::Numerator, "accepted_lines"),
                denominator: flagged_input(
                    MetricInputRole::Denominator,
                    "active_day",
                    AliasCollapse::Max,
                ),
                scale: 1.0,
                denominator_aggregation: RatioDenominatorAggregation::Sum,
            },
        }
    }

    #[test]
    fn a_person_read_resolves_through_the_live_map_and_groups_by_the_person() {
        let rendered = compile_period_batch_query(&[&sum_metric()], &request(), &[])
            .sql
            .render();

        assert!(
            rendered
                .sql
                .contains("LEFT JOIN identity.account_assignment AS account_map")
        );
        assert!(
            rendered
                .sql
                .contains("LEFT JOIN identity.person_map AS person_map")
        );
        assert!(rendered.sql.contains("ON person_map.email = obs.entity_id"));
        assert!(
            rendered.sql.contains(
                "(obs.entity_id IN (SELECT email FROM identity.person_map WHERE person_id IN {person_ids:Array(UUID)}) \
                 OR coalesce(obs.account_id, '') != '')"
            ),
            "the prune keeps the requested people's email parts plus every account-carrying row"
        );
        assert!(
            rendered
                .sql
                .contains("WHERE resolved_person_id IN {entity_ids:Array(String)}"),
            "the resolved filter is exact, whatever the prune let through"
        );
        assert!(rendered.params.contains(&named("person_ids", person_ids())));
        assert!(rendered.params.contains(&named("entity_ids", entity_ids())));
        assert!(rendered.sql.contains("resolved_person_id AS entity_id"));
        assert!(rendered.sql.contains("GROUP BY entity_id"));
    }

    #[test]
    fn an_account_binding_wins_over_the_email_and_an_excluded_one_terminates() {
        let sql = sql_of(&compile_period_batch_query(
            &[&sum_metric()],
            &request(),
            &[],
        ));

        assert!(
            sql.contains("coalesce(account_map.account_id, '') != ''"),
            "the account arm is decided before the email arm"
        );
        assert!(
            sql.contains("= toUUID('ffffffff-ffff-ffff-ffff-ffffffffffff')"),
            "an account bound to the excluded person resolves to nobody"
        );
        assert!(
            sql.contains("sipHash128(coalesce(obs.account_source_id, ''))"),
            "the binding key uses identity's minted source id form"
        );
        assert!(
            sql.contains("account_map.account_id = lower(trimBoth(coalesce(obs.account_id, '')))"),
            "the fact side meets the map's lowered account id"
        );
    }

    #[test]
    fn a_custom_source_is_never_resolved_at_query_time() {
        let rendered = compile_period_batch_query(&[&custom_sum_metric()], &request(), &[])
            .sql
            .render();

        assert!(!rendered.sql.contains("person_map"));
        assert!(
            rendered
                .sql
                .contains("AND entity_id IN {entity_ids:Array(String)}")
        );
        assert!(rendered.params.contains(&named("entity_ids", entity_ids())));
    }

    #[test]
    fn a_flag_measure_collapses_per_person_day_before_the_outer_sum() {
        let sql = sql_of(&compile_period_batch_query(
            &[&flag_sum_metric()],
            &request(),
            &[],
        ));

        assert!(sql.contains("max(value)"), "flag collapses with max");
        assert!(
            sql.contains(
                "GROUP BY tenant_id, entity_type, source_key, measure_key, metric_date, entity_id, dimensions, subject_key"
            ),
            "collapse groups at the relation's own grain with the person in place of the identity"
        );
        assert!(
            sql.contains("sumIfOrNull(value"),
            "the outer aggregate still sums the collapsed days"
        );
    }

    #[test]
    fn an_inverse_flag_measure_collapses_with_min() {
        let sql = sql_of(&compile_period_batch_query(
            &[&inverse_flag_sum_metric()],
            &request(),
            &[],
        ));

        assert!(sql.contains("min(value)"));
        assert!(!sql.contains("max(value)"));
    }

    #[test]
    fn only_the_flagged_half_of_a_ratio_collapses() {
        let rendered = compile_period_batch_query(&[&flag_ratio_metric()], &request(), &[])
            .sql
            .render();

        assert!(rendered.sql.contains(
            "(source_key, measure_key) = ({source_key:String}, {measure_key_1:String}), max(value)"
        ));
        assert!(
            rendered
                .params
                .contains(&named("measure_key_1", Param::string("active_day")))
        );
        assert!(
            rendered.sql.contains("sum(value))"),
            "the multiIf falls through to sum for every unflagged measure"
        );
    }

    #[test]
    fn an_unflagged_read_has_no_collapse_stage() {
        for def in [sum_metric(), median_metric(), distinct_count_metric()] {
            let sql = sql_of(&compile_period_batch_query(&[&def], &request(), &[]));
            assert!(
                !sql.contains("WITH resolved_rows AS"),
                "{} should not collapse",
                def.key()
            );
        }
    }

    #[test]
    fn a_peer_read_resolves_the_whole_cohort_not_only_the_targets() {
        let sql = sql_of(&compile_peer_batch_query(
            &[&sum_metric()],
            &request(),
            "org_unit",
            PeerPopulation::DeclaredCohort,
            &[],
        ));

        assert!(
            sql.contains("WHERE toString(person_id) IN (SELECT entity_id FROM cohort)"),
            "the map is scoped to cohort membership"
        );
        assert!(
            sql.contains("AND entity_id IN {entity_ids:Array(String)}"),
            "targets still filter person ids against the person-grain cohort relation"
        );
    }

    #[test]
    fn a_flagged_neighbor_never_collapses_a_medians_event_rows() {
        let sql = sql_of(&compile_period_batch_query(
            &[&flag_sum_metric(), &median_metric()],
            &request(),
            &[],
        ));

        assert!(
            sql.contains(
                "WHERE (source_key, measure_key) IN (({source_key:String}, {measure_key:String}))"
            ),
            "only the flagged pairs enter the grouped branch"
        );
        assert!(
            sql.contains(
                "WHERE (source_key, measure_key) NOT IN (({source_key:String}, {measure_key:String}))"
            ),
            "every other measure's rows pass through ungrouped"
        );
        assert!(sql.contains("UNION ALL"));
    }
}
