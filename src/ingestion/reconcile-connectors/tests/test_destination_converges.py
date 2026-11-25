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

import html
import json
import re
import socket
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import quote, quote_plus

import pytest
from reconcile_inputs import sync_user, write_sync_secret

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
WAREHOUSE_ENV = "\n".join(
    f"export RECONCILE_DEST_CLICKHOUSE_{key.upper()}={COMPOSED[key]}"
    for key in ("host", "port", "database", "protocol")
)

#: The stub answers each path from a file named after it; the body of every
#: call lands in calls.log as `<method> <path> <body>`.
STUB = """
export AIRBYTE_TOKEN=example-token
ab_workspace_id() {{ printf '%s' '{workspace}'; }}
ab__curl() {{
  local method="$1" path="$2" body="${{3:-}}"
  printf '%s %s %s\\n' "$method" "$path" "$body" >> '{log}'
  local answer='{answers}'/"${{path//\\//_}}"
  [[ -f "$answer" ]] || {{ printf '{{"message":"stub: no answer for %s"}}' "$path"; return 22; }}
  cat "$answer"
  if [[ -n "${{4:-}}" ]]; then printf '\\n200'; fi
}}
"""


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
    tmp_path: Path,
    stored: dict[str, object] | None,
    composed: dict[str, object] = COMPOSED,
    *,
    update_ok: bool = True,
    current: bool = True,
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
    export AIRBYTE_URL=http://127.0.0.1:1 INSIGHT_NAMESPACE=fixture
    source "{ROOT}/lib/airbyte.sh"
    {STUB.format(workspace=WORKSPACE, log=log, answers=answers)}
    {sync_user(tmp_path / "sync-user", *([DEST_ID] if current else []))}
    ab_destination_credentials_init || exit 1
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
    standalone["database"] = "standalone"

    done, calls = _ensure(tmp_path, stored=standalone, current=False)

    assert done.returncode == 0, done.stderr
    assert done.stdout == DEST_ID
    assert [c[1] for c in calls] == ["/api/v1/destinations/list", "/api/v1/destinations/update"]
    assert calls[1][2] == {"destinationId": DEST_ID, "name": "clickhouse-bronze", "connectionConfiguration": COMPOSED}
    assert "updated: cluster_name database use_replicated_engines password" in done.stderr


def test_turning_the_topology_back_off_is_also_drift(tmp_path: Path) -> None:
    """Symmetric: a key the composed configuration no longer carries is removed,
    not left behind on the destination."""
    standalone = {k: v for k, v in COMPOSED.items() if k not in ("use_replicated_engines", "cluster_name")}

    done, calls = _ensure(tmp_path, stored=COMPOSED, composed=standalone)

    assert done.returncode == 0, done.stderr
    assert [c[1] for c in calls] == ["/api/v1/destinations/list", "/api/v1/destinations/update"]
    assert calls[1][2]["connectionConfiguration"] == standalone | {"password": MASK}


@pytest.mark.parametrize(
    ("drift", "fields"),
    [
        ({"cluster_name": "renamed"}, "cluster_name"),
        ({"host": "other.example.test"}, "host"),
        ({"port": "8443", "protocol": "https"}, "port protocol"),
    ],
    ids=["cluster-name", "host-move", "tls-switch"],
)
def test_any_other_drifted_key_is_updated_too(tmp_path: Path, drift: dict[str, object], fields: str) -> None:
    done, calls = _ensure(tmp_path, stored=COMPOSED | drift, current=False)

    assert done.returncode == 0, done.stderr
    assert [c[1] for c in calls] == ["/api/v1/destinations/list", "/api/v1/destinations/update"]
    assert calls[1][2]["connectionConfiguration"] == COMPOSED
    assert done.stderr.rstrip("\n").endswith(f"updated: {fields} password")


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
    assert f"Airbyte destination update failed. destination={DEST_ID}" in done.stderr


def _reject_destination_write(
    tmp_path: Path, *, operation: str, status: int, error: str, config: dict[str, object], minted_token: str = ""
) -> subprocess.CompletedProcess[str]:
    stored = None if operation == "create" else COMPOSED
    replies = {
        "/api/v1/destinations/list": (200, json.dumps(_stored(stored))),
        f"/api/v1/destinations/{operation}": (status, error),
    }
    paths: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            self.rfile.read(int(self.headers["Content-Length"]))
            paths.append(self.path)
            code, answer = replies.get(self.path, (404, ""))
            self.send_response(code)
            self.end_headers()
            self.wfile.write(answer.encode())

    with HTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = Thread(target=server.serve_forever)
        thread.start()
        try:
            script = f"""
            set -euo pipefail
            export AIRBYTE_URL=http://127.0.0.1:{server.server_port} AIRBYTE_TOKEN=example-token INSIGHT_NAMESPACE=fixture
            source "{ROOT}/lib/airbyte.sh"
            if [[ -n "$2" ]]; then
              unset AIRBYTE_TOKEN
              ab_get_token() {{ printf '%s' "$minted_token"; }}
              minted_token="$2"
            fi
            ab_workspace_id() {{ printf '%s' '{WORKSPACE}'; }}
            {sync_user(tmp_path / "sync-user")}
            ab_destination_credentials_init
            ab_ensure_destination clickhouse-bronze {DEF_ID} "$1"
            """
            done = subprocess.run(
                ["bash", "-c", script, "bash", json.dumps(config), minted_token],
                capture_output=True,
                text=True,
                check=False,
            )
        finally:
            server.shutdown()
            thread.join()
    assert paths == list(replies)
    assert done.returncode == 1
    assert done.stdout == ""
    return done


@pytest.mark.parametrize("operation", ["create", "update"])
def test_destination_write_reports_http_status_and_validation_details(tmp_path: Path, operation: str) -> None:
    done = _reject_destination_write(
        tmp_path,
        operation=operation,
        status=422,
        error=json.dumps({"message": "Invalid configuration", "validationErrors": [{"field": "cluster_name"}]}),
        config=COMPOSED,
    )

    assert "HTTP 422" in done.stderr
    assert "Invalid configuration" in done.stderr
    assert "cluster_name" in done.stderr


@pytest.mark.parametrize("operation", ["create", "update"])
def test_destination_write_masks_password_values_in_error_details(tmp_path: Path, operation: str) -> None:
    password = 'fixture-"secret"-é'
    another = "fixture-nested-secret"
    config = COMPOSED | {"password": password, "alias": password, "tls": {"keyPassword": another}}
    done = _reject_destination_write(
        tmp_path,
        operation=operation,
        status=422,
        error=json.dumps({"message": f"Invalid {password}", "details": config}),
        config=config,
    )

    assert "[REDACTED]" in done.stderr
    assert "fixture-" not in done.stderr
    assert '"alias": "[REDACTED]"' in done.stderr


def test_destination_write_bounds_an_html_error_to_one_line(tmp_path: Path) -> None:
    done = _reject_destination_write(
        tmp_path, operation="create", status=500, error="<html>\n" + "é" * 800 + "\n</html>", config=COMPOSED
    )

    assert "HTTP 500" in done.stderr
    assert "body=<html>" in done.stderr
    assert len(done.stderr.splitlines()) == 1
    assert len(done.stderr.partition("body=")[2].rstrip("\n").encode()) <= 512


@pytest.mark.parametrize("cause", ["curl: (", "token mint failed"])
def test_destination_write_logs_the_transport_or_token_failure(cause: str) -> None:
    token = "ab_get_token() { return 1; }" if cause == "token mint failed" else "export AIRBYTE_TOKEN=example-token"
    with socket.socket() as closed_port:
        closed_port.bind(("127.0.0.1", 0))
        script = f"""
        export AIRBYTE_URL=http://127.0.0.1:{closed_port.getsockname()[1]}
        source "{ROOT}/lib/airbyte.sh"
        curl() {{ command curl --connect-timeout 1 "$@"; }}
        {token}
        ab__destination_write create example-destination "$1"
        """
        done = subprocess.run(
            ["bash", "-c", script, "bash", json.dumps({"connectionConfiguration": COMPOSED})],
            capture_output=True,
            text=True,
            check=False,
        )
    assert done.returncode == 1
    assert cause in done.stderr
    assert "HTTP 000 body=" in done.stderr


@pytest.mark.parametrize("spelling", ["raw", "json", "unicode", "uppercase", "slash", "url", "form", "html", "entity"])
def test_destination_write_masks_password_spellings_in_non_json(tmp_path: Path, spelling: str) -> None:
    password = 'fixture-"é/<> &amp;plus+"'
    escaped = json.dumps(password, ensure_ascii=True)[1:-1]
    spellings = {
        "raw": password,
        "json": json.dumps(password, ensure_ascii=False)[1:-1],
        "unicode": escaped,
        "uppercase": re.sub(r"\\u([0-9a-f]{4})", lambda match: "\\u" + match[1].upper(), escaped),
        "slash": escaped.replace("/", r"\/"),
        "url": quote(password, safe=""),
        "form": quote_plus(password),
        "html": html.escape(password),
        "entity": html.unescape(password),
    }
    done = _reject_destination_write(
        tmp_path,
        operation="create",
        status=500,
        error=f"<html>{spellings[spelling]}</html>",
        config=COMPOSED | {"password": password},
    )

    assert "HTTP 500 body=<html>[REDACTED]</html>" in done.stderr
    assert "fixture-" not in done.stderr


def test_destination_write_masks_response_secrets_that_were_not_submitted(tmp_path: Path) -> None:
    done = _reject_destination_write(
        tmp_path,
        operation="update",
        status=422,
        config=COMPOSED,
        error=json.dumps(
            {
                "message": "Invalid configuration",
                "details": [
                    {
                        "oldPASSWORD": "example-old-value",
                        "clientSecret": {"value": "example-other-value"},
                        "TOKENs": ["example-token-value"],
                        "field": "password",
                    }
                ],
            }
        ),
    )

    for key in ("oldPASSWORD", "clientSecret", "TOKENs"):
        assert f'"{key}": "[REDACTED]"' in done.stderr
    assert '"field": "password"' in done.stderr
    assert "example-" not in done.stderr


def test_destination_write_masks_the_token_sent_in_the_request(tmp_path: Path) -> None:
    token = "example-minted-bearer"
    done = _reject_destination_write(
        tmp_path,
        operation="create",
        status=422,
        error=json.dumps({"message": f"Invalid Authorization: Bearer {token}"}),
        config=COMPOSED,
        minted_token=token,
    )

    assert "Bearer [REDACTED]" in done.stderr
    assert token not in done.stderr


def _converge(
    tmp_path: Path, current: dict[str, object] | None, *, dry_run: bool = False, route: str = "connection"
) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    answers = tmp_path / "answers"
    answers.mkdir()
    if current is not None:
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
    environment = sync_user(tmp_path / "sync-user", username="etl")
    write_sync_secret(tmp_path / "sync-user", "10", "example-secret")
    command = {
        "explicit": "reconcile_resolve_destination_id jira",
        "connection": "reconcile_connections jira source-1 abcdefabcdef1234 bronze_jira",
        "recreate": "reconcile_recreate_with_state conn-1 source-1 def-1 fixture-source '{}' hash jira bronze_jira",
    }[route]
    script = f"""
    set -uo pipefail
    export AIRBYTE_URL=http://127.0.0.1:1 INSIGHT_NAMESPACE=fixture CONNECTORS_DIR=/nonexistent
    export TMPDIR="{tmp_path}"
    export RECONCILE_DRY_RUN={int(dry_run)}
    source "{ROOT}/lib/reconcile.sh"
    {STUB.format(workspace=WORKSPACE, log=log, answers=answers)}
    {environment}
    {WAREHOUSE_ENV}
    unset RECONCILE_DEST_CLICKHOUSE_DATABASE
    export RECONCILE_DESTINATION_ID={DEST_ID}
    ab_destination_version() {{ printf '%s' '2.1.29'; }}
    ab_list_connections() {{ printf '%s' '{json.dumps([connection])}'; }}
    ab_get_state() {{ printf '%s' '{{}}'; }}
    ab_delete_source() {{ printf 'POST /api/v1/sources/delete\n' >> '{log}'; }}
    ab_create_source() {{ printf 'POST /api/v1/sources/create\n' >> '{log}'; printf '%s' '{{"sourceId":"new-source"}}'; }}
    if [[ "$RECONCILE_DRY_RUN" == "0" ]]; then
      ab_destination_credentials_init || exit 1
    fi
    {command}
    """
    done = subprocess.run(["bash", "-c", script], capture_output=True, text=True, check=False)
    return done, log.read_text().splitlines() if log.exists() else []


@pytest.mark.parametrize("route", ["connection", "explicit"])
@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("host", "other.example.test"),
        ("port", "8443"),
        ("protocol", "https"),
        ("tunnel_method", {"tunnel_method": "SSH_KEY_AUTH", "ssh_key": "example-ssh-key"}),
    ],
    ids=["host", "port", "protocol", "ssh-tunnel"],
)
def test_destination_refuses_writes_to_a_different_warehouse(
    tmp_path: Path, route: str, key: str, value: object
) -> None:
    stored = COMPOSED | {key: value}
    done, lines = _converge(tmp_path, stored, route=route)

    assert [line.split()[1] for line in lines] == ["/api/v1/destinations/get"], (route, key)
    assert done.returncode != 0
    errors = [line for line in done.stderr.splitlines() if line.startswith("ERROR")]
    assert errors == [f"ERROR   jira: Airbyte destination warehouse differs. destination={DEST_ID} fields={key}"]
    assert "example-secret" not in done.stderr
    assert "example-ssh-key" not in done.stderr


@pytest.mark.parametrize("route", ["connection", "explicit"])
def test_credential_updates_keep_the_stored_database_on_the_same_server(tmp_path: Path, route: str) -> None:
    stored = COMPOSED | {"database": "other", "tunnel_method": {"tunnel_method": "NO_TUNNEL"}}
    done, calls = _converge(tmp_path, stored, route=route)

    assert done.returncode == 0, done.stderr
    assert len(calls) == 2
    assert json.loads(calls[1].split(" ", 2)[2])["connectionConfiguration"] == stored | {
        "username": "etl",
        "password": "example-secret",
    }


@pytest.mark.parametrize("destination_available", [True, False], ids=["refused", "unavailable"])
def test_recreate_keeps_the_source_and_connection_when_destination_resolution_fails(
    tmp_path: Path, destination_available: bool
) -> None:
    stored = COMPOSED | {"host": "other.example.test"} if destination_available else None
    done, calls = _converge(tmp_path, stored, route="recreate")

    assert done.returncode != 0
    assert [line.split()[1] for line in calls] == ["/api/v1/destinations/get"]


def test_host_case_and_a_trailing_dot_are_not_destination_drift(tmp_path: Path) -> None:
    done, calls = _ensure(tmp_path, stored=COMPOSED | {"host": "CLICKHOUSE.EXAMPLE.TEST."})

    assert [call[1] for call in calls] == ["/api/v1/destinations/list"]
    assert done.returncode == 0, done.stderr


@pytest.mark.parametrize(
    ("dry_run", "previous_user", "host"),
    [
        (False, "previous", "clickhouse.example.test"),
        (False, "etl", "CLICKHOUSE.EXAMPLE.TEST."),
        (True, "previous", "clickhouse.example.test"),
    ],
)
def test_reconcile_rotates_credentials_on_the_destination_used_by_an_existing_connection(
    tmp_path: Path, dry_run: bool, previous_user: str, host: str
) -> None:
    current = COMPOSED | {"username": previous_user, "password": MASK, "host": host}
    done, calls = _converge(tmp_path, current, dry_run=dry_run)
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == "noop\tconn-1"
    if dry_run:
        assert not calls
        return

    read, update = calls
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
    source "{ROOT}/lib/reconcile.sh"
    {STUB.format(workspace=WORKSPACE, log=log, answers=answers)}
    {sync_user(tmp_path / "sync-user", username="etl")}
    {WAREHOUSE_ENV}
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
        write_sync_secret(tmp_path / "sync-user", version, password)
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
        revision = json.loads(json.loads((tmp_path / "sync-user" / "state.json").read_text())["data"][DEST_ID])
        assert revision == ["example-secret-uid", recorded_version, "password", "etl"]


@pytest.mark.parametrize("stored", [None, COMPOSED | {"cluster_name": "example_previous"}], ids=["create", "update"])
def test_destination_password_is_only_in_stdin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stored: dict[str, object] | None
) -> None:
    import os
    import shlex
    import sys

    binary = tmp_path / "python3"
    args = tmp_path / "argv"
    binary.write_text(
        f'#!/bin/bash\nprintf \'%s\\0\' "$@" >> {shlex.quote(str(args))}\nexec {shlex.quote(sys.executable)} "$@"\n'
    )
    binary.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
    done, calls = _ensure(tmp_path, stored, COMPOSED | {"password": "fixture-password-in-stdin"}, current=False)

    assert done.returncode == 0, done.stderr
    assert b"fixture-password-in-stdin" not in args.read_bytes()
    assert calls[1][2]["connectionConfiguration"]["password"] == "fixture-password-in-stdin"
