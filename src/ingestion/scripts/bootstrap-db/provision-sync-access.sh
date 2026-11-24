#!/usr/bin/env bash
set -euo pipefail

user="${CLICKHOUSE_SYNC_USER:-}"
[[ -n "$user" ]] || exit 0

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
source "$SCRIPT_DIR/../lib/ch-exec.sh"

: "${CLICKHOUSE_SYNC_PASSWORD:?Set CLICKHOUSE_SYNC_PASSWORD}"
: "${CLICKHOUSE_DATABASE:?Set CLICKHOUSE_DATABASE}"
total="${CLICKHOUSE_SYNC_TOTAL_MEMORY_BYTES:?Set CLICKHOUSE_SYNC_TOTAL_MEMORY_BYTES}"
per_query="${CLICKHOUSE_SYNC_QUERY_MEMORY_BYTES:-}"

if [[ ! "$user" =~ ^[A-Za-z_][A-Za-z0-9_]*$ || "$user" == "$CLICKHOUSE_USER" ]]; then
  echo "Specify a dedicated ClickHouse sync user." >&2
  exit 1
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
