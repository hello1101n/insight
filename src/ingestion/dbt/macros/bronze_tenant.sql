{#-
  bronze_tenant(column='insight_tenant_id')

  The tenant of a Bronze row as a non-Nullable String: the lowercase canonical
  UUID (8-4-4-4-12). Bronze tenant columns are Nullable by Airbyte policy, and
  a NULL tenant is silently lost downstream (keys turn NULL, joins never match,
  dedup collapses it), so every read of a Bronze tenant goes through here:

      insight_tenant_id   ->   {{ bronze_tenant() }} AS insight_tenant_id
      b.insight_tenant_id ->   {{ bronze_tenant('b.insight_tenant_id') }} AS insight_tenant_id

  A NULL, empty, non-UUID or nil-UUID value is invalid. The reaction is set by
  the `bronze_tenant_on_invalid` var (dbt_project.yml, or `--vars`):
    'throw' (default) — the model fails to build, naming itself and the column.
    'warn'            — the row is kept with the value lowercased, NULL as '';
                        the `not_null`/`not_empty` tenant tests report it.

  INVARIANT: the check runs only where ClickHouse evaluates the expression, so
  project it into the model's output. A column a reader prunes (a subquery
  column nothing selects, a `count()` over it) is never computed, and a row
  another filter or the primary-key index drops first is never checked.
-#}
{% macro bronze_tenant(column='insight_tenant_id') -%}
    {%- set value = "ifNull(toString(" ~ column ~ "), '')" -%}
    if(
        {{ tenant_guard_fail(
            "NOT match(" ~ value ~ ", '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$')"
            ~ " OR " ~ value ~ " = '00000000-0000-0000-0000-000000000000'",
            "a Bronze " ~ column ~ " is NULL, empty or not a UUID"
        ) }},
        '',
        lower({{ value }})
    )
{%- endmacro %}


{#-
  tenant_guard_fail(condition, problem)

  The one place the reaction to a bad tenant lives. A UInt8 that is always 0:
  in 'throw' mode it fails the query on the first row where `condition` holds,
  with a message naming the model and `problem`; in 'warn' mode it is the
  constant 0. Use as `WHERE {{ tenant_guard_fail(...) }} = 0` or inside `if()`.
-#}
{% macro tenant_guard_fail(condition, problem) -%}
    {%- set mode = var('bronze_tenant_on_invalid', 'throw') -%}
    {%- if mode not in ('throw', 'warn') -%}
        {{ exceptions.raise_compiler_error("bronze_tenant_on_invalid must be 'throw' or 'warn', not '" ~ mode ~ "'") }}
    {%- endif -%}
    {%- if mode == 'throw' -%}
        {%- set message = this.schema ~ "." ~ this.identifier ~ ": " ~ problem
            ~ "; every Bronze row must carry the install's tenant UUID (bronze_tenant_on_invalid=warn keeps the row)" -%}
        throwIf({{ condition }}, '{{ message | replace("\\", "\\\\") | replace("'", "\\'") }}')
    {%- else -%}
        toUInt8(0)
    {%- endif -%}
{%- endmacro %}
