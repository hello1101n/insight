{#-
  unbuildable_models(selected=none)

  Every model that cannot be built against the warehouse as it stands, by name.
  `list_unbuildable_models` prints the list for `dbt run --exclude`:

      dbt --quiet run-operation list_unbuildable_models
      dbt --quiet run-operation list_unbuildable_models --args '{selected: "a b c", reasons: true}'

  A model is buildable when every relation it reads will be there by the time it
  runs: bronze that is there and, for a model never built yet, holds rows (see
  `bronze_gap`), or a model this run builds first. Silver class models are the exception — `union_by_tag` unions whichever
  tagged contributors are materialised, so ONE buildable contributor is enough
  and the rest are simply left out of the union.

  `selected` is the run's own node set (model names, a list or a space-separated
  string, as `dbt ls --output name` prints them). A model outside it is not
  built by this run, so it counts only if a consumer can read it right now; a
  run split into steps (staging, then the rest) then never reads a relation
  neither step put there. Left out, the whole graph is taken to be the run.

  Only `bronze_*` sources are probed. Bronze is the one layer a run cannot
  create for itself: destination-clickhouse writes it from the connector's own
  catalogue on that connector's first sync. `config` is created by this
  project's own on-run-start hooks, so it always stands by the time a model
  reads it.

  Every model left out is logged with its reason, so nothing is skipped
  silently. A model that IS buildable and then fails, fails the run: this only
  decides what a run can build, it never hides an error in what it builds.
-#}
{% macro unbuildable_models(selected=none) %}
  {{ return(unbuildable_report(selected).keys() | list | sort) }}
{% endmacro %}

{% macro list_unbuildable_models(selected=none, reasons=false) %}
  {#- print(), not log(): `dbt --quiet run-operation` then emits the list and
      nothing else, so a caller can splice it straight into --exclude. With
      `reasons`, one `name<TAB>reason` line per model: the first field is still
      the name, and the line is what a caller logs. -#}
  {%- set report = unbuildable_report(selected) -%}
  {%- if reasons -%}
    {%- for name in report.keys() | sort -%}
      {{- print(name ~ '\t' ~ report[name]) -}}
    {%- endfor -%}
  {%- else -%}
    {{- print(report.keys() | sort | join(' ')) -}}
  {%- endif -%}
{% endmacro %}

{#- name -> why it is not built, for every model the run must leave out. -#}
{% macro unbuildable_report(selected=none) %}
  {%- set report = {} -%}
  {%- if execute -%}
    {%- set bronze = bronze_tables() -%}
    {%- set models = [] -%}
    {%- for node in graph.nodes.values() if node.resource_type == 'model' -%}
      {%- do models.append(node) -%}
    {%- endfor -%}

    {%- set in_run = {} -%}
    {%- if selected is none -%}
      {%- for node in models -%}{%- do in_run.update({node.unique_id: True}) -%}{%- endfor -%}
    {%- else -%}
      {%- set names = (selected.split() if selected is string else selected) -%}
      {%- for node in models if node.name in names -%}{%- do in_run.update({node.unique_id: True}) -%}{%- endfor -%}
    {%- endif -%}

    {#- exists: the model's relation stands now (an ephemeral one has none). -#}
    {%- set exists = {} -%}
    {%- for node in models -%}
      {%- do exists.update({node.unique_id: node.config.materialized != 'ephemeral'
            and adapter.get_relation(database=none, schema=node.schema, identifier=node.alias or node.name) is not none}) -%}
    {%- endfor -%}

    {#- present: the relation is there now, or this run puts it there. -#}
    {%- set present = {} -%}
    {%- for node in models -%}
      {%- if in_run.get(node.unique_id) -%}
        {#- A relation already in the warehouse counts only while reading it does
            not re-run the model. A table holds its rows and stays readable after
            its sources go; a VIEW re-executes, so a stale one over absent bronze
            fails the consumer that unions it — and an ephemeral model has no
            relation at all, dbt inlines it as a CTE on ref(). Both must earn
            their place below, by being buildable. -#}
        {%- set holds_rows = node.config.materialized not in ['view', 'ephemeral'] -%}
        {%- do present.update({node.unique_id: holds_rows and exists[node.unique_id]}) -%}
      {%- else -%}
        {#- Not this run's to build: only what is readable right now. -#}
        {%- do present.update({node.unique_id: relation_is_readable(node, bronze)}) -%}
      {%- endif -%}
    {%- endfor -%}

    {%- set contributors = {} -%}
    {%- for node in models -%}
      {%- set tag = 'silver:' ~ (node.alias or node.name) -%}
      {%- set feeders = [] -%}
      {%- for other in models if tag in other.tags and other.unique_id != node.unique_id -%}
        {%- do feeders.append(other.unique_id) -%}
      {%- endfor -%}
      {%- do contributors.update({node.unique_id: feeders}) -%}
    {%- endfor -%}

    {#- Bronze does not change during the walk, so judge it once. -#}
    {%- set gaps = {} -%}
    {%- for node in models -%}
      {%- do gaps.update({node.unique_id: bronze_gap(node, bronze, exists[node.unique_id])}) -%}
    {%- endfor -%}

    {#- `present` only ever grows, so this settles; the loop filter stops it
        the first time a pass changes nothing. -#}
    {%- set why = {} -%}
    {%- set pass = namespace(changed=True) -%}
    {%- for _ in range(models | length) if pass.changed -%}
      {%- set pass.changed = False -%}
      {%- for node in models -%}
        {%- set feeders = contributors[node.unique_id] -%}
        {%- set reason = namespace(value=gaps[node.unique_id]) -%}
        {%- for dep in node.depends_on.nodes if not reason.value and dep not in feeders -%}
          {%- if dep in graph.nodes and not present.get(dep, True) -%}
            {%- set reason.value = 'reads ' ~ graph.nodes[dep].name ~ ', which is not built' -%}
          {%- endif -%}
        {%- endfor -%}
        {%- if feeders and not reason.value -%}
          {%- set fed = namespace(value=False) -%}
          {%- for dep in feeders if present.get(dep, False) -%}
            {%- set fed.value = True -%}
          {%- endfor -%}
          {%- if not fed.value -%}
            {%- set reason.value = 'no contributor tagged silver:' ~ (node.alias or node.name) ~ ' is built' -%}
          {%- endif -%}
        {%- endif -%}
        {%- do why.update({node.unique_id: reason.value}) -%}
        {%- if not reason.value and in_run.get(node.unique_id) and not present.get(node.unique_id, False) -%}
          {%- do present.update({node.unique_id: True}) -%}
          {%- set pass.changed = True -%}
        {%- endif -%}
      {%- endfor -%}
    {%- endfor -%}

    {%- for node in models if in_run.get(node.unique_id) and why[node.unique_id] -%}
      {%- do report.update({node.name: why[node.unique_id]}) -%}
      {{ log("unbuildable: " ~ node.name ~ " (" ~ why[node.unique_id] ~ ")", info=True) }}
    {%- endfor -%}
  {%- endif -%}
  {{ return(report) }}
{% endmacro %}

{#-
  bronze_tables()

  Every bronze table in the warehouse, `database.name` -> its row count. The
  count is system.tables' own `total_rows`, or none where the engine keeps no
  such count (`bronze_gap` counts those itself, only when a model reads one).
-#}
{% macro bronze_tables() %}
  {%- set tables = {} -%}
  {%- if execute -%}
    {%- set found = run_query(
          "SELECT database, name, total_rows FROM system.tables WHERE startsWith(database, 'bronze_')") -%}
    {%- for row in found.rows -%}
      {%- do tables.update({row[0] ~ '.' ~ row[1]: row[2]}) -%}
    {%- endfor -%}
  {%- endif -%}
  {{ return(tables) }}
{% endmacro %}

{#-
  bronze_gap(node, bronze, built)

  Why `node` cannot read its bronze, or '' when it can. `bronze` is what
  `bronze_tables()` returned; `built` says the model's relation already stands.

  Absent and empty bronze are both normal: a connector not configured here, or
  configured and not synced yet. A model is left out when
    - any bronze table it reads is absent: its query would not compile; or
    - it was never built and EVERY bronze table it reads holds no rows: the
      connector has not synced yet, so there is nothing to build, and an empty
      placeholder may not even accept the query (an empty plain MergeTree, as a
      full_refresh stream leaves it, refuses FINAL).
  A model reading SOME empty bronze beside bronze with rows is built: an empty
  side table (no inline comments, no group members yet) is ordinary data, and
  leaving the model out would drop the rows the other tables hold. So is one
  already built whose bronze has since emptied: it is rebuilt to match, rather
  than left holding rows its bronze no longer has. With the var
  `skip_empty_bronze` set to 'false', empty bronze never leaves a model out.
-#}
{% macro bronze_gap(node, bronze, built) %}
  {%- set absent = [] -%}
  {%- set empty = [] -%}
  {%- set fed = namespace(value=False) -%}
  {%- for dep in node.depends_on.nodes if dep in graph.sources -%}
    {%- set source = graph.sources[dep] -%}
    {%- if source.schema.startswith('bronze_') -%}
      {%- set key = source.schema ~ '.' ~ source.identifier -%}
      {%- if key not in bronze -%}
        {%- do absent.append(key) -%}
      {%- else -%}
        {%- if bronze[key] is none -%}
          {%- set counted = run_query("SELECT count() FROM (SELECT 1 FROM " ~ source.schema ~ "." ~ source.identifier ~ " LIMIT 1)") -%}
          {%- do bronze.update({key: counted.columns[0].values()[0]}) -%}
        {%- endif -%}
        {%- if bronze[key] > 0 -%}
          {%- set fed.value = True -%}
        {%- else -%}
          {%- do empty.append(key) -%}
        {%- endif -%}
      {%- endif -%}
    {%- endif -%}
  {%- endfor -%}
  {%- if absent -%}
    {{ return('bronze absent: ' ~ (absent | unique | sort | join(', '))) }}
  {%- elif empty and not fed.value and not built and (var('skip_empty_bronze', 'true') | string | lower) != 'false' -%}
    {{ return('bronze empty: ' ~ (empty | unique | sort | join(', '))) }}
  {%- endif -%}
  {{ return('') }}
{% endmacro %}

{#-
  relation_is_readable(node, bronze=none)

  Whether a consumer can read `node` right now — the per-model half of the
  judgement `unbuildable_models` makes over the whole graph, and the one
  `union_by_tag` asks of each contributor before unioning it. Both live here so
  the union and the exclusion cannot drift apart: a class kept in the run
  because ONE arm is healthy must still leave out the arms that are not.

  A table holds its rows and stays readable once its sources go. A view
  re-executes, so it is readable only while everything it reads is still there
  (bronze judged by `bronze_gap`); an ephemeral model has no relation at all and
  is inlined, so it answers for its parents instead — and, never built, for
  empty bronze too.
-#}
{% macro relation_is_readable(node, bronze=none) %}
  {%- if not execute -%}
    {{ return(False) }}
  {%- endif -%}
  {%- set bronze = bronze_tables() if bronze is none else bronze -%}
  {%- set materialization = node.config.materialized -%}
  {%- if materialization == 'ephemeral' -%}
    {{ return(reads_resolve(node, bronze, False)) }}
  {%- endif -%}
  {%- set relation = adapter.get_relation(
       database=none, schema=node.schema, identifier=node.alias or node.name) -%}
  {%- if relation is none -%}
    {{ return(False) }}
  {%- endif -%}
  {%- if materialization != 'view' -%}
    {{ return(True) }}
  {%- endif -%}
  {{ return(reads_resolve(node, bronze, True)) }}
{% endmacro %}

{#- Every relation `node`'s own query names, still resolvable. Bronze is the
    layer that goes missing; the rest a run creates for itself. -#}
{% macro reads_resolve(node, bronze, built) %}
  {%- if bronze_gap(node, bronze, built) -%}
    {{ return(False) }}
  {%- endif -%}
  {%- set ok = namespace(value=True) -%}
  {%- for dep in node.depends_on.nodes if ok.value and dep in graph.nodes -%}
    {%- if not relation_is_readable(graph.nodes[dep], bronze) -%}
      {%- set ok.value = False -%}
    {%- endif -%}
  {%- endfor -%}
  {{ return(ok.value) }}
{% endmacro %}
