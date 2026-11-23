"""A manifest→CDK definition migration keeps the connection's sync state.

The migration deletes the source, its connection, the builder project and the
definition, and the later stages create the replacements. The state goes to a
K8s Secret before the first delete and onto the replacement connection after
it is created. A pass that stops at any step leaves the next pass able to
finish with the same state.

The Airbyte and kubectl calls are answered from one JSON world file, so a test
reads what is left after each pass.

Run: pytest src/ingestion/reconcile-connectors/tests
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

SOURCE = "alpha-main-example-tenant"
STATE = {"stateType": "stream", "connectionId": "conn-1", "streamState": [{"cursor": "2026-01-01"}]}
CDK_IMAGE = "ghcr.io/example-org/source-alpha:2.0.0"

FAKE = r"""
import base64, json, sys
world_path, op, *args = sys.argv[1:]
with open(world_path) as f:
    w = json.load(f)
fail = w.get("fail")
if fail == op:
    w["fail"] = None
    json.dump(w, open(world_path, "w"))
    sys.exit(1)
out = None
if op == "list_sources":
    out = {"sources": w["sources"]}
elif op == "list_connections":
    out = {"connections": w["connections"]}
elif op == "get_state":
    out = w["states"].get(args[0], {"stateType": "not_set", "connectionId": args[0]})
elif op == "set_state":
    w["states"][args[0]] = json.loads(args[1])
    out = {}
elif op == "delete_source":
    w["sources"] = [s for s in w["sources"] if s["sourceId"] != args[0]]
    gone = [c["connectionId"] for c in w["connections"] if c["sourceId"] == args[0]]
    w["connections"] = [c for c in w["connections"] if c["sourceId"] != args[0]]
    for c in gone:
        w["states"].pop(c, None)
    out = {}
elif op == "find_builder":
    print(w["builders"].get(args[0], ""))
elif op == "delete_builder":
    w["builders"] = {d: b for d, b in w["builders"].items() if b != args[0]}
    out = {}
elif op == "delete_definition":
    if any(s["sourceDefinitionId"] == args[0] for s in w["sources"]):
        sys.exit(1)
    w["definitions"] = [d for d in w["definitions"] if d["sourceDefinitionId"] != args[0]]
    out = {}
elif op == "create_definition":
    w["definitions"].append({"sourceDefinitionId": "def-cdk", "name": "alpha", "dockerRepository": args[0]})
    out = "def-cdk"
elif op == "create_source":
    w["sources"].append({"sourceId": "src-2", "name": args[0], "sourceDefinitionId": args[1]})
    out = "src-2"
elif op == "create_connection":
    w["connections"].append({"connectionId": "conn-2", "sourceId": args[0]})
    out = "conn-2"
elif op == "sync":
    w["states"][args[0]] = {"stateType": "stream", "connectionId": args[0], "streamState": [{"cursor": "fresh"}]}
elif op == "secret_get":
    out = {"data": w["secret"]}
elif op == "secret_patch":
    for k, v in json.load(sys.stdin)["data"].items():
        if v is None:
            w["secret"].pop(k, None)
        else:
            w["secret"][k] = v
json.dump(w, open(world_path, "w"))
if out is not None:
    print(out if isinstance(out, str) else json.dumps(out))
"""

STUBS = """
log_line()  { :; }
log_event() { :; }
fake() { python3 "$FAKE" "$WORLD" "$@"; }
ab_workspace_id()               { printf 'workspace-1'; }
ab_list_sources()               { fake list_sources | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)["sources"]))'; }
ab_list_connections()           { fake list_connections | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)["connections"]))'; }
ab_get_state()                  { fake get_state "$1"; }
ab_create_or_update_state()     { fake set_state "$1" "$2"; }
ab_delete_source()              { fake delete_source "$1"; }
ab_builder_find_by_definition() { fake find_builder "$2"; }
ab_builder_delete_project()     { fake delete_builder "$2"; }
ab_delete_source_definition()   { fake delete_definition "$1"; }
ab_create_custom_cdk_definition() { fake create_definition "$3"; }
kubectl() {
  case "$3" in
    get)   fake secret_get ;;
    patch) fake secret_patch ;;
  esac
}

# One reconcile pass in stage order: definition, source, connection.
reconcile_pass() {
  local def
  def="$(python3 -c '
import json, sys
for d in json.load(open(sys.argv[1]))["definitions"]:
    print(d["sourceDefinitionId"] + "\\t" + d["dockerRepository"])
' "$WORLD")"
  if [[ -z "$def" ]]; then
    fake create_definition ghcr.io/example-org/source-alpha >/dev/null || return 1
  elif [[ "${def#*$'\\t'}" == airbyte/source-declarative-manifest ]]; then
    reconcile_migrate_definition_kind alpha "${def%%$'\\t'*}" "$CDK_IMAGE" || return 1
    return 0
  fi
  local src conn
  src="$(ab_list_sources | python3 -c 'import sys,json;print(next((s["sourceId"] for s in json.load(sys.stdin)), ""))')"
  if [[ -z "$src" ]]; then
    fake create_source "$SOURCE" def-cdk >/dev/null || return 1
    src=src-2
  fi
  conn="$(ab_list_connections | python3 "$PY/select_connection_by_source.py" "$src")"
  if [[ -z "$conn" ]]; then
    conn="$(fake create_connection "$src")" || return 1
  fi
  reconcile_restore_state_backup alpha "$SOURCE" "$conn"
}
"""


def world() -> dict[str, object]:
    return {
        "fail": None,
        "definitions": [
            {"sourceDefinitionId": "def-1", "name": "alpha", "dockerRepository": "airbyte/source-declarative-manifest"}
        ],
        "builders": {"def-1": "builder-1"},
        "sources": [{"sourceId": "src-1", "name": SOURCE, "sourceDefinitionId": "def-1"}],
        "connections": [{"connectionId": "conn-1", "sourceId": "src-1"}],
        "states": {"conn-1": STATE},
        "secret": {},
    }


class Stand:
    def __init__(self, tmp_path: Path) -> None:
        self.world = tmp_path / "world.json"
        self.fake = tmp_path / "fake.py"
        self.fake.write_text(FAKE, encoding="utf-8")
        self.world.write_text(json.dumps(world()), encoding="utf-8")

    def read(self) -> dict[str, object]:
        return json.loads(self.world.read_text(encoding="utf-8"))

    def set(self, key: str, value: object) -> None:
        w = self.read()
        w[key] = value
        self.world.write_text(json.dumps(w), encoding="utf-8")

    def run(self, command: str) -> subprocess.CompletedProcess[str]:
        script = f"""
        set -uo pipefail
        export INSIGHT_NAMESPACE=insight
        export CONNECTORS_DIR="{ROOT}/../connectors"
        export AIRBYTE_URL=http://127.0.0.1:1
        export INSIGHT_TENANT_ID=example-tenant
        export RECONCILE_STATE_BACKUP_SECRET=insight-reconcile-state
        export WORLD="{self.world}" FAKE="{self.fake}" PY="{ROOT}/python"
        export SOURCE="{SOURCE}" CDK_IMAGE="{CDK_IMAGE}"
        source "{ROOT}/lib/reconcile.sh"
        {STUBS}
        {command}
        """
        return subprocess.run(["bash", "-c", script], capture_output=True, text=True, check=False)

    def passes(self, count: int) -> list[int]:
        return [self.run("reconcile_pass").returncode for _ in range(count)]

    def restored_state(self) -> object:
        return self.read()["states"].get("conn-2")


@pytest.fixture
def stand(tmp_path: Path) -> Stand:
    return Stand(tmp_path)


class TestMigrationKeepsTheState:
    def test_the_replacement_connection_gets_the_state_of_the_deleted_one(self, stand: Stand) -> None:
        assert stand.passes(2) == [0, 0]

        after = stand.read()
        assert stand.restored_state() == STATE
        assert after["secret"] == {}, "the backup is dropped once the connection holds it"
        assert after["builders"] == {}, "the builder project of the manifest definition is deleted"
        assert [d["sourceDefinitionId"] for d in after["definitions"]] == ["def-cdk"]

    @pytest.mark.parametrize(
        "step",
        [
            "delete_source",
            "find_builder",
            "delete_builder",
            "delete_definition",
            "create_definition",
            "create_source",
            "create_connection",
            "set_state",
            "secret_patch",
        ],
    )
    def test_a_pass_stopped_at_any_step_resumes_with_the_saved_state(self, stand: Stand, step: str) -> None:
        stand.set("fail", step)

        codes = stand.passes(4)

        assert 1 in codes, f"the failure at {step} must fail its pass: {codes}"
        assert codes[-1] == 0, f"should converge after a failure at {step}: {codes}"
        assert stand.restored_state() == STATE, f"state lost after a failure at {step}"
        assert stand.read()["secret"] == {}, f"backup left behind after a failure at {step}"

    def test_no_delete_happens_when_the_backup_cannot_be_written(self, stand: Stand) -> None:
        stand.set("fail", "secret_patch")

        result = stand.run("reconcile_pass")

        assert result.returncode == 1
        assert stand.read()["sources"] == world()["sources"]
        assert stand.read()["states"] == {"conn-1": STATE}

    def test_no_delete_happens_when_the_state_cannot_be_read(self, stand: Stand) -> None:
        stand.set("fail", "get_state")

        result = stand.run("reconcile_pass")

        assert result.returncode == 1
        assert stand.read()["sources"] == world()["sources"]
        assert stand.read()["secret"] == {}

    def test_a_failed_source_delete_stops_the_migration(self, stand: Stand) -> None:
        stand.set("fail", "delete_source")

        result = stand.run("reconcile_pass")

        assert result.returncode == 1
        assert stand.read()["builders"] == {"def-1": "builder-1"}
        assert [d["sourceDefinitionId"] for d in stand.read()["definitions"]] == ["def-1"]

    def test_a_failed_restore_fails_the_pass_and_keeps_the_backup(self, stand: Stand) -> None:
        assert stand.passes(1) == [0]
        stand.set("fail", "set_state")

        result = stand.run("reconcile_pass")

        assert result.returncode == 1
        assert stand.read()["secret"] != {}
        assert stand.restored_state() is None

    def test_a_connection_that_synced_before_the_restore_keeps_its_own_state(self, stand: Stand) -> None:
        """A scheduled sync can run between the connection create and a retried
        restore. Its state is newer than the backup, so the backup is dropped."""
        assert stand.passes(1) == [0]
        stand.set("fail", "set_state")
        assert stand.passes(1) == [1]
        stand.run("fake sync conn-2")

        assert stand.passes(1) == [0]

        assert stand.restored_state() == {
            "stateType": "stream",
            "connectionId": "conn-2",
            "streamState": [{"cursor": "fresh"}],
        }
        assert stand.read()["secret"] == {}
