"""Prepare the source actor and verify whether a failed Bronze sync may be repeated."""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
from decimal import Decimal

import insight_logging
import stage_admission
from airbyte_auth import FatalError, airbyte_api_url, oauth_token


def airbyte(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        airbyte_api_url() + "/api/v1/" + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + oauth_token()},
    )
    # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
    with urllib.request.urlopen(req, timeout=30) as reply:
        return json.load(reply)


def connection() -> dict:
    connection_id = os.environ["CONNECTION_ID"]
    live = airbyte("connections/get", {"connectionId": connection_id})
    if live.get("connectionId") != connection_id or not live.get("sourceId"):
        raise ValueError("Airbyte returned a different or incomplete connection")
    return live


def quantity(value: str) -> Decimal:
    """Compare Kubernetes resource quantities without discarding fractional CPUs."""
    match = re.fullmatch(r"([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)([numkKMGTPE]i?)?", value)
    if not match:
        raise ValueError("unrecognized existing Airbyte resource quantity")
    suffix = match[2] or ""
    if suffix in {"n", "u", "m"}:
        return Decimal(match[1]) * Decimal(10) ** {"n": -9, "u": -6, "m": -3}[suffix]
    if not suffix:
        return Decimal(match[1])
    exponent = "KMGTPE".index(suffix[0].upper()) + 1
    return Decimal(match[1]) * (1024 if suffix.endswith("i") else 1000) ** exponent


def prepare_source() -> None:
    live = connection()
    source_id = live["sourceId"]
    source = airbyte("sources/get", {"sourceId": source_id})
    if source.get("sourceId") != source_id:
        raise ValueError("Airbyte returned a different source")
    if (count := source.get("numConnections")) is None:
        siblings = airbyte(
            "web_backend/connections/list",
            {"workspaceId": source["workspaceId"], "sourceId": [source_id], "pageSize": 2},
        )
        count = siblings["num_connections"]
        if count == 1 and [c.get("connectionId") for c in siblings["connections"]] != [live["connectionId"]]:
            raise ValueError("Airbyte did not confirm the connection that owns this source")
    if count != 1:
        if os.environ["ADMISSION_ATTEMPT"] == "1":
            return
        raise ValueError("Airbyte source resource changes require a dedicated source")
    allocation = source.get("resourceAllocation") or {}
    jobs = allocation.setdefault("jobSpecific", [])
    entries = [job for job in jobs if job.get("jobType") == "sync"]
    if len(entries) > 1:
        raise ValueError("ambiguous source sync resources")
    sync = entries[0] if entries else {"jobType": "sync", "resourceRequirements": {}}
    requirements = sync["resourceRequirements"]
    inherited = allocation.get("default") or {}
    overrides = live.get("resourceRequirements") or {}
    cpu = int(os.environ["AIRBYTE_SOURCE_CPU_MILLIS"])
    memory = int(os.environ["AIRBYTE_SOURCE_MEMORY_BYTES"])
    if min(cpu, memory) <= 0:
        raise ValueError("invalid source allocation")
    if any(overrides.get(field) for field in ("cpu_request", "cpu_limit", "memory_request", "memory_limit")):
        if (
            os.environ["ADMISSION_ATTEMPT"] != "1"
            and overrides.get("memory_limit")
            and quantity(overrides["memory_limit"]) < memory
        ):
            raise ValueError("the connection overrides the corrected source limit")
        return
    definition_id = source["sourceDefinitionId"]
    definition = airbyte("source_definitions/get", {"sourceDefinitionId": definition_id})
    if definition.get("sourceDefinitionId") != definition_id:
        raise ValueError("Airbyte returned a different source definition")
    definition_resources = definition.get("resourceRequirements") or {}
    definition_floors = dict(definition_resources.get("default") or {})
    for entry in definition_resources.get("jobSpecific", []):
        if entry.get("jobType") == "sync":
            definition_floors.update(entry.get("resourceRequirements") or {})
    updated = False
    for field, target in (
        ("cpu_request", f"{cpu}m"),
        ("cpu_limit", f"{cpu}m"),
        ("memory_request", str(memory)),
        ("memory_limit", str(memory)),
    ):
        previous = requirements.get(field) or definition_floors.get(field)
        if inherited.get(field) and quantity(inherited[field]) > quantity(target):
            target = inherited[field]
        if previous and quantity(previous) >= quantity(target):
            continue
        requirements[field] = target
        updated = True
    if updated:
        if not entries:
            jobs.append(sync)
        result = airbyte("sources/partial_update", {"sourceId": source_id, "resourceAllocation": allocation})
        if result.get("sourceId") != source_id or (result.get("resourceAllocation") or {}).get("jobSpecific") != jobs:
            raise ValueError("Airbyte did not confirm the requested source resources")


def replay_mode_safe(live: dict) -> bool:
    streams = (live.get("syncCatalog") or {}).get("streams")
    if not isinstance(streams, list) or not streams or live.get("isDataActivation"):
        return False
    return all(
        isinstance(stream, dict)
        and isinstance(config := stream.get("config"), dict)
        and config.get("syncMode") == "incremental"
        and config.get("destinationSyncMode") in ("append", "append_dedup")
        for stream in streams
    )


def retry_allowed() -> bool:
    safe = replay_mode_safe(connection())
    limit = time.monotonic() + 300
    while True:
        decision = stage_admission.request("POST", "/airbyte-retry", replay_mode_safe=safe).get("decision")
        if decision == "retry":
            return safe
        if decision == "stop":
            return False
        if decision != "verify":
            raise stage_admission.AdmissionError("invalid retry decision")
        if time.monotonic() >= limit:
            return False
        time.sleep(10)


if __name__ == "__main__":
    try:
        if sys.argv[1] == "prepare":
            prepare_source()
        elif sys.argv[1] == "retry":
            sys.exit(0 if retry_allowed() else 1)
        else:
            raise ValueError("unknown Airbyte admission action")
    except (ValueError, KeyError, OSError, RuntimeError, FatalError, stage_admission.AdmissionError):
        insight_logging.configure("airbyte-admission").exception("Airbyte stage could not proceed")
        sys.exit(1)
