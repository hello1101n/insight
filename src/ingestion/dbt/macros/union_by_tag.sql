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

  How: the latest `dedup_version_col` per `unique_key` is found over those two
  columns alone, and each row is kept only if it holds it (`LIMIT 1 BY` breaks
  a tie, as ROW_NUMBER did). A window over `SELECT *` sorted every whole row in
  memory instead: on dev, 5.7 GiB for the 1.07M rows of class_crm_activities.

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
      SELECT * FROM (
      {%- for m in models %}
        SELECT * FROM {{ ref(m.name) }}
        {%- if not loop.last %} UNION ALL {% endif %}
      {%- endfor %}
      ) AS _ubt
      {#- A NULL unique_key (a NULL tenant or key part) collapses or vanishes in the dedup below. #}
      WHERE {{ tenant_guard_fail('unique_key IS NULL', 'unique_key is NULL before dedup') }} = 0
      {#- One row per unique_key: with a version, one holding the latest; without
          (versionless RMT), any. #}
      {% if dedup_version_col %}
        AND (unique_key, {{ dedup_version_col }}) IN (
          SELECT unique_key, max({{ dedup_version_col }}) FROM (
          {%- for m in models %}
            SELECT unique_key, {{ dedup_version_col }} FROM {{ ref(m.name) }}
            {%- if not loop.last %} UNION ALL {% endif %}
          {%- endfor %}
          ) GROUP BY unique_key
        )
      {% endif %}
      LIMIT 1 BY unique_key
    {%- endif -%}
  {%- else -%}
    SELECT 1 AS _placeholder WHERE FALSE
  {%- endif -%}
{% endmacro %}
