#!/usr/bin/env bash
# state_backup_* — the sync state of a connection torn down by a definition
# migration, kept in the K8s Secret RECONCILE_STATE_BACKUP_SECRET until the
# replacement connection holds it (sourceable; NO top-level CLI).
# NOTE: this file is sourced; no top-level `set -euo pipefail`.
#
# One key per source name: the name is what survives the migration, and a
# definition can bind several sources. The chart creates the Secret empty, so
# reconcile needs only `patch` on that one name, never `create` on Secrets.

state_backup__key() {
  printf '%s' "$1" | tr -c '[:alnum:]._-' '_'
}

state_backup__secret() {
  printf '%s' "${RECONCILE_STATE_BACKUP_SECRET:?RECONCILE_STATE_BACKUP_SECRET must name the Secret that holds state backups}"
}

state_backup__patch() {
  kubectl -n "${INSIGHT_NAMESPACE:?}" patch secret "$(state_backup__secret)" \
    --type merge --patch-file /dev/stdin >/dev/null
}

# state_backup_get <source_name>
# Prints the stored state, or nothing when no backup exists. Fails when the
# Secret cannot be read: callers must not read that as "no backup".
state_backup_get() {
  local key secret_json
  key="$(state_backup__key "$1")"
  secret_json="$(kubectl -n "${INSIGHT_NAMESPACE:?}" get secret "$(state_backup__secret)" -o json)" || return 1
  printf '%s' "${secret_json}" | python3 -c '
import base64, json, sys
value = (json.load(sys.stdin).get("data") or {}).get(sys.argv[1])
if value:
    sys.stdout.write(base64.b64decode(value).decode("utf-8"))
' "${key}"
}

# state_backup_put <source_name>   (state JSON on stdin)
# Stores the state and reads it back. A backup that does not read back equal
# is a failure, because the caller deletes the only other copy next.
state_backup_put() {
  local source_name="$1" key state stored
  key="$(state_backup__key "${source_name}")"
  state="$(cat)"
  [[ -n "${state}" ]] || return 1

  printf '%s' "${state}" | python3 -c '
import base64, json, sys
print(json.dumps({"data": {sys.argv[1]: base64.b64encode(sys.stdin.buffer.read()).decode("ascii")}}))
' "${key}" | state_backup__patch || return 1

  stored="$(state_backup_get "${source_name}")" || return 1
  [[ "${stored}" == "${state}" ]]
}

# state_backup_drop <source_name>
state_backup_drop() {
  local key
  key="$(state_backup__key "$1")"
  printf '{"data":{"%s":null}}' "${key}" | state_backup__patch
}
