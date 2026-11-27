-- @cpt-principle:cpt-dataflow-principle-staging-then-union:p1
{#-
  union_by_tag(tag_name, dedup_version_col='_version')

  Builds a UNION ALL of every model tagged `tag_name` and deduplicates the
  result at read time to exactly one row per `unique_key`.

  Why the read-time dedup:
    Every staging/silver table is ReplacingMergeTree, which only collapses
    duplicates during background merges — never guaranteed at query time. If
    an upstream table holds transient pre-merge duplicates (e.g. an erroneous
    Airbyte `full_refresh|append` re-appending every row on each sync), a
    plain `SELECT * FROM staging` leaks those
    duplicates straight into silver and inflates metrics. Deduping here makes
    silver duplicate-free regardless of merge timing. See ADR-0001.

  How: `union_relations_latest` below finds the latest `dedup_version_col` per
  `unique_key` over those two columns alone and keeps the rows holding it
  (`LIMIT 1 BY` breaks a tie, as ROW_NUMBER did). A window over `SELECT *`
  sorted every whole row in memory instead: on dev, 5.7 GiB for the 1.07M rows
  of class_crm_activities.

  Args:
    dedup_version_col: version column for "latest wins" dedup (default
      `_version`). Pass `none` for versionless RMT sources (full-refresh
      `class_people`, `class_hr_working_hours`) where any row per key is fine.

  IMPORTANT — "any row per key is fine" holds only when `unique_key` is the
  ENTITY key and the staging views emit one row per entity. The versionless
  branch is a bare `LIMIT 1 BY unique_key` with no `ORDER BY`, so which row wins
  is undefined (empirically it picks the STALE row at `max_threads=1`). If
  staging can emit several rows per entity — e.g. an un-deduped read of an
  append-only bronze table holding multiple unmerged snapshots — the staging
  model MUST dedup its own source (`FINAL` on RMT bronze), or attributes will
  vary between runs. Never encode the version into `unique_key` to work around
  this: that keeps every version as a separate permanently-current row. See
  ADR-0001 and ADR-0004.
-#}
{% macro union_by_tag(tag_name, dedup_version_col='_version') %}
  {%- if execute -%}
    {%- set bronze = bronze_tables() -%}
    {%- set models = [] -%}
    {%- for node in graph.nodes.values() -%}
      {%- if tag_name in node.tags and node.resource_type == 'model' and node.unique_id != model.unique_id -%}
        {#- Readable, not merely there: a stale view over bronze that has gone
            still has a relation, and unioning it fails the whole class. The
            rule is `unbuildable_models`' own, so an arm this run excludes is
            the same arm the union leaves out. -#}
        {%- if relation_is_readable(node, bronze) -%}
          {%- do models.append(node) -%}
        {%- else -%}
          {{ log("union_by_tag: skipping " ~ node.name ~ " (not materialised, or it reads a relation that is gone or bronze that is empty)", info=True) }}
        {%- endif -%}
      {%- endif -%}
    {%- endfor -%}

    {%- if models | length == 0 and load_relation(this) is not none -%}
      {#- No contributor to read: hand the surrounding model SQL the target's
          own schema with zero rows, so the materialise is a no-op and the
          outer "WHERE _version > ..." still compiles. The table stays as is. -#}
      {{ log("union_by_tag: no source tables for tag '" ~ tag_name ~ "' — emitting empty select from the target to preserve schema", info=True) }}
      SELECT * FROM {{ this }} WHERE 1 = 0
    {%- elif models | length == 0 -%}
      {#- No contributor and no table yet: there is no shape to emit — silver
          is a projection of its contributors, and no column list is declared
          anywhere else. A model body cannot skip itself, so the skip is
          `unbuildable_models`', which leaves such a class out of every run that
          passes it the run's selection. Reaching here means a run that did
          not (a hand-picked `--select`); say so instead of failing on a
          table that is not there. -#}
      {{ exceptions.raise_compiler_error(
           "union_by_tag: no contributor tagged '" ~ tag_name ~ "' is materialised and " ~ this
           ~ " does not exist yet, so there is nothing to build it from. Exclude what"
           ~ " `dbt run-operation list_unbuildable_models` lists, or select a contributor too.") }}
    {%- else -%}
      {%- set relations = [] -%}
      {%- for m in models -%}{%- do relations.append(ref(m.name)) -%}{%- endfor -%}
      {#- A NULL unique_key (a NULL tenant or key part) would collapse into one row in the dedup. #}
      {{ union_relations_latest(
           relations, dedup_version_col,
           row_filter=tenant_guard_fail('unique_key IS NULL', 'unique_key is NULL before dedup') ~ ' = 0') }}
    {%- endif -%}
  {%- else -%}
    SELECT 1 AS _placeholder WHERE FALSE
  {%- endif -%}
{% endmacro %}

{#-
  union_relations_latest(relations, dedup_version_col, row_filter=none)

  The UNION ALL of `relations` with one row per `unique_key`. With a version
  column the newest version wins: it is found over `unique_key` and the
  version alone, and only the winning rows are read whole, so memory follows
  the number of keys, not the width of the rows.

  INVARIANT: keys and versions compare as (isNull, assumeNotNull) pairs; a
  plain IN never matches NULL and would drop a NULL key or version.
  INVARIANT: the relations are read twice, so a view arm runs twice. A key
  whose relation another run replaces between the reads matches no winning
  version and leaves this batch; its newer version passes the next run's
  watermark, so it is late, not lost.

  `row_filter`, when given, is applied to every row before the dedup.
-#}
{% macro union_relations_latest(relations, dedup_version_col, row_filter=none) %}
      SELECT * FROM (
      {%- for relation in relations %}
        SELECT * FROM {{ relation }}
        {%- if not loop.last %} UNION ALL {% endif %}
      {%- endfor %}
      ) AS _ubt
      {%- if row_filter %}
      WHERE {{ row_filter }}
      {%- endif %}
      {% if dedup_version_col %}
      {{ 'AND' if row_filter else 'WHERE' }} (isNull(unique_key), assumeNotNull(unique_key),
             isNull({{ dedup_version_col }}), assumeNotNull({{ dedup_version_col }})) IN (
          SELECT isNull(unique_key), assumeNotNull(unique_key),
                 isNull(winning_version), assumeNotNull(winning_version)
          FROM (
              SELECT unique_key, max({{ dedup_version_col }}) AS winning_version
              FROM (
              {%- for relation in relations %}
                  SELECT unique_key, {{ dedup_version_col }} FROM {{ relation }}
                  {%- if not loop.last %} UNION ALL {% endif %}
              {%- endfor %}
              ) AS _ubt_versions
              GROUP BY unique_key
          )
      )
      LIMIT 1 BY unique_key
      {% else %}
      {# Versionless RMT (no _version column): any row per unique_key. #}
      LIMIT 1 BY unique_key
      {% endif %}
{% endmacro %}
