"""Connector admission client for the ingestion Workflow."""

from __future__ import annotations

import http.client
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

import insight_logging

TOKEN = Path("/var/run/secrets/insight-connectors/token")
BASE_PATH = "/v1/ingestion/stage-requests"


class AdmissionError(Exception):
    pass


def stage_identity() -> dict:
    identity = {
        "sync_id": os.environ["SYNC_ID"],
        "workflow_name": os.environ["WORKFLOW_NAME"],
        "connector": os.environ["ADMISSION_CONNECTOR"],
        "source_id": os.environ["ADMISSION_SOURCE_ID"],
        "stage": os.environ["ADMISSION_STAGE"],
        "attempt": int(os.environ["ADMISSION_ATTEMPT"]),
    }
    if connection_id := os.environ.get("CONNECTION_ID"):
        identity["connection_id"] = connection_id
    return identity


def _exchange(method: str, path: str, body: dict) -> dict:
    url = urlsplit(os.environ["STAGE_ADMISSION_URL"])
    if url.scheme not in ("http", "https") or not url.hostname or url.path not in ("", "/") or url.username:
        raise AdmissionError("invalid connectors endpoint")
    transport = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
    conn = transport(url.hostname, url.port, timeout=30)
    try:
        headers = {"Content-Type": "application/json", "Authorization": "Bearer " + TOKEN.read_text().strip()}
        conn.request(method, BASE_PATH + path, json.dumps(body).encode(), headers)
        response = conn.getresponse()
        if response.status == 429 or 500 <= response.status < 600:
            raise ConnectionError(f"connectors temporarily unavailable: HTTP {response.status}")
        if not 200 <= response.status < 300:
            raise AdmissionError(f"connectors refused {method} {BASE_PATH + path}: HTTP {response.status}")
        payload = response.read()
        if not payload:
            return {}
        result = json.loads(payload)
        if not isinstance(result, dict):
            raise AdmissionError("invalid response from connectors")
        return result
    finally:
        conn.close()


def request(method: str, path: str = "", *, max_wait_seconds: int | None = 180, **fields) -> dict:
    body = {**stage_identity(), **fields}
    deadline = time.monotonic() + max_wait_seconds if max_wait_seconds is not None else None
    delay = 1
    while True:
        try:
            return _exchange(method, path, body)
        except (OSError, http.client.HTTPException):
            remaining = deadline - time.monotonic() if deadline is not None else delay
            if remaining <= 0:
                raise
            time.sleep(min(delay, remaining))
            delay = min(delay * 2, 20)


def claim(sender: str | None = None) -> tuple[str, int | None]:
    reply = request("POST", "/airbyte-claim", max_wait_seconds=None, **({"sender": sender} if sender else {}))
    decision = reply.get("decision")
    if decision == "poll" and valid_job_id(reply.get("job_id")):
        return decision, int(reply["job_id"])
    if decision in ("send", "verify"):
        return decision, None
    raise AdmissionError("invalid Airbyte claim result")


def valid_job_id(value: object) -> bool:
    return (
        type(value) is int
        and value > 0
        or isinstance(value, str)
        and value.isascii()
        and value.isdecimal()
        and int(value) > 0
    )


def recover_job_id() -> int:
    while True:
        decision, job_id = claim()
        if decision == "poll" and job_id is not None:
            return job_id
        if decision != "verify":
            raise AdmissionError("inconsistent claim for an already attempted Airbyte launch")
        time.sleep(15)


def register() -> str:
    mode = os.environ.get("CONNECTION_MODE_SIGNATURE") if os.environ["ADMISSION_STAGE"] == "bronze" else None
    result = request("POST", **({"mode_signature": mode} if mode else {}))
    if result.get("decision") not in ("granted", "queued"):
        raise AdmissionError("invalid stage admission decision")
    resources = result.get("resources")
    if not isinstance(resources, dict):
        raise AdmissionError("missing stage resources")
    keys = ["cpu_millis", "memory_bytes"]
    if os.environ["ADMISSION_STAGE"] == "bronze":
        keys.extend(["source_cpu_millis", "source_memory_bytes"])
    for key in keys:
        value = resources.get(key)
        if type(value) is not int or value <= 0:
            raise AdmissionError(f"invalid stage resource: {key}")
        Path(f"/tmp/admission-{key}").write_text(str(value))
    return result["decision"]


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["work-start"]:
            if os.environ.get("ADMISSION_STAGE"):
                request("POST", "/work-start")
        else:
            print(register())  # noqa: T201 -- stdout supplies the gate's Argo outputs.result.
    except (AdmissionError, OSError, ValueError, http.client.HTTPException) as error:
        insight_logging.configure("stage-admission").error("cannot register stage: %s", error)
        sys.exit(1)
