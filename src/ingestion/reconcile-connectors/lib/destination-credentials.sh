#!/usr/bin/env bash

ab_destination_credentials_init() {
  local secret password
  secret="$(kubectl -n "${INSIGHT_NAMESPACE}" get secret "${RECONCILE_SYNC_PASSWORD_SECRET}" -o json)" || return 1
  password="$(jq -er --arg key "${RECONCILE_SYNC_PASSWORD_KEY}" \
    '.data[$key] | select(type == "string" and length > 0) | @base64d + "x"' <<<"${secret}")" || return 1
  export RECONCILE_DEST_CLICKHOUSE_PASSWORD="${password%x}"

  _AB_DESTINATION_REVISION="$(jq -ce --arg key "${RECONCILE_SYNC_PASSWORD_KEY}" \
    --arg username "${RECONCILE_DEST_CLICKHOUSE_USERNAME}" \
    '.metadata | select(.uid and .resourceVersion) | [.uid, .resourceVersion, $key, $username]' <<<"${secret}")" || return 1
  _AB_DESTINATION_REVISIONS="$(kubectl -n "${INSIGHT_NAMESPACE}" get configmap "${RECONCILE_DESTINATION_STATE}" -o json \
    | jq -ce '.data // {}')" || return 1
  _AB_DESTINATION_WRITES="$(mktemp -d "${TMPDIR:-/tmp}/insight-destination-writes.XXXXXX")"
}

ab_destination_credentials_close() {
  if [[ -n "${_AB_DESTINATION_WRITES:-}" ]]; then
    rm -rf "${_AB_DESTINATION_WRITES}"
    unset _AB_DESTINATION_WRITES
  fi
}

ab_destination_credentials_current() {
  [[ -n "${_AB_DESTINATION_REVISION:-}" ]] && jq -e --arg id "$1" \
    --arg revision "${_AB_DESTINATION_REVISION}" '.[$id] == $revision' <<<"${_AB_DESTINATION_REVISIONS}" >/dev/null
}

ab_destination_write_attempted() {
  [[ "$1" =~ ^[a-zA-Z0-9_-]+$ && -n "${_AB_DESTINATION_WRITES:-}" && -f "${_AB_DESTINATION_WRITES}/$1" ]]
}

ab_destination_write_succeeded() {
  [[ "$(<"${_AB_DESTINATION_WRITES}/$1")" == "ok" ]]
}

ab_destination_mark_attempt() {
  [[ "$1" =~ ^[a-zA-Z0-9_-]+$ && -n "${_AB_DESTINATION_WRITES:-}" ]] || return 1
  : >"${_AB_DESTINATION_WRITES}/$1"
}

ab_destination_record_write() {
  local id="$1" credentials_changed="$2" patch
  if [[ "${credentials_changed}" == "true" ]]; then
    patch="$(jq -cn --arg id "${id}" --arg revision "${_AB_DESTINATION_REVISION}" '{data: {($id): $revision}}')" || return 1
    kubectl -n "${INSIGHT_NAMESPACE}" patch configmap "${RECONCILE_DESTINATION_STATE}" \
      --type=merge -p "${patch}" >/dev/null || return 1
  fi
  printf 'ok' >"${_AB_DESTINATION_WRITES}/${id}"
}

ab_destination_update_once() {
  local id="$1" body="$2" credentials_changed="$3"
  ab_destination_mark_attempt "${id}" || return 1
  ab__curl POST /api/v1/destinations/update "${body}" >/dev/null || return 1
  ab_destination_record_write "${id}" "${credentials_changed}"
}
