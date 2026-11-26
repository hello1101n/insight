#!/usr/bin/env bash
# staging.jira__catalogue_first_seen was a plain MergeTree keyed by source. The
# model is now a ReplacingMergeTree keyed by tenant and source that refuses a
# full refresh, and dbt never re-creates a relation that already stands, so the
# old table is rebuilt into the new shape here. Its rows exist nowhere else —
# bronze forgets the first extraction as its parts merge — so this is a copy,
# counted against the original, swapped in, counted again, and only then is the
# original dropped. The tenant is the one the pre-upgrade tenant_migration
# stamped on the old table; without it, it comes from the source's bronze rows,
# a source bronze no longer holds keeps an empty tenant, and a source bronze
# holds under more than one tenant refuses the heal.
#
# Guarded on the exact engine the topology needs, so a converged warehouse pays
# one SELECT and a table left on the wrong family is rebuilt. Column order and
# types are the model's: dbt appends to this table positionally.
#
# Sourced by apply-ch-migrations.sh after lib/ch-topology.sh.

_catalogue_source_count() {
  ch_scalar "SELECT uniqExact(insight_source_id) FROM staging.$1"
}

# SAFETY: an unreadable probe must stop the heal. Read as "no bronze", it would
# copy every source with an empty tenant, and the swapped-in table would then
# pass the engine guard on every later deploy.
_catalogue_tenants_select() {
  local bronze
  local shared
  local tenant=insight_tenant_id source=insight_source_id
  bronze="$(ch_scalar "SELECT count() FROM system.tables WHERE database = 'bronze_jira' AND name = 'jira_fields'")" || return 1
  if [[ "${bronze}" -eq 0 ]]; then
    echo "SELECT '' AS insight_source_id, '' AS insight_tenant_id WHERE 0"
    return 0
  fi
  # tenant_migration renames bronze's source column before this runs; a bronze it did not touch keeps the old name.
  [[ -n "$(ch_column_type bronze_jira jira_fields insight_source_id)" ]] || source=source_id
  shared="$(ch_scalar "SELECT count() FROM (
      SELECT COALESCE(${source}, '') AS insight_source_id
      FROM bronze_jira.jira_fields
      WHERE COALESCE(${source}, '') IN (SELECT insight_source_id FROM staging.jira__catalogue_first_seen)
      GROUP BY insight_source_id
      HAVING uniqExact(COALESCE(${tenant}, '')) > 1
    )")" || return 1
  if [[ "${shared}" -ne 0 ]]; then
    echo "  staging.jira__catalogue_first_seen: ${shared} source(s) appear in bronze under several tenants — refusing to guess whose boundary each row is" >&2
    return 1
  fi
  echo "SELECT DISTINCT COALESCE(${source}, '') AS insight_source_id, COALESCE(${tenant}, '') AS insight_tenant_id
          FROM bronze_jira.jira_fields"
}

# INVARIANT: repairs releases without #3795 (main before 0.7.140); delete once every CH_FLOOR_RELEASES release runs it.
heal_jira_catalogue_first_seen() {
  local table="staging.jira__catalogue_first_seen" copy="staging.jira__catalogue_first_seen__rebuild"
  local engine converged before tenants copied live own="''"

  ch_table_exists staging jira__catalogue_first_seen || return 0
  engine="$(ch_replicated_prefix)ReplacingMergeTree"
  converged="$(ch_scalar "SELECT count() FROM system.tables
    WHERE database = 'staging' AND name = 'jira__catalogue_first_seen' AND engine = '${engine}'")" || return 1
  [[ "${converged}" -eq 0 ]] || return 0

  before="$(_catalogue_source_count jira__catalogue_first_seen)" || return 1
  tenants="$(_catalogue_tenants_select)" || return 1
  if [[ -n "$(ch_column_type staging jira__catalogue_first_seen insight_tenant_id)" ]]; then
    own="ifNull(any(insight_tenant_id), '')"
  fi
  echo "  ${table}: rebuilding ${before} source(s) as a ${engine} keyed by tenant and source"
  run_ch <<SQL || return 1
DROP TABLE IF EXISTS ${copy};
CREATE TABLE ${copy}
(
    unique_key String,
    insight_tenant_id String,
    insight_source_id String,
    catalogue_first_sync DateTime64(3),
    recorded_at DateTime64(3),
    _version UInt64
)
ENGINE = ${engine}(_version)
ORDER BY unique_key
SETTINGS replicated_deduplication_window = 0;
INSERT INTO ${copy}
SELECT concat(tenant, '-', insight_source_id), tenant, insight_source_id, catalogue_first_sync, recorded_at, version
FROM
(
    SELECT
        if(c.own_tenant != '', c.own_tenant, t.insight_tenant_id) AS tenant,
        c.insight_source_id AS insight_source_id,
        c.catalogue_first_sync AS catalogue_first_sync,
        c.recorded_at AS recorded_at,
        toUInt64(4102444800000 - toUnixTimestamp64Milli(c.catalogue_first_sync)) AS version
    FROM
    (
        SELECT insight_source_id, min(catalogue_first_sync) AS catalogue_first_sync, min(recorded_at) AS recorded_at,
               ${own} AS own_tenant
        FROM ${table}
        GROUP BY insight_source_id
    ) AS c
    LEFT JOIN (${tenants}) AS t ON t.insight_source_id = c.insight_source_id
);
SQL

  copied="$(_catalogue_source_count jira__catalogue_first_seen__rebuild)" || return 1
  if [[ "${copied}" -lt "${before}" ]]; then
    echo "  ${table}: copy holds ${copied} source(s), expected at least ${before} — leaving the table as it is" >&2
    run_ch <<SQL
DROP TABLE IF EXISTS ${copy};
SQL
    return 1
  fi

  run_ch <<SQL || return 1
EXCHANGE TABLES ${table} AND ${copy};
SQL
  if ! live="$(_catalogue_source_count jira__catalogue_first_seen)" || [[ "${live}" -lt "${before}" ]]; then
    echo "  ${table}: rebuilt table holds ${live:-?} source(s), expected ${before} — swapping the original back" >&2
    run_ch <<SQL
EXCHANGE TABLES ${table} AND ${copy};
SQL
    return 1
  fi

  run_ch <<SQL
DROP TABLE IF EXISTS ${copy};
SQL
}
