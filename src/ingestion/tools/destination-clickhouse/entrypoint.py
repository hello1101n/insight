#!/usr/bin/env python3
import json
import os
import sys
import tempfile
from pathlib import Path

GENERATION = ("generation_id", "minimum_generation_id", "sync_id")


def append_catalog(catalog, job_id):
    streams = catalog["streams"]
    missing = [s for s in streams if any(s.get(k) is None for k in GENERATION)]
    if not missing:
        return False
    if not job_id or not job_id.isascii() or not job_id.isdecimal() or int(job_id) < 1:
        raise ValueError("Missing Airbyte Job ID for legacy append catalog")
    if any(s.get("destination_sync_mode") not in ("append", "append_dedup") for s in streams):
        raise ValueError("Airbyte generation metadata required for refresh or overwrite")
    if any(any(s.get(k) is not None for k in GENERATION) for s in streams):
        raise ValueError("Incomplete Airbyte generation metadata")
    for stream in streams:
        stream.update(generation_id=0, minimum_generation_id=0, sync_id=int(job_id))
    return True


def main():
    args = sys.argv[1:]
    if args[:1] == ["write"] and "--catalog" in args:
        index = args.index("--catalog") + 1
        catalog = json.loads(Path(args[index]).read_bytes())
        if append_catalog(catalog, os.environ.get("WORKER_JOB_ID")):
            with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as output:
                json.dump(catalog, output)
                args[index] = output.name
    os.execv("/airbyte/base.sh", ["/airbyte/base.sh", *args])


if __name__ == "__main__":
    main()
