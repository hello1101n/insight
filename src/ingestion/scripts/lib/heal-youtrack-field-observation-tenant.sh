# shellcheck shell=bash
# Sourced by apply-ch-migrations.sh after lib/ch-exec.sh.

# The append-only observations predate their tenant column and cannot be
# rebuilt. A row's key leads with the tenant it was written under followed by
# its source, so the tenant is read back from the key against the tenants
# Bronze holds, longest first; a row matching none keeps NULL for the tenant
# migration to move. Idempotent: only NULL tenants are written.

# Prints 1 or 0; fails when the probe cannot be read, so an unreachable
# ClickHouse stops the deploy instead of reading as an absent table.
_youtrack_table_present() {
  local count
  count="$(ch_scalar "SELECT count() FROM system.tables WHERE database = '$1' AND name = '$2'")" || {
    echo "ERROR: cannot tell whether $1.$2 exists" >&2
    return 1
  }
  printf '%s' "${count}"
}

# INVARIANT: repairs releases without #3885 (main before its first release); delete once every CH_FLOOR_RELEASES release runs it.
heal_youtrack_field_observation_tenant() {
  local present tenants column bronze_column
  present="$(_youtrack_table_present staging youtrack__field_observations)" || return 1
  [[ "${present}" -gt 0 ]] || return 0
  echo "  staging.youtrack__field_observations"
  # A history relation: until `tenant_migration` renames it, its tenant column is `tenant_id`.
  column="$(ch_tenant_column staging youtrack__field_observations)" || return 1
  run_ch <<SQL
ALTER TABLE staging.youtrack__field_observations ADD COLUMN IF NOT EXISTS ${column} Nullable(String) AFTER unique_key;
ALTER TABLE staging.youtrack__field_observations MODIFY COLUMN ${column} Nullable(String) AFTER unique_key;
SQL

  present="$(_youtrack_table_present bronze_youtrack youtrack_custom_fields)" || return 1
  [[ "${present}" -gt 0 ]] || return 0
  bronze_column="$(ch_tenant_column bronze_youtrack youtrack_custom_fields)" || return 1
  tenants="$(printf '%s' "SELECT arrayReverseSort(t -> length(t), groupUniqArray(assumeNotNull(${bronze_column}))) FROM bronze_youtrack.youtrack_custom_fields WHERE ${bronze_column} IS NOT NULL FORMAT TabSeparatedRaw" | _ch_http_query)" || return 1
  # SAFETY: run_ch splits statements on `;`, so a tenant carrying one is refused rather than split.
  [[ "${tenants}" == \[*\] && "${tenants}" != *';'* ]] || { echo "ERROR: unreadable YouTrack tenants: ${tenants}" >&2; return 1; }
  [[ "${tenants}" != "[]" ]] || return 0
  run_ch <<SQL
ALTER TABLE staging.youtrack__field_observations UPDATE ${column} = nullIf(arrayFirst(t -> startsWith(unique_key, concat(t, '-', insight_source_id, '-')), ${tenants}), '') WHERE ${column} IS NULL SETTINGS mutations_sync = 2;
SQL
}
