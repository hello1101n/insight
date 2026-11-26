"""A connection syncs only on a catalog discovered from its current definition.

The ClickHouse destination drops every column a sync's catalog does not list,
so a sync on a catalog older than the definition wipes the columns the new
definition renamed (constructorfabric/insight#4401). The connection's
`catalog:` tag records which definition its catalog came from; until it names
the current one, every pass retries the refresh, leaves the schedule as it is
and triggers no sync. The pass that refreshes it unsuspends the schedule.

Run: pytest src/ingestion/reconcile-connectors/tests
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from reconcile_inputs import sync_user

ROOT = Path(__file__).resolve().parents[1]
CONNECTOR_DIR = ROOT.parent / "connectors" / "collaboration" / "zoom"
TENANT = "0f6b3c2e-5d4a-4e7b-9c1d-2a3b4c5d6e7f"
SOURCE_NAME = f"zoom-main-{TENANT}"
SECRET_HASH = "c" * 64
DESTINATION = "dest-1"

#: Airbyte answered from files the test writes; every write is recorded, and
#: a tag write lands in the listing so the next tick reads it back.
STUBS = """
kubectl() {
  case "$*" in
    *' patch '*) printf 'RESUME %s\\n' "$*" >> "$CALLS" ;;
    *) printf '{"stringData": {}}' ;;
  esac
}
valsec_check_secret()    { return 0; }
reconcile_definitions()  { printf '%s\\tnone\\tdef-1\\n' "$DEF_ACTION"; }
reconcile_rename_former_tenant() { return 0; }
reconcile_sources()      { printf 'noop\\tsrc-1\\n'; }
reconcile_resolve_schedule() { printf 'annotation\\n0 5 * * *'; }
ab_workspace_id()        { printf 'ws-1'; }
ab_list_connections()    { cat "$CONNECTIONS"; }
ab_get_connection()      { python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))[0]))' "$CONNECTIONS"; }
ab_resolve_tags()        { python3 -c 'import json,sys; print(json.dumps([{"name": n} for n in json.loads(sys.argv[1])]))' "$2"; }
ab_patch_connection_tags() {
  printf 'TAG %s\\n' "$(python3 -c 'import json,sys; print(",".join(t["name"] for t in json.loads(sys.argv[1])))' "$2")" >> "$CALLS"
  python3 - "$CONNECTIONS" "$2" <<'PY'
import json, sys
path, tags = sys.argv[1], json.loads(sys.argv[2])
connections = json.load(open(path))
connections[0]["tags"] = tags
json.dump(connections, open(path, "w"))
PY
}
reconcile_refresh_catalog() {
  printf 'REFRESH %s\\n' "$3" >> "$CALLS"
  [[ "$REFRESH" == ok ]]
}
argo_apply_cronworkflow() { printf 'APPLY %s\\n' "$1" >> "$CALLS"; }
argo_delete_former_tenant_cronworkflows() { return 0; }
argo_submit_sync_trigger() { printf 'SYNC_TRIGGER %s\\n' "$1" >> "$CALLS"; }
"""


def tick(
    tmp_path: Path, *, refresh: str = "ok", def_action: str = "noop", version: str = "1.0.0", stubs: str = STUBS
) -> tuple[int, list[str]]:
    calls = tmp_path / "calls"
    calls.unlink(missing_ok=True)
    script = f"""
    set -uo pipefail
    export INSIGHT_NAMESPACE=insight INSIGHT_TENANT_ID={TENANT} CONNECTORS_DIR="{ROOT.parent / "connectors"}"
    export AIRBYTE_URL=http://127.0.0.1:1
    export CONNECTIONS="{tmp_path / "connections.json"}" CALLS="{calls}"
    export ARGO_SERVICE_ACCOUNT=example-account REFRESH={refresh} DEF_ACTION={def_action}
    source "{ROOT}/lib/reconcile.sh"
    {stubs}
    {sync_user(tmp_path / "sync-user", DESTINATION)}
    ab_destination_credentials_init || exit 1
    _reconcile_one_connector zoom "{CONNECTOR_DIR}" {version} nocode "" "" \\
      bronze_zoom main insight-zoom-main {SECRET_HASH} 0 0 "" ""
    """
    result = subprocess.run(
        ["bash", "-c", script],
        env={key: value for key, value in os.environ.items() if not key.startswith("CONNECTOR_SCHEDULES_DB_")},
        capture_output=True,
        text=True,
        check=False,
    )
    recorded = calls.read_text(encoding="utf-8").splitlines() if calls.exists() else []
    return result.returncode, recorded


def seed(tmp_path: Path, *tags: str) -> None:
    connection = {
        "connectionId": "conn-1",
        "sourceId": "src-1",
        "destinationId": DESTINATION,
        "name": f"{SOURCE_NAME}-conn",
        "tags": [{"name": name} for name in ("insight", f"cfg-hash:{SECRET_HASH[:12]}", *tags)],
    }
    (tmp_path / "connections.json").write_text(json.dumps([connection]), encoding="utf-8")


def catalog_tag(tmp_path: Path) -> list[str]:
    tags = json.loads((tmp_path / "connections.json").read_text())[0]["tags"]
    return [t["name"] for t in tags if t["name"].startswith("catalog:")]


def test_a_failed_refresh_after_a_republish_blocks_the_schedule_and_sync_until_a_later_pass_refreshes(
    tmp_path: Path,
) -> None:
    seed(tmp_path)

    rc, failed = tick(tmp_path, refresh="fail", def_action="republish")
    assert rc != 0
    assert failed == ["REFRESH conn-1"], "no schedule apply, no unsuspend, no sync, no tag"

    # The definition is at target now, so the republish no longer asks for a
    # refresh: the missing catalog tag does.
    rc, still_failing = tick(tmp_path, refresh="fail")
    assert rc != 0
    assert still_failing == ["REFRESH conn-1"]

    rc, refreshed = tick(tmp_path)
    assert rc == 0
    assert refreshed[0] == "REFRESH conn-1"
    assert refreshed[1] == "APPLY zoom"
    assert refreshed[2].startswith("RESUME ") and '{"spec":{"suspend":false}}' in refreshed[2]
    assert refreshed[3].startswith("TAG insight,cfg-hash:") and ",catalog:" in refreshed[3]
    assert refreshed[4:] == ["SYNC_TRIGGER zoom"]

    rc, steady = tick(tmp_path)
    assert rc == 0
    assert steady == ["APPLY zoom"], "a current catalog leaves suspend alone and syncs nothing"


def test_an_untagged_connection_is_refreshed_before_its_schedule_runs(tmp_path: Path) -> None:
    # The first pass after this lands, or after the tenant cutover: no
    # connection carries a catalog tag yet, whether or not its definition moved.
    seed(tmp_path, "catalog:000000000000")
    rc, calls = tick(tmp_path)
    assert rc == 0
    assert [c.split()[0] for c in calls] == ["REFRESH", "APPLY", "RESUME", "TAG", "SYNC_TRIGGER"]
    assert len(catalog_tag(tmp_path)) == 1 and catalog_tag(tmp_path) != ["catalog:000000000000"]


def test_a_new_definition_version_needs_a_new_refresh(tmp_path: Path) -> None:
    seed(tmp_path)
    tick(tmp_path, version="1.0.0")
    first = catalog_tag(tmp_path)

    rc, calls = tick(tmp_path, version="2.0.0", refresh="fail")
    assert rc != 0 and calls == ["REFRESH conn-1"]
    assert catalog_tag(tmp_path) == first

    tick(tmp_path, version="2.0.0")
    assert len(catalog_tag(tmp_path)) == 1 and catalog_tag(tmp_path) != first


def test_a_failed_unsuspend_leaves_the_tag_unwritten_so_the_next_pass_retries(tmp_path: Path) -> None:
    seed(tmp_path)
    failing = STUBS.replace(
        """*' patch '*) printf 'RESUME %s\\n' "$*" >> "$CALLS" ;;""",
        """*' patch '*) printf 'RESUME-FAILED\\n' >> "$CALLS"; return 1 ;;""",
    )
    assert failing != STUBS
    rc, calls = tick(tmp_path, stubs=failing)
    assert rc != 0
    assert calls == ["REFRESH conn-1", "APPLY zoom", "RESUME-FAILED", "SYNC_TRIGGER zoom"]
    assert catalog_tag(tmp_path) == []

    rc, retried = tick(tmp_path)
    assert rc == 0
    assert [c.split()[0] for c in retried] == ["REFRESH", "APPLY", "RESUME", "TAG", "SYNC_TRIGGER"]


def test_the_catalog_tag_follows_what_the_definition_is_compared_by(tmp_path: Path) -> None:
    def tag(*args: str) -> str:
        return subprocess.run(
            [
                "bash",
                "-c",
                f'export INSIGHT_NAMESPACE=insight CONNECTORS_DIR=. AIRBYTE_URL=http://127.0.0.1:1 RECONCILE_STATE_BACKUP_SECRET=x; source "{ROOT}/lib/reconcile.sh"; reconcile_catalog_tag "$@"',
                "_",
                *args,
            ],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()

    nocode = tag("nocode", "1.0.0", "")
    assert nocode.startswith("catalog:") and len(nocode) <= 30
    assert tag("nocode", "1.0.1", "") != nocode
    cdk = tag("cdk", "1.0.0", "ghcr.io/example/source:abc1234")
    assert tag("cdk", "1.0.0", "ghcr.io/example/source:def5678") != cdk
    assert tag("cdk", "1.0.1", "ghcr.io/example/source:abc1234") == cdk, "cdk is compared by its image alone"
