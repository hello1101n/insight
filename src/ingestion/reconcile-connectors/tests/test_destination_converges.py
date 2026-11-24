"""What ab_ensure_destination does with a `clickhouse-bronze` that already exists.

Airbyte keeps whatever connectionConfiguration a destination was created with,
so a topology flag flipped after the first tick reaches it only if reconcile
compares and updates. Airbyte lists a secret as `**********`, which is why the
password is left out of the comparison and never the reason for an update.

The Airbyte API is a bash stub that records every call; the assertions read
the call log, not a server.

Run: pytest src/ingestion/reconcile-connectors/tests
"""

from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

WORKSPACE = "ws-00000000"
DEST_ID = "dest-22222222"
DEF_ID = "def-11111111"
MASK = "**********"

COMPOSED = {
    "host": "clickhouse.example.test",
    "port": "8123",
    "protocol": "http",
    "database": "insight",
    "username": "insight",
    "password": "example-password",
    "enable_json": False,
    "use_replicated_engines": True,
    "cluster_name": "insight_cluster",
}

#: The stub answers each path from a file named after it; the body of every
#: call lands in calls.log as `<method> <path> <body>`.
STUB = """
ab_workspace_id() {{ printf '%s' '{workspace}'; }}
ab__curl() {{
  local method="$1" path="$2" body="${{3:-}}"
  printf '%s %s %s\\n' "$method" "$path" "$body" >> '{log}'
  local answer='{answers}'/"${{path//\\//_}}"
  [[ -f "$answer" ]] || {{ printf '{{"message":"stub: no answer for %s"}}' "$path"; return 22; }}
  cat "$answer"
}}
"""


def _destination_state(tmp_path: Path) -> str:
    state = tmp_path / "state.json"
    state.write_text("{}")
    return f"""
    export RECONCILE_SYNC_PASSWORD_SECRET=credentials RECONCILE_SYNC_PASSWORD_KEY=password
    export RECONCILE_DESTINATION_STATE=destination-state TMPDIR='{tmp_path}'
    kubectl() {{
      case "$3 $4 $5" in
        'get secret credentials') cat '{tmp_path / "secret.json"}' ;;
        'get configmap destination-state') cat '{state}' ;;
        'patch configmap destination-state')
          jq --argjson patch "$8" '. * $patch' '{state}' > '{state}.next' || return 1
          mv '{state}.next' '{state}' ;;
        *) return 1 ;;
      esac
    }}
    """


def _write_secret(tmp_path: Path, version: str, password: str) -> None:
    (tmp_path / "secret.json").write_text(
        json.dumps(
            {
                "metadata": {"uid": "example-secret-uid", "resourceVersion": version},
                "data": {"password": base64.b64encode(password.encode()).decode()},
            }
        )
    )


def _stored(config: dict[str, object] | None) -> dict[str, object]:
    """What destinations/list returns: the secret masked, nothing else touched."""
    if config is None:
        return {"destinations": []}
    listed = dict(config)
    listed["password"] = MASK
    return {
        "destinations": [
            {
                "destinationId": DEST_ID,
                "workspaceId": WORKSPACE,
                "destinationDefinitionId": DEF_ID,
                "name": "clickhouse-bronze",
                "connectionConfiguration": listed,
            },
            {
                "destinationId": "dest-33333333",
                "workspaceId": WORKSPACE,
                "destinationDefinitionId": DEF_ID,
                "name": "something-else",
                "connectionConfiguration": {"host": "other", "password": MASK},
            },
        ]
    }


def _ensure(
    tmp_path: Path, stored: dict[str, object] | None, composed: dict[str, object] = COMPOSED, *, update_ok: bool = True
) -> tuple[subprocess.CompletedProcess[str], list[tuple[str, str, object]]]:
    answers = tmp_path / "answers"
    answers.mkdir()
    (answers / "_api_v1_destinations_list").write_text(json.dumps(_stored(stored)), encoding="utf-8")
    (answers / "_api_v1_destinations_create").write_text(json.dumps({"destinationId": DEST_ID}), encoding="utf-8")
    if update_ok:
        (answers / "_api_v1_destinations_update").write_text(json.dumps({"destinationId": DEST_ID}), encoding="utf-8")
    log = tmp_path / "calls.log"

    script = f"""
    set -uo pipefail
    export AIRBYTE_URL=http://127.0.0.1:1
    source "{ROOT}/lib/airbyte.sh"
    {STUB.format(workspace=WORKSPACE, log=log, answers=answers)}
    ab_ensure_destination clickhouse-bronze {DEF_ID} '{json.dumps(composed)}'
    """
    done = subprocess.run(["bash", "-c", script], capture_output=True, text=True, encoding="utf-8", check=False)

    calls = []
    if log.exists():
        for line in log.read_text(encoding="utf-8").splitlines():
            method, path, body = line.split(" ", 2)
            calls.append((method, path, json.loads(body) if body else None))
    return done, calls


def test_an_absent_destination_is_created_with_the_composed_configuration(tmp_path: Path) -> None:
    done, calls = _ensure(tmp_path, stored=None)

    assert done.returncode == 0, done.stderr
    assert done.stdout == DEST_ID
    assert [c[1] for c in calls] == ["/api/v1/destinations/list", "/api/v1/destinations/create"]
    assert calls[1][2] == {
        "workspaceId": WORKSPACE,
        "destinationDefinitionId": DEF_ID,
        "name": "clickhouse-bronze",
        "connectionConfiguration": COMPOSED,
    }
    assert "created" in done.stderr


def test_a_destination_that_already_matches_is_left_alone(tmp_path: Path) -> None:
    """The password comes back masked and must not read as drift."""
    done, calls = _ensure(tmp_path, stored=COMPOSED)

    assert done.returncode == 0, done.stderr
    assert done.stdout == DEST_ID
    assert [c[1] for c in calls] == ["/api/v1/destinations/list"]
    assert "already carries" in done.stderr


def test_a_topology_flipped_after_the_first_tick_reaches_airbyte(tmp_path: Path) -> None:
    standalone = {k: v for k, v in COMPOSED.items() if k not in ("use_replicated_engines", "cluster_name")}

    done, calls = _ensure(tmp_path, stored=standalone)

    assert done.returncode == 0, done.stderr
    assert done.stdout == DEST_ID
    assert [c[1] for c in calls] == ["/api/v1/destinations/list", "/api/v1/destinations/update"]
    assert calls[1][2] == {"destinationId": DEST_ID, "name": "clickhouse-bronze", "connectionConfiguration": COMPOSED}
    assert "updated: cluster_name use_replicated_engines" in done.stderr


def test_turning_the_topology_back_off_is_also_drift(tmp_path: Path) -> None:
    """Symmetric: a key the composed configuration no longer carries is removed,
    not left behind on the destination."""
    standalone = {k: v for k, v in COMPOSED.items() if k not in ("use_replicated_engines", "cluster_name")}

    done, calls = _ensure(tmp_path, stored=COMPOSED, composed=standalone)

    assert done.returncode == 0, done.stderr
    assert [c[1] for c in calls] == ["/api/v1/destinations/list", "/api/v1/destinations/update"]
    assert calls[1][2]["connectionConfiguration"] == standalone


@pytest.mark.parametrize(("key", "value"), [("host", "clickhouse-2.example.test"), ("cluster_name", "renamed")])
def test_any_other_drifted_key_is_updated_too(tmp_path: Path, key: str, value: str) -> None:
    done, calls = _ensure(tmp_path, stored=COMPOSED | {key: value})

    assert done.returncode == 0, done.stderr
    assert [c[1] for c in calls][-1] == "/api/v1/destinations/update"
    assert done.stderr.rstrip("\n").endswith(f"updated: {key}")


def test_a_rotated_password_alone_is_not_visible_and_not_an_update(tmp_path: Path) -> None:
    """Airbyte masks it on the way out, so there is nothing to compare; the
    stored secret is refreshed only alongside some other drift."""
    done, calls = _ensure(tmp_path, stored=COMPOSED | {"password": "a-previous-password"})

    assert done.returncode == 0, done.stderr
    assert [c[1] for c in calls] == ["/api/v1/destinations/list"]


def test_a_failed_update_is_a_failure_not_a_stale_id(tmp_path: Path) -> None:
    standalone = {k: v for k, v in COMPOSED.items() if k not in ("use_replicated_engines", "cluster_name")}

    done, _ = _ensure(tmp_path, stored=standalone, update_ok=False)

    assert done.returncode == 1
    assert done.stdout == ""
    assert "destinations/update failed" in done.stderr
    assert "stub: no answer" in done.stderr


@pytest.mark.parametrize(
    ("enabled", "dry_run", "previous_user"),
    [(True, False, "previous"), (True, False, "etl"), (False, False, "previous"), (True, True, "previous")],
)
def test_reconcile_rotates_credentials_on_the_destination_used_by_an_existing_connection(
    tmp_path: Path, enabled: bool, dry_run: bool, previous_user: str
) -> None:
    current = COMPOSED | {"username": previous_user, "password": MASK}
    answers = tmp_path / "answers"
    answers.mkdir()
    (answers / "_api_v1_destinations_get").write_text(
        json.dumps({"destinationId": DEST_ID, "name": "custom-destination", "connectionConfiguration": current})
    )
    (answers / "_api_v1_destinations_update").write_text("{}")
    log = tmp_path / "calls"
    connection = {
        "sourceId": "source-1",
        "connectionId": "conn-1",
        "destinationId": DEST_ID,
        "tags": [{"name": "insight"}, {"name": "cfg-hash:abcdefabcdef"}],
    }
    _write_secret(tmp_path, "10", "example-secret")
    script = f"""
    set -uo pipefail
    export AIRBYTE_URL=http://127.0.0.1:1 INSIGHT_NAMESPACE=fixture CONNECTORS_DIR=/nonexistent
    export RECONCILE_SYNC_USER_ENABLED={str(enabled).lower()} RECONCILE_DRY_RUN={int(dry_run)}
    export RECONCILE_DEST_CLICKHOUSE_USERNAME=etl
    source "{ROOT}/lib/reconcile.sh"
    {STUB.format(workspace=WORKSPACE, log=log, answers=answers)}
    {_destination_state(tmp_path)}
    ab_list_connections() {{ printf '%s' '{json.dumps([connection])}'; }}
    if [[ "$RECONCILE_SYNC_USER_ENABLED" == "true" && "$RECONCILE_DRY_RUN" == "0" ]]; then
      ab_destination_credentials_init || exit 1
    fi
    reconcile_connections jira source-1 abcdefabcdef1234 bronze_jira
    """
    done = subprocess.run(["bash", "-c", script], capture_output=True, text=True, check=False)
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == "noop\tconn-1"
    if not enabled or dry_run:
        assert not log.exists()
        return

    read, update = log.read_text().splitlines()
    assert read == f'POST /api/v1/destinations/get {{"destinationId":"{DEST_ID}"}}'
    method, path, body = update.split(" ", 2)
    assert (method, path) == ("POST", "/api/v1/destinations/update")
    assert json.loads(body) == {
        "destinationId": DEST_ID,
        "name": "custom-destination",
        "connectionConfiguration": current | {"username": "etl", "password": "example-secret"},
    }


@pytest.mark.parametrize("named_first", [True, False])
def test_reconcile_writes_a_masked_password_once_per_secret_revision(tmp_path: Path, named_first: bool) -> None:
    answers = tmp_path / "answers"
    answers.mkdir()
    current = COMPOSED | {"username": "etl", "password": MASK}
    (answers / "_api_v1_destinations_list").write_text(json.dumps(_stored(current)))
    (answers / "_api_v1_destinations_get").write_text(json.dumps(_stored(current)["destinations"][0]))
    update_answer = answers / "_api_v1_destinations_update"
    log = tmp_path / "calls.log"
    ensure = f'result="$(ab_ensure_destination clickhouse-bronze {DEF_ID} "$config")" || status=1'
    connect = 'result="$(reconcile_connections jira source-1 abcdefabcdef1234 bronze_jira)" || status=1'
    steps = [ensure, connect] if named_first else [connect, ensure]
    connections = [
        {
            "sourceId": "source-1",
            "connectionId": connection_id,
            "destinationId": DEST_ID,
            "tags": [{"name": "insight"}, {"name": "cfg-hash:abcdefabcdef"}],
        }
        for connection_id in ("conn-1", "conn-2")
    ]
    script = f"""
    set -uo pipefail
    export AIRBYTE_URL=http://127.0.0.1:1 INSIGHT_NAMESPACE=fixture CONNECTORS_DIR=/nonexistent
    export RECONCILE_SYNC_USER_ENABLED=true RECONCILE_DEST_CLICKHOUSE_USERNAME=etl
    source "{ROOT}/lib/reconcile.sh"
    {STUB.format(workspace=WORKSPACE, log=log, answers=answers)}
    {_destination_state(tmp_path)}
    ab_list_connections() {{ printf '%s' '{json.dumps(connections)}'; }}
    connector_schedules_read() {{ :; }}
    connector_schedules_writable() {{ :; }}
    disc_load_instances() {{ printf 'jira\tfixture\tv1\ttype\timage\tselect\tbronze_jira\tsource-1\tsecret\thash\n'; }}
    _reconcile_mark_colliding_connectors() {{ :; }}
    reconcile_prune_removed_instances() {{ :; }}
    reconcile_sweep_orphan_schedules() {{ :; }}
    reconcile_gc_orphans() {{ :; }}
    sweep_run() {{ :; }}
    _reconcile_one_connector() {{
      local config result
      local status=0
      config="$(jq -c --arg password "$RECONCILE_DEST_CLICKHOUSE_PASSWORD" '.password = $password' <<<'{json.dumps(current)}')"
      {steps[0]}
      {steps[1]}
      return "$status"
    }}
    reconcile_run
    """
    for version, password, rejected, count, recorded_version in [
        ("10", "example-first", False, 1, "10"),
        ("10", "example-first", False, 0, "10"),
        ("11", "example-rotated", False, 1, "11"),
        ("11", "example-rotated", False, 0, "11"),
        ("12", "example-retried", True, 1, "11"),
        ("12", "example-retried", False, 1, "12"),
    ]:
        _write_secret(tmp_path, version, password)
        if rejected:
            update_answer.unlink()
        else:
            update_answer.write_text("{}")
        log.unlink(missing_ok=True)
        done = subprocess.run(["bash", "-c", script], capture_output=True, text=True, check=False)
        assert done.returncode == (2 if rejected else 0), done.stderr
        writes = [
            json.loads(line.split(" ", 2)[2])
            for line in log.read_text().splitlines()
            if line.startswith("POST /api/v1/destinations/update ")
        ]
        assert len(writes) == count, (version, named_first)
        if writes:
            assert writes[0]["connectionConfiguration"] == current | {"password": password}
        else:
            assert "POST /api/v1/destinations/get " not in log.read_text()
        revision = json.loads(json.loads((tmp_path / "state.json").read_text())["data"][DEST_ID])
        assert revision == ["example-secret-uid", recorded_version, "password", "etl"]
