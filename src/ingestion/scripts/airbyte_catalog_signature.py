"""Fingerprint the selection and sync modes of an Airbyte connection."""

from __future__ import annotations

import hashlib
import json
import sys


def signature(connection: dict) -> str:
    streams = (connection.get("syncCatalog") or {}).get("streams")
    if not isinstance(streams, list):
        return ""
    selected = {}
    for entry in streams:
        if not isinstance(entry, dict) or not isinstance(config := entry.get("config"), dict):
            return ""
        if config.get("selected") is False:
            continue
        if config.get("selected") is not True or not isinstance(stream := entry.get("stream"), dict):
            return ""
        name = stream.get("name")
        namespace = stream.get("namespace")
        if not isinstance(name, str) or not name or (namespace is not None and not isinstance(namespace, str)):
            return ""
        key = (namespace or "", name)
        mode, dest = config.get("syncMode"), config.get("destinationSyncMode")
        if key in selected or not isinstance(mode, str) or not mode or not isinstance(dest, str) or not dest:
            return ""
        selected[key] = mode, dest
    if not selected:
        return ""
    items = [(*key, *selected[key]) for key in sorted(selected)]
    return hashlib.sha256(json.dumps(items, ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()


if __name__ == "__main__":
    try:
        print(signature(json.load(sys.stdin)))  # noqa: T201 -- feeds the Argo output parameter.
    except (AttributeError, ValueError, TypeError):
        sys.exit(1)
