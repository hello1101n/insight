#!/usr/bin/env bash
# The tenant cutover, run by the chart's hooks so a deploy needs no step by hand.
#
#   tenant-cutover.sh pre     pre-install/pre-upgrade hook: when tenant_migration
#                             has work, record every writer's suspend state in a
#                             ConfigMap, suspend them, wait until nothing runs,
#                             migrate. Nothing to do: exits at once, suspends nothing.
#   tenant-cutover.sh post    post-install/post-upgrade hook: when the ConfigMap
#                             exists, submit one background full-refresh rebuild
#                             (the tenant-cutover-rebuild WorkflowTemplate). Does
#                             not wait for it.
#   tenant-cutover.sh seed    rebuild step: run the identity seed once, from its CronJob.
#   tenant-cutover.sh resume  last rebuild step: restore the recorded suspend
#                             state and delete the ConfigMap.
#
# The ConfigMap is the one piece of state: while it exists, a rebuild is owed
# and the writers stay suspended. Only the rebuild's last step deletes it, so a
# sync can never run between the migration and the end of the rebuild. A
# failed `pre` that suspended the writers itself puts them back: the tables
# are back as they were and the previous release keeps running.
#
# Env: INSIGHT_NAMESPACE, CUTOVER_CONFIGMAP, INSIGHT_TENANT_ID; for `pre` also
# CLICKHOUSE_URL/USER/PASSWORD, AIRBYTE_URL and the AIRBYTE_AUTH_* of
# reconcile, IDLE_TIMEOUT_SECONDS; for `post` REBUILD_TEMPLATE, ARGO_INSTANCE_ID.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECONCILE_LIB="${RECONCILE_LIB:-$SCRIPT_DIR/../reconcile-connectors/lib}"
: "${INSIGHT_NAMESPACE:?}" "${CUTOVER_CONFIGMAP:?}"

REBUILD_LABEL="insight.cyberfabric.com/tenant-cutover"
SEED_SELECTOR="app.kubernetes.io/component=persons-seed"
POLL_SECONDS="${POLL_SECONDS:-20}"
# Overridable for tests only.
TENANT_MIGRATION="${TENANT_MIGRATION:-python3 -m tenant_migration}"

log() { printf 'tenant-cutover: %s\n' "$*"; }
err() { printf 'tenant-cutover: ERROR: %s\n' "$*" >&2; }
k() { kubectl -n "$INSIGHT_NAMESPACE" "$@"; }

cm_exists() { k get configmap "$CUTOVER_CONFIGMAP" -o name >/dev/null 2>&1; }

# Every CronWorkflow in the namespace (reconcile, data quality, each connection's
# sync) and the identity seed CronJob, with the suspend state each has now.
writer_state() {
  local workflows jobs
  workflows="$(k get cronworkflows -o json)" || return 1
  jobs="$(k get cronjobs -l "$SEED_SELECTOR" -o json)" || return 1
  jq -n --argjson w "$workflows" --argjson j "$jobs" '{
    cronworkflows: [$w.items[] | {
      name: .metadata.name,
      suspend: (.spec.suspend // false),
      component: (.metadata.labels["app.kubernetes.io/component"] // ""),
      tenant: (.metadata.labels["insight.cyberfabric.com/tenant"] // "")}],
    cronjobs: [$j.items[] | {name: .metadata.name, suspend: (.spec.suspend // false)}]}'
}

recorded_state() { k get configmap "$CUTOVER_CONFIGMAP" -o jsonpath='{.data.state\.json}'; }

set_suspend() {  # kind name true|false
  k patch "$1" "$2" --type merge -p "{\"spec\":{\"suspend\":$3}}" >/dev/null
}

suspend_writers() {
  local state workflows cronjobs name
  state="$(writer_state)" || return 1
  workflows="$(jq -r '.cronworkflows[].name' <<<"$state")" || return 1
  cronjobs="$(jq -r '.cronjobs[].name' <<<"$state")" || return 1
  for name in $workflows; do
    set_suspend cronworkflow "$name" true || return 1
    log "suspended cronworkflow/$name"
  done
  for name in $cronjobs; do
    set_suspend cronjob "$name" true || return 1
    log "suspended cronjob/$name"
  done
}

# Back to the recorded state. With `all` (a failed `pre`: the previous release
# keeps running) every writer is. After the cutover (`resume`), a connection's
# sync schedule named for another tenant stays suspended: it still syncs with
# that tenant's Airbyte config, and reconcile's next tick replaces it with one
# named for this tenant.
restore_writers() {
  local mode="$1" state resume skip cronjobs name
  state="$(recorded_state)" || return 1
  resume="$(jq -r --arg t "$INSIGHT_TENANT_ID" --arg mode "$mode" '.cronworkflows[] | select(.suspend == false
      and ($mode == "all" or .component != "connector-sync" or .tenant == $t)) | .name' <<<"$state")" || return 1
  skip="$(jq -r --arg t "$INSIGHT_TENANT_ID" --arg mode "$mode" '.cronworkflows[] | select(.suspend == false
      and $mode != "all" and .component == "connector-sync" and .tenant != $t) | .name' <<<"$state")" || return 1
  cronjobs="$(jq -r '.cronjobs[] | select(.suspend == false) | .name' <<<"$state")" || return 1
  for name in $resume; do
    if k get cronworkflow "$name" -o name >/dev/null 2>&1; then
      set_suspend cronworkflow "$name" false || return 1
      log "resumed cronworkflow/$name"
    fi
  done
  for name in $skip; do
    log "left cronworkflow/$name suspended: reconcile replaces it with the schedule named for $INSIGHT_TENANT_ID"
  done
  for name in $cronjobs; do
    if k get cronjob "$name" -o name >/dev/null 2>&1; then
      set_suspend cronjob "$name" false || return 1
      log "resumed cronjob/$name"
    fi
  done
}

running_workflows() {
  k get workflows -o json | jq -r '[.items[]
    | select((.status.phase // "") as $p | $p == "" or $p == "Pending" or $p == "Running")
    | .metadata.name] | join(" ")'
}

# Airbyte jobs pending, running or between attempts, counted through the public API.
airbyte_active_jobs() {
  # shellcheck source=src/ingestion/reconcile-connectors/lib/airbyte.sh
  source "$RECONCILE_LIB/airbyte.sh"
  local status total=0 n
  for status in pending running incomplete; do
    n="$(ab__curl GET "/api/public/v1/jobs?status=${status}&limit=100" | jq '.data | length')" || return 1
    total=$((total + n))
  done
  printf '%s' "$total"
}

wait_idle() {
  local timeout="${IDLE_TIMEOUT_SECONDS:-1800}" deadline workflows jobs
  deadline=$((SECONDS + timeout))
  while :; do
    workflows="$(running_workflows)" || workflows="(cannot list workflows)"
    jobs="$(airbyte_active_jobs)" || jobs="(Airbyte unreachable)"
    if [[ -z "$workflows" && "$jobs" == "0" ]]; then
      log "idle: no workflow running, no Airbyte job active"
      return 0
    fi
    if (( SECONDS >= deadline )); then
      err "still busy after ${timeout}s — running workflows: ${workflows:-none}; active Airbyte jobs: ${jobs}. Nothing was migrated; let them finish (or stop them) and deploy again."
      return 1
    fi
    log "waiting for writers to finish — running workflows: ${workflows:-none}; active Airbyte jobs: ${jobs}"
    sleep "$POLL_SECONDS"
  done
}

# Runs in the background so a SIGTERM (the Job's deadline) reaches it and it
# puts the tables back before exiting.
migrate() {
  local child rc=0
  # shellcheck disable=SC2086 # TENANT_MIGRATION is a command line
  (cd "$SCRIPT_DIR" && exec $TENANT_MIGRATION apply) &
  child=$!
  trap 'kill -TERM "$child" 2>/dev/null || true' TERM INT
  wait "$child" || rc=$?
  # A trapped signal interrupts the first wait; the second waits for the undo.
  if kill -0 "$child" 2>/dev/null; then wait "$child" || rc=$?; fi
  trap 'exit 143' TERM INT
  return "$rc"
}

# On any exit of `pre` before the migration succeeded, writers this run
# suspended go back as they were — unless a table could not be put back
# (exit 3), when they stay stopped and the ConfigMap keeps the next deploy
# migrating forward.
PRE_OWN=0
PRE_DONE=0
PRE_KEEP=0
on_pre_exit() {
  if (( PRE_OWN && ! PRE_DONE && ! PRE_KEEP )); then
    if restore_writers all && k delete configmap "$CUTOVER_CONFIGMAP" >/dev/null; then
      log "writers put back as they were"
    else
      err "could not put the writers back; resume them from configmap/$CUTOVER_CONFIGMAP by hand"
    fi
  fi
}

cmd_pre() {
  local rc=0 state
  # shellcheck disable=SC2086 # TENANT_MIGRATION is a command line
  (cd "$SCRIPT_DIR" && $TENANT_MIGRATION plan --exit-code) || rc=$?
  case "$rc" in
    0)
      cm_exists && log "the rebuild of an earlier deploy has not finished; writers stay suspended until it does"
      log "nothing to migrate"
      return 0 ;;
    1) ;;
    *) err "tenant_migration plan failed (exit $rc)"; return 1 ;;
  esac

  trap on_pre_exit EXIT
  trap 'exit 143' TERM INT
  if ! cm_exists; then
    state="$(writer_state)"
    k create configmap "$CUTOVER_CONFIGMAP" --from-literal=state.json="$state" >/dev/null
    PRE_OWN=1
    k label configmap "$CUTOVER_CONFIGMAP" "$REBUILD_LABEL=state" >/dev/null
    log "recorded the suspend state of every writer in configmap/$CUTOVER_CONFIGMAP"
  fi

  suspend_writers
  wait_idle
  rc=0
  migrate || rc=$?
  case "$rc" in
    0)
      PRE_DONE=1
      log "migrated; writers stay suspended until the post-upgrade rebuild finishes" ;;
    3)
      PRE_KEEP=1
      err "the migration failed and some table could not be put back; writers stay suspended — deploy again to finish it"
      return 1 ;;
    *)
      err "the migration did not complete; every table is as it was before this deploy"
      return 1 ;;
  esac
}

cmd_post() {
  local running name
  if ! cm_exists; then
    log "nothing was migrated; no rebuild"
    return 0
  fi
  running="$(k get workflows -l "$REBUILD_LABEL=rebuild" -o json | jq -r '[.items[]
    | select((.status.phase // "") as $p | $p == "" or $p == "Pending" or $p == "Running") | .metadata.name] | join(" ")')"
  if [[ -n "$running" ]]; then
    log "a rebuild is already running: $running"
    return 0
  fi
  name="$(jq -n --arg template "${REBUILD_TEMPLATE:?}" --arg label "$REBUILD_LABEL" \
      --arg instance "${ARGO_INSTANCE_ID:-}" '{
    apiVersion: "argoproj.io/v1alpha1", kind: "Workflow",
    metadata: {generateName: "tenant-cutover-rebuild-",
      labels: ({($label): "rebuild"} + (if $instance == "" then {} else {"workflows.argoproj.io/controller-instanceid": $instance} end))},
    spec: {workflowTemplateRef: {name: $template}}}' | k create -o name -f -)"
  log "submitted $name: a full dbt refresh, then the identity seed, then every writer resumed"
  log "follow it: kubectl -n $INSIGHT_NAMESPACE get $name -w   (analytics reads empty until it succeeds)"
}

cmd_seed() {
  local cronjob job status
  cronjob="$(k get cronjobs -l "$SEED_SELECTOR" -o name | head -n 1)"
  if [[ -z "$cronjob" ]]; then
    log "no identity seed CronJob; skipping the seed"
    return 0
  fi
  job="tenant-cutover-seed-$(date +%s)"
  k create job --from="$cronjob" "$job" >/dev/null
  log "running job/$job from $cronjob"
  local deadline=$((SECONDS + ${SEED_TIMEOUT_SECONDS:-3600}))
  while :; do
    if (( SECONDS >= deadline )); then
      err "job/$job did not finish within ${SEED_TIMEOUT_SECONDS:-3600}s"
      return 1
    fi
    status="$(k get job "$job" -o jsonpath='{.status.succeeded}/{.status.failed}')"
    case "$status" in
      1/*) break ;;
      */[1-9]*)
        if [[ "$(k get job "$job" -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}')" == "True" ]]; then
          err "job/$job failed: $(k logs "job/$job" --tail=50 2>&1 || true)"
          return 1
        fi ;;
    esac
    sleep "$POLL_SECONDS"
  done
  # The CronJob runs with --guard-ok, which exits 0 when the input guard refuses.
  if k logs "job/$job" 2>/dev/null | grep -q 'input guard'; then
    err "the seed's input guard refused the identity inputs: $(k logs "job/$job" 2>&1 | grep 'input guard')"
    return 1
  fi
  log "identity seed done"
}

cmd_resume() {
  if ! cm_exists; then
    log "no recorded state; nothing to resume"
    return 0
  fi
  restore_writers cutover
  k delete configmap "$CUTOVER_CONFIGMAP" >/dev/null
  log "cutover complete: writers resumed, configmap/$CUTOVER_CONFIGMAP deleted"
}

case "${1:-}" in
  pre) cmd_pre ;;
  post) cmd_post ;;
  seed) cmd_seed ;;
  resume) cmd_resume ;;
  *) echo "usage: $0 pre|post|seed|resume" >&2; exit 2 ;;
esac
