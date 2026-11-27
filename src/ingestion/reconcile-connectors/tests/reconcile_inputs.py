"""The inputs the removal passes read, as typed fixtures.

Typed rather than bare dicts because these records decide deletions: a key
spelled wrong in a test is a record the reader silently skips, and the test
would still pass while proving nothing.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Iterable
from pathlib import Path
from typing import NamedTuple


class Source(NamedTuple):
    """One entry of the `sources/list` payload."""

    name: str
    source_id: str
    #: Empty leaves the field out entirely, which is the listing that makes
    #: ownership fall back to the name.
    definition_id: str = ""

    def payload(self) -> dict[str, str]:
        record = {"name": self.name, "sourceId": self.source_id}
        if self.definition_id:
            record["sourceDefinitionId"] = self.definition_id
        return record


class Definition(NamedTuple):
    """One source definition, the way this loop publishes them (ADR-0009)."""

    connector: str
    definition_id: str

    def payload(self) -> dict[str, object]:
        return {"name": self.connector, "sourceDefinitionId": self.definition_id, "custom": True}


def listing(records: Iterable[Source] | Iterable[Definition]) -> str:
    """The JSON array a reader is handed."""
    return json.dumps([record.payload() for record in records])


def plan_row(connector: str, source_id: str = "", secret: str = "") -> str:
    """One `disc_load_instances` row: seven descriptor columns, three instance.

    The instance columns are empty for a descriptor no Secret names, which is
    what the removal passes read as "not installed here".
    """
    namespace = "bronze_" + connector.replace("-", "_")
    return "\t".join([connector, "dir", "1", "nocode", "", "", namespace, source_id, secret, "hash"])


def write_sync_secret(directory: Path, version: str, password: str) -> None:
    directory.mkdir(exist_ok=True)
    (directory / "secret.json").write_text(
        json.dumps(
            {
                "metadata": {"uid": "example-secret-uid", "resourceVersion": version},
                "data": {"password": base64.b64encode(password.encode()).decode()},
            }
        )
    )


def sync_user(directory: Path, *current: str, username: str = "etl") -> str:
    write_sync_secret(directory, "10", "example-secret")
    revision = json.dumps(["example-secret-uid", "10", "password", username], separators=(",", ":"))
    state = directory / "state.json"
    state.write_text(json.dumps({"data": dict.fromkeys(current, revision)}))
    return f"""
    export RECONCILE_SYNC_PASSWORD_SECRET=example-sync-password RECONCILE_SYNC_PASSWORD_KEY=password
    export RECONCILE_DESTINATION_STATE=example-destination-state RECONCILE_DEST_CLICKHOUSE_USERNAME={username}
    export TMPDIR='{directory}'
    if declare -F kubectl >/dev/null; then
      eval "$(declare -f kubectl | sed '1s/^kubectl /_sync_user_next_kubectl /')"
    else
      _sync_user_next_kubectl() {{ command kubectl "$@"; }}
    fi
    kubectl() {{
      case "${{3:-}} ${{4:-}} ${{5:-}}" in
        'get secret example-sync-password') cat '{directory / "secret.json"}' ;;
        'get configmap example-destination-state') cat '{state}' ;;
        'patch configmap example-destination-state')
          jq --argjson patch "$8" '. * $patch' '{state}' > '{state}.next' || return 1
          mv '{state}.next' '{state}' ;;
        *) _sync_user_next_kubectl "$@" ;;
      esac
    }}
    """
