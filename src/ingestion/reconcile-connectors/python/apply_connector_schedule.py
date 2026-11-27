from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING

import yaml
from instance_resources import AIRBYTE_MANAGED, InstanceResources, render_resources
from read_connector_schedules import ScheduleReadError, validate_response
from schedule_database import connect
from schedule_lock import LOCK_TIMEOUT_SECS, instance_lock

if TYPE_CHECKING:
    import pymysql


def apply(manifest: str) -> None:
    subprocess.run(["kubectl", "apply", "-f", "-"], input=manifest, text=True, check=True, timeout=60)


def render_schedule(manifest: str, crons: tuple[str, ...]) -> str:
    document = yaml.safe_load(manifest)
    if crons:
        document["spec"]["schedules"] = list(crons)
        document["metadata"]["annotations"]["insight.cyberfabric.com/schedule-origin"] = "api"
    return yaml.safe_dump(document, sort_keys=False)


def create(manifest: str) -> None:
    subprocess.run(["kubectl", "create", "-f", "-"], input=manifest, text=True, check=True, timeout=60)


def manages_airbyte_sizes(manifest: str) -> bool:
    metadata = yaml.safe_load(manifest)["metadata"]
    annotation = AIRBYTE_MANAGED.replace(".", r"\.")
    ownership = f"{{.metadata.annotations.{annotation}}}"
    settings = '{.spec.workflowSpec.arguments.parameters[?(@.name=="sync_resources")].value}'
    result = subprocess.run(
        [
            "kubectl",
            "-n",
            metadata["namespace"],
            "get",
            "cronworkflow",
            metadata["name"],
            "--ignore-not-found",
            "-o",
            f'jsonpath={ownership}{{"\\n"}}{settings}',
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    managed, _, resources = result.stdout.partition("\n")
    if managed == "true":
        return True
    return bool(resources) and InstanceResources.model_validate_json(resources).has_airbyte_sizes()


def clear_airbyte_sizes(connection_id: str) -> None:
    script = Path(__file__).resolve().parents[2] / "scripts/airbyte_resources.py"
    subprocess.run([sys.executable, str(script), connection_id], check=True, timeout=120)


def deploy(
    manifest: str, requested: InstanceResources, defaults: InstanceResources, *, submit: bool, connection_id: str | None
) -> None:
    if submit:
        create(render_resources(manifest, requested, defaults, cron=False))
        return
    clear = (
        connection_id is not None
        and not requested.over(defaults).has_airbyte_sizes()
        and manages_airbyte_sizes(manifest)
    )
    apply(render_resources(manifest, requested, defaults, cron=True, managed=clear))
    if clear and connection_id is not None:
        clear_airbyte_sizes(connection_id)


def locked_apply(
    connection: pymysql.Connection,
    connector: str,
    source_id: str,
    manifest: str,
    defaults: InstanceResources,
    *,
    submit: bool,
    connection_id: str | None,
) -> None:
    with instance_lock(connection, connector, source_id), connection.cursor() as cursor:
        cursor.execute(
            "SELECT connector, source_id, revision, "
            "CASE WHEN OCTET_LENGTH(crons) <= 4096 THEN crons ELSE NULL END, "
            "CASE WHEN OCTET_LENGTH(resources) > 1024 THEN 'null' ELSE resources END "
            "FROM connector_schedule_requests_v2 WHERE connector = %s AND source_id = %s",
            (connector, source_id),
        )
        rows = cursor.fetchall()
        entries = [dict(connector=c, source_id=s, revision=r, crons=json.loads(raw)) for c, s, r, raw, _ in rows]
        schedules = validate_response({"version": 1, "schedules": entries})
        requested = InstanceResources.model_validate_json(rows[0][4] or "{}") if schedules else InstanceResources()

        if not submit:
            manifest = render_schedule(manifest, schedules[0].crons if schedules else ())
        deploy(manifest, requested, defaults, submit=submit, connection_id=connection_id)


def run(
    env: Mapping[str, str],
    connector: str,
    source_id: str,
    manifest: str,
    *,
    submit: bool = False,
    connection_id: str | None = None,
) -> None:
    defaults = InstanceResources.model_validate_json(env.get("CONNECTOR_RESOURCE_DEFAULTS") or "{}")
    if not any(key.startswith("CONNECTOR_SCHEDULES_DB_") for key in env):
        deploy(manifest, InstanceResources(), defaults, submit=submit, connection_id=connection_id)
        return
    with connect(env, lock_timeout_secs=LOCK_TIMEOUT_SECS) as connection:
        locked_apply(connection, connector, source_id, manifest, defaults, submit=submit, connection_id=connection_id)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--connector", required=True)
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--create", action="store_true")
    parser.add_argument("--connection-id")
    args = parser.parse_args()
    try:
        run(
            os.environ,
            args.connector,
            args.source_id,
            sys.stdin.read(),
            submit=args.create,
            connection_id=args.connection_id,
        )
    except Exception as error:
        reason = str(error) if isinstance(error, ScheduleReadError) else type(error).__name__
        print(f"schedule apply failed: {reason}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
