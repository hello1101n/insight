#!/usr/bin/env bash
set -euo pipefail

user="${CLICKHOUSE_SYNC_USER:-}"
[[ -n "$user" ]] || exit 0

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
source "$SCRIPT_DIR/../lib/ch-exec.sh"

read_server_memory_limit() {
  local metrics_query query
  metrics_query="SELECT
    maxIf(toUInt64OrZero(value), name = 'max_server_memory_usage') AS server,
    maxIf(toFloat64OrZero(value), name = 'max_server_memory_usage_to_ram_ratio') AS ratio,
    (SELECT toUInt64(max(value)) FROM system.asynchronous_metrics WHERE metric = 'OSMemoryTotal') AS host_memory
    FROM system.server_settings WHERE name IN ('max_server_memory_usage', 'max_server_memory_usage_to_ram_ratio')"
  query="$metrics_query"
  if ch_cluster_mode; then
    query="SELECT * FROM clusterAllReplicas('${CLICKHOUSE_CLUSTER_NAME:?Set CLICKHOUSE_CLUSTER_NAME}', view($metrics_query))
      SETTINGS skip_unavailable_shards = 1"
  fi

  printf '%s FORMAT TabSeparated' "$query" | _ch_http_query | LC_ALL=C awk -F '\t' '
    NF != 3 || $1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$/ ||
        $3 !~ /^[0-9]+$/ || $1 < 4 || $2 <= 0 || $3 <= 0 {
      invalid = 1
      next
    }
    $1 >= $2 * $3 * 0.99 { unlimited = 1 }
    !minimum || $1 + 0 < minimum + 0 { minimum = $1 }
    END {
      if (unlimited) exit 2
      if (invalid || !minimum) exit 1
      print minimum
    }
  '
}

if [[ -z "${CLICKHOUSE_SYNC_PASSWORD:-}" ]]; then
  echo "The ClickHouse sync password is missing from its Secret." >&2
  exit 1
fi
: "${CLICKHOUSE_DATABASE:?Set CLICKHOUSE_DATABASE}"
total="${CLICKHOUSE_SYNC_TOTAL_MEMORY_BYTES:-}"
per_query="${CLICKHOUSE_SYNC_QUERY_MEMORY_BYTES:-}"

if [[ ! "$user" =~ ^[A-Za-z_][A-Za-z0-9_]*$ || "$user" == "$CLICKHOUSE_USER" ]]; then
  echo "Specify a dedicated ClickHouse sync user." >&2
  exit 1
fi
if [[ -z "$total" ]]; then
  server="$(read_server_memory_limit)" || {
    if [[ "$?" -eq 2 ]]; then
      echo "ClickHouse runs without a memory limit. Set clickhouse.syncUser.totalMemoryBytes." >&2
    else
      echo "The ClickHouse server memory limit read failed." >&2
    fi
    exit 1
  }
  total=$((server / 5 * 3 + server % 5 * 3 / 5))
fi
if [[ ! "$total" =~ ^[1-9][0-9]{0,17}$ ]] || (( total < 2 )) ||
  { [[ -n "$per_query" ]] && { [[ ! "$per_query" =~ ^[1-9][0-9]{0,17}$ ]] || (( per_query < 2 )); }; }; then
  echo "Specify valid ClickHouse sync memory limits in bytes." >&2
  exit 1
fi
if [[ "$CLICKHOUSE_SYNC_PASSWORD" == *$'\n'* || "$CLICKHOUSE_SYNC_PASSWORD" == *$'\r'* ]]; then
  echo "The ClickHouse sync password contains a line break." >&2
  exit 1
fi

password="${CLICKHOUSE_SYNC_PASSWORD//\\/\\\\}"
password="${password//\'/\\\'}"
database="${CLICKHOUSE_DATABASE//\\/\\\\}"
database="${database//\`/\\\`}"
settings="max_memory_usage_for_user = $total CONST, memory_usage_overcommit_max_wait_microseconds = 0"
if [[ -n "$per_query" ]]; then
  spill=$((per_query / 2))
  settings+=", max_memory_usage = $per_query,
    max_bytes_before_external_group_by = $spill, max_bytes_before_external_sort = $spill,
    max_bytes_ratio_before_external_group_by = 0, max_bytes_ratio_before_external_sort = 0"
fi
auth="IDENTIFIED WITH sha256_password BY '$password'"

printf 'CREATE USER IF NOT EXISTS `%s` %s SETTINGS %s' "$user" "$auth" "$settings" | _ch_http_query
if ! login_error="$(printf 'SELECT 1' | CLICKHOUSE_USER="$user" CLICKHOUSE_PASSWORD="$CLICKHOUSE_SYNC_PASSWORD" _ch_http_query 2>/dev/null)"; then
  if [[ "$login_error" != "Code: 516."* ]]; then
    echo "The ClickHouse sync login check failed." >&2
    exit 1
  fi
  printf 'ALTER USER `%s` %s' "$user" "$auth" | _ch_http_query
fi
printf 'ALTER USER `%s` SETTINGS %s' "$user" "$settings" | _ch_http_query

table_access='SELECT, INSERT, CREATE TABLE, ALTER TABLE, DROP TABLE'
dbt_access="$table_access, CREATE VIEW, DROP VIEW, TRUNCATE"
printf 'GRANT CREATE DATABASE, %s, TRUNCATE ON bronze_*.* TO `%s`' "$table_access" "$user" | _ch_http_query
for target in staging silver identity "$database"; do
  printf 'GRANT %s ON `%s`.* TO `%s`' "$dbt_access" "$target" "$user" | _ch_http_query
done
printf 'GRANT CREATE DATABASE, SELECT, INSERT, CREATE TABLE, DROP TABLE ON dbt_test__audit.* TO `%s`' "$user" | _ch_http_query
for table in task_field_roles task_value_map field_value_map field_value_defaults ai_seat_tier_map ai_credit_pricing; do
  printf 'GRANT CREATE TABLE ON config.%s TO `%s`' "$table" "$user" | _ch_http_query
done
for target in 'config.*' system.databases system.tables system.columns; do
  printf 'GRANT SELECT ON %s TO `%s`' "$target" "$user" | _ch_http_query
done
if ch_cluster_mode; then
  printf 'GRANT CLUSTER, REMOTE ON *.* TO `%s`' "$user" | _ch_http_query
fi
