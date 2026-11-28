#!/usr/bin/env bash
# Cut a warm installation over to the canonical tenant UUID the way the
# chart's hooks do (deploy/TENANT_IDENTITY_UPGRADE.md), and check every step.
#
#   1. Install BASE_SHA the way warm-upgrade-sim.sh does: its deploy hook, the
#      zoom Bronze its connector creates, and its sync of the identity map
#      views.
#   2. Hold the state a warm installation holds: Bronze, a history relation,
#      operator config and the sync ledger written under a legacy tenant that
#      is not a UUID, and identity inputs the previous release stamped with a
#      hashed tenant. The identity inputs model refuses to build over it.
#   3. The pre-upgrade hook's migration, failing part-way: every table is
#      back exactly as it was and no work table is left.
#   4. The pre-upgrade hook's migration, with no flag but INSIGHT_TENANT_ID:
#      nothing lost, tenant and keys moved, the tenant column renamed, the
#      sync ledger untouched, each original kept as its backup.
#   5. clickhouse-migrate (apply-ch-migrations.sh), which drops the identity
#      map views without a tenant column, then the post-upgrade rebuild with
#      `--full-refresh`: the identity inputs carry only the canonical tenant,
#      the map views are back, the history relation keeps every row.
#   6. A second deploy, after a sweep seal with an empty tenant, finds nothing
#      to migrate; `finalize` drops the backups.
#
# Required env (same contract as apply-ch-migrations.sh):
#   CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, CLICKHOUSE_DATABASE
#   BASE_SHA  — commit whose tree plays the already-installed release
# Optional env, for the destination-clickhouse container that creates bronze:
#   BRONZE_CLICKHOUSE_URL — the URL that container reaches ClickHouse at
#                           (default CLICKHOUSE_URL; 127.0.0.1 is not it)
# Needs python3 (3.11+), docker, jq, yq v4 and network access to PyPI; each
# phase gets its own venv pinned from its tree's pins.env.
set -euo pipefail

: "${BASE_SHA:?BASE_SHA must be set (the commit playing the installed release)}"
: "${CLICKHOUSE_URL:?}" "${CLICKHOUSE_USER:?}" "${CLICKHOUSE_PASSWORD:?}" "${CLICKHOUSE_DATABASE:?}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
SCRIPTS="$REPO_ROOT/src/ingestion/scripts"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

NEW_TENANT="0f6b3c2e-5d4a-4e7b-9c1d-2a3b4c5d6e7f"
OLD_TENANT="example-legacy"
SOURCE="zoom-main"
FIXTURES=(bronze_zoom.users staging.zoom__users_snapshot config.task_value_map)

# shellcheck source=src/ingestion/scripts/lib/ch-exec.sh
source "$SCRIPTS/lib/ch-exec.sh"

fail() {
  echo "::error title=tenant cutover::$1"
  exit 1
}

query() {
  printf '%s' "$1" | _ch_http_query | tr -d '\n'
}

migration() {
  (cd "$SCRIPTS" && python3 -m tenant_migration "$@")
}

PYTHON_BIN="$(command -v python3.12 || command -v python3.11 || command -v python3)"

dbt_venv_for() {
  local pins="$1" venv="$2"
  "$PYTHON_BIN" -m venv "$venv"
  "$venv/bin/pip" install --quiet \
    "dbt-core==$(grep '^DBT_CORE_VERSION=' "$pins" | cut -d= -f2)" \
    "dbt-clickhouse==$(grep '^DBT_CLICKHOUSE_VERSION=' "$pins" | cut -d= -f2)" pyyaml
}

# The zoom Bronze a first sync leaves: destination-clickhouse applying the
# connector's discovered catalogue, from the given tree's connector and pins.
create_zoom_bronze() {
  local tree="$1" url="${BRONZE_CLICKHOUSE_URL:-$CLICKHOUSE_URL}" protocol hostport port
  protocol="${url%%://*}"
  hostport="${url#*://}"; hostport="${hostport%%/*}"
  if [[ "$hostport" == *:* ]]; then
    port="${hostport##*:}"
  elif [[ "$protocol" == https ]]; then
    port=443
  else
    port=80
  fi
  local pins="$tree/src/ingestion/scripts/bootstrap-db/pins.env"
  CLICKHOUSE_PROTOCOL="$protocol" \
  CLICKHOUSE_HOST="${hostport%%:*}" \
  CLICKHOUSE_PORT="$port" \
  DESTINATION_CLICKHOUSE_IMAGE="$(grep '^DESTINATION_CLICKHOUSE_IMAGE=' "$pins" | cut -d= -f2)" \
  SOURCE_DECLARATIVE_MANIFEST_IMAGE="$(grep '^SOURCE_DECLARATIVE_MANIFEST_IMAGE=' "$pins" | cut -d= -f2)" \
    bash "$tree/src/ingestion/scripts/bootstrap-db/seed-connectors.sh" \
      "$tree/src/ingestion/scripts/bootstrap-db/connectors-config.yaml" zoom
}

# The previous release's sync of the identity map views and their buildable
# ancestors, with the base tree's dbt and profile. The zoom bronze is empty here,
# and a base with `bronze_gap` leaves out every never-built model over empty
# bronze; a synced installation's bronze holds rows.
build_base_identity_maps() {
  local tree="$1" path="$WORKDIR/base-venv/bin:$PATH" profiles="$WORKDIR/base-profiles" target="$WORKDIR/base-target"
  local project="$tree/src/ingestion/dbt" vars='{skip_empty_bronze: false}' unbuildable excluded=()
  mkdir -p "$profiles"
  PATH="$path" python3 "$tree/src/ingestion/scripts/dbt_profiles.py" --target migrate \
    --profiles-dir "$profiles" --correlated-subqueries
  unbuildable="$(cd "$project" && PATH="$path" dbt --quiet run-operation list_unbuildable_models \
    --profiles-dir "$profiles" --target-path "$target" --log-path "$target/logs" --vars "$vars")"
  read -r -a excluded <<< "$unbuildable"
  (cd "$project" && PATH="$path" dbt --no-use-colors run --profiles-dir "$profiles" \
    --target-path "$target" --log-path "$target/logs" --vars "$vars" --select +account_assignment +person_map \
    ${excluded[@]+--exclude "${excluded[@]}"})
}

# The installed release's dbt, over its own project: the warm state's shape.
dbt_base_run() {
  (cd "$BASE/src/ingestion/dbt" && PATH="$WORKDIR/base-venv/bin:$PATH" dbt run \
    --profiles-dir "$WORKDIR/base-profiles" --target-path "$WORKDIR/base-target" \
    --log-path "$WORKDIR/base-target/logs" "$@")
}

dbt_venv_for "$SCRIPTS/bootstrap-db/pins.env" "$WORKDIR/venv"
export PATH="$WORKDIR/venv/bin:$PATH"

DBT_PROFILES_DIR="$WORKDIR/profiles"
export DBT_PROFILES_DIR
mkdir -p "$DBT_PROFILES_DIR"
python3 "$SCRIPTS/dbt_profiles.py" --target migrate --correlated-subqueries --profiles-dir "$DBT_PROFILES_DIR"

dbt_run() {
  (cd "$REPO_ROOT/src/ingestion/dbt" && dbt run --profiles-dir "$DBT_PROFILES_DIR" "$@")
}

# Rows and a hash over every column: equal only when the table holds exactly
# the same rows.
fingerprint() {
  local relation
  for relation in "${FIXTURES[@]}"; do
    printf '%s=%s;' "$relation" "$(query "SELECT concat(toString(count()), ':', toString(groupBitXor(cityHash64(*)))) FROM $relation")"
  done
}

map_views() {
  query "SELECT arrayStringConcat(groupArray(concat(t.name, ':', toString(has(c.names, 'insight_tenant_id')))), ',') FROM
    (SELECT name FROM system.tables WHERE database = 'identity' AND name IN ('account_assignment', 'person_map') ORDER BY name) AS t
    LEFT JOIN (SELECT table, groupArray(name) AS names FROM system.columns WHERE database = 'identity' GROUP BY table) AS c
    ON c.table = t.name"
}

echo "=== Step 1: install base $(git -C "$REPO_ROOT" rev-parse --short "$BASE_SHA") ==="
BASE="$WORKDIR/base"
mkdir -p "$BASE"
git -C "$REPO_ROOT" archive "$BASE_SHA" src/ingestion | tar -x -C "$BASE"
dbt_venv_for "$BASE/src/ingestion/scripts/bootstrap-db/pins.env" "$WORKDIR/base-venv"
PATH="$WORKDIR/base-venv/bin:$PATH" bash "$BASE/src/ingestion/scripts/apply-ch-migrations.sh"
create_zoom_bronze "$BASE"
build_base_identity_maps "$BASE"
TENANT_COLUMN="$(ch_tenant_column bronze_zoom users)"
[[ "$TENANT_COLUMN" == tenant_id ]] \
  || echo "=== The base already names its tenant column $TENANT_COLUMN: the rename is a no-op here ==="
# The stamped source column, `source_id` until tenant_migration renames it.
SOURCE_COLUMN=source_id
[[ -z "$(ch_column_type bronze_zoom users insight_source_id)" ]] || SOURCE_COLUMN=insight_source_id

echo "=== Step 2: the warm state, under the legacy tenant '$OLD_TENANT' ==="
# Rows of the zoom users stream in the Bronze its connector created, with the
# columns the snapshot tracks; keys follow the connector's formula.
USER_COLUMNS="unique_key, $TENANT_COLUMN, $SOURCE_COLUMN, id, first_name, last_name, display_name, email, dept, status,
    role_id, timezone, language, phone_number, employee_unique_id, type,
    _airbyte_raw_id, _airbyte_extracted_at, _airbyte_meta, _airbyte_generation_id"
run_ch <<SQL
INSERT INTO bronze_zoom.users ($USER_COLUMNS) VALUES
    ('$OLD_TENANT-$SOURCE-u1', '$OLD_TENANT', '$SOURCE', 'u1', 'Ada', 'Example', 'Ada Example',
     'ada@example.com', 'Eng', 'active', '1', 'UTC', 'en', '', 'E-1', '1', 'raw-1', '2026-01-01 00:00:00', '{}', 0),
    ('$OLD_TENANT-$SOURCE-u2', '$OLD_TENANT', '$SOURCE', 'u2', 'Bo', 'Example', 'Bo Example',
     'bo@example.com', 'Ops', 'active', '1', 'UTC', 'en', '', 'E-2', '1', 'raw-2', '2026-01-01 00:00:00', '{}', 0),
    ('-$SOURCE-u3', NULL, '$SOURCE', 'u3', 'Cy', 'Example', 'Cy Example',
     'cy@example.com', 'Ops', 'active', '1', 'UTC', 'en', '', 'E-3', '1', 'raw-3', '2026-01-01 00:00:00', '{}', 0);
INSERT INTO ingestion_history.sync_events (tick_id, job_id, connector, tenant_id, source_id, event, status)
VALUES ('tick-1', 'job-1', 'zoom', '$OLD_TENANT', '$SOURCE', 'sync', 'succeeded');
SQL

dbt_base_run --select zoom__users_snapshot zoom__users_fields_history

# The config tables come from dbt's on-run-start, which the deploy no longer runs.
CONFIG_TENANT_COLUMN="$(ch_tenant_column config task_value_map)"
run_ch <<SQL
INSERT INTO config.task_value_map ($CONFIG_TENANT_COLUMN, insight_source_id, data_source, field_id, value_id, valid_from, recorded_at, canonical_value)
VALUES ('$OLD_TENANT', 'jira-main', 'insight_jira', 'status', '10001', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'done');
SQL

# A second observation of u1, so the history relation holds two versions.
run_ch <<SQL
INSERT INTO bronze_zoom.users ($USER_COLUMNS) VALUES
    ('$OLD_TENANT-$SOURCE-u1', '$OLD_TENANT', '$SOURCE', 'u1', 'Ada', 'Example', 'Ada Example',
     'ada@example.com', 'Research', 'active', '1', 'UTC', 'en', '', 'E-1', '1', 'raw-4', '2026-01-02 00:00:00', '{}', 0);
SQL
dbt_base_run --select zoom__users_snapshot

# A base before #3661 hashes the legacy tenant into the identity inputs; one
# after it refuses the legacy tenant. Either way the rebuild must replace them.
dbt_base_run --select zoom__identity_inputs >"$WORKDIR/base-inputs.log" 2>&1 || true

# What the previous release left in the identity inputs: the tenant hashed. The
# base sync built the relation; its producer refuses the legacy tenant, so both
# are run empty and the relation is given that row.
dbt_base_run --empty --select zoom__identity_inputs identity_inputs
run_ch <<SQL
INSERT INTO identity.identity_inputs (unique_key, insight_tenant_id, insight_source_id, insight_source_type,
    source_account_id, value_type, value, value_field_name, operation_type, _synced_at, _version)
VALUES ('$OLD_TENANT-$SOURCE-zoom-u1-email-UPSERT-1', toUUID(UUIDNumToString(sipHash128('$OLD_TENANT'))),
    toUUID(UUIDNumToString(sipHash128('$SOURCE'))), 'zoom', 'u1', 'email', 'ada@example.com',
    'bronze_zoom.users.email', 'UPSERT', '2026-01-01 00:00:00', 1);
SQL

# Merged up front: a background merge must not change a fingerprint.
run_ch <<<"OPTIMIZE TABLE bronze_zoom.users FINAL"
WARM="$(fingerprint)"
SNAPSHOT_ROWS="$(query "SELECT count() FROM staging.zoom__users_snapshot")"
[[ "$SNAPSHOT_ROWS" == "4" ]] || fail "the warm history relation holds $SNAPSHOT_ROWS rows, expected 4 (three users, u1 twice)"

export INSIGHT_TENANT_ID="$NEW_TENANT"
migration plan --exit-code >/dev/null && fail "the plan finds nothing to migrate in the warm state"

echo "=== Step 3: a migration that fails part-way puts every table back ==="
(cd "$SCRIPTS" && python3 - <<'PY'
from dataclasses import dataclass, field

from tenant_migration import apply as migration
from tenant_migration.clickhouse import ClickHouse
from tenant_migration.inventory import discover, history_relations
from tenant_migration.plan import survey
import os


@dataclass(frozen=True)
class FailsAtTheThirdSwap(ClickHouse):
    swaps: list[str] = field(default_factory=list)

    def execute(self, sql: str, *, fmt: str | None = None, params: dict[str, str] | None = None) -> str:
        if sql.startswith("EXCHANGE TABLES"):
            self.swaps.append(sql)
            if len(self.swaps) == 3:
                raise RuntimeError("injected failure at the third swap")
        return super().execute(sql, fmt=fmt, params=params)


env = ClickHouse.from_env()
ch = FailsAtTheThirdSwap(url=env.url, user=env.user, password=env.password)
tenant = os.environ["INSIGHT_TENANT_ID"]
try:
    migration.apply(ch, survey(ch, discover(ch, history_relations()), tenant), tenant)
except migration.MigrationError as error:
    print(f"failed as injected: {error}")
else:
    raise SystemExit("the injected failure did not stop the migration")
PY
)
[[ "$(fingerprint)" == "$WARM" ]] || fail "a failed migration did not put the warm tables back exactly: '$(fingerprint)' != '$WARM'"
leftovers="$(query "SELECT count() FROM system.tables WHERE position(name, '__tenant_') > 0")"
[[ "$leftovers" == "0" ]] || fail "a failed migration left $leftovers work table(s) behind"

echo "=== Step 4: the pre-upgrade hook's migration ==="
migration plan | tee "$WORKDIR/plan.txt"
for relation in "${FIXTURES[@]}"; do
  grep -q "^$relation " "$WORKDIR/plan.txt" || fail "the plan does not list $relation"
done
migration apply

assert_migrated() {
  local got expected="4:0:3|3:3|1:0|1:0|$NEW_TENANT-$SOURCE-u1"
  got="$(query "SELECT concat(
      toString((SELECT count() FROM staging.zoom__users_snapshot)), ':',
      toString((SELECT countIf(insight_tenant_id != '$NEW_TENANT' OR NOT startsWith(unique_key, '$NEW_TENANT-$SOURCE-')) FROM staging.zoom__users_snapshot)), ':',
      toString((SELECT uniqExact(unique_key) FROM staging.zoom__users_snapshot)), '|',
      toString((SELECT count() FROM bronze_zoom.users)), ':',
      toString((SELECT countIf(insight_tenant_id = '$NEW_TENANT' AND startsWith(unique_key, '$NEW_TENANT-$SOURCE-')) FROM bronze_zoom.users FINAL)), '|',
      toString((SELECT count() FROM config.task_value_map)), ':',
      toString((SELECT countIf(insight_tenant_id != '$NEW_TENANT' OR NOT startsWith(unique_key, '$NEW_TENANT')) FROM config.task_value_map)), '|',
      toString((SELECT count() FROM ingestion_history.sync_events)), ':',
      toString((SELECT countIf(tenant_id != '$OLD_TENANT') FROM ingestion_history.sync_events)), '|',
      (SELECT min(unique_key) FROM bronze_zoom.users WHERE id = 'u1'))")"
  [[ "$got" == "$expected" ]] || fail "after apply expected '$expected' — every row kept, each tenant column and key prefix on $NEW_TENANT, the row without a tenant moved too, the sync ledger untouched — but got '$got'"
}
assert_migrated
got="$(query "SELECT concat(
    toString((SELECT count() FROM system.columns WHERE database = 'bronze_zoom' AND table = 'users' AND name = 'insight_source_id')),
    toString((SELECT count() FROM system.columns WHERE database = 'bronze_zoom' AND table = 'users' AND name = 'source_id')),
    toString((SELECT count() FROM system.columns WHERE database = 'ingestion_history' AND table = 'sync_events' AND name = 'source_id')))")"
[[ "$got" == "101" ]] \
  || fail "after apply bronze must name its source insight_source_id (and no source_id) while the ledger keeps source_id — got '$got' (bronze new, bronze old, ledger old)"
backups="$(query "SELECT count() FROM system.tables WHERE endsWith(name, '__tenant_backup')")"
(( backups >= ${#FIXTURES[@]} )) || fail "expected a backup of every migrated table, found $backups"

echo "=== Step 5: clickhouse-migrate, then the post-upgrade rebuild ==="
bash "$SCRIPTS/apply-ch-migrations.sh"
[[ "$(map_views)" != *:0* ]] \
  || fail "the deploy must drop identity map views without a tenant column, so analytics answers not-ready until the rebuild recreates them — got '$(map_views)'"

# Gold is left out: its views read the evidence of every connector class, and
# this warm state synced only one.
dbt_run --full-refresh --select zoom__users_snapshot+ tag:sync:always --exclude tag:gold

[[ "$(map_views)" == "account_assignment:1,person_map:1" ]] \
  || fail "the rebuild must recreate the identity map views keyed by tenant — got '$(map_views)'"

got="$(query "SELECT concat(
    toString(count()), ':',
    toString(countIf(toString(insight_tenant_id) != '$NEW_TENANT')), ':',
    toString(countIf(value = 'ada@example.com')), ':',
    toString(countIf(value = 'cy@example.com')), '|',
    toString((SELECT count() FROM staging.zoom__users_snapshot)))
  FROM identity.identity_inputs FINAL WHERE value_type = 'email'")"
[[ "$got" =~ ^[1-9][0-9]*:0:[1-9][0-9]*:[1-9][0-9]*\|4$ ]] \
  || fail "after the rebuild expected the email identity inputs all under $NEW_TENANT (the hashed-tenant row gone, every user present) and the history relation, which refuses a full refresh, still holding its 4 rows — got '$got' (inputs:foreign:ada:cy|history)"

echo "=== Step 6: the next deploy finds nothing; finalize drops the backups ==="
# Reconcile's sweep seals every tick with an empty tenant; that must not make the next deploy a cutover.
run_ch <<<"INSERT INTO ingestion_history.sync_events (tick_id, event) VALUES ('tick-2', 'sweep.completed')"
migration plan --exit-code >/dev/null || fail "a second plan still finds tables to migrate"
migration apply
migration finalize
leftovers="$(query "SELECT count() FROM system.tables WHERE position(name, '__tenant_') > 0")"
[[ "$leftovers" == "0" ]] || fail "finalize left $leftovers work table(s) behind"

echo "=== Tenant cutover OK: a failed run restores exactly, nothing lost, keys moved, rebuild on the canonical tenant ==="
