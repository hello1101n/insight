#!/usr/bin/env python3
"""Select the connector settings of one instance from a ConfigMap listing.

CLI:
  connector_settings.py --connector NAME --source-id ID --fields JSON --secret-keys JSON

Stdin:  `kubectl get configmap -l app.kubernetes.io/part-of=insight -o json`.
Stdout: the `data` of the instance's settings ConfigMap as a JSON object, or `{}`.
Exit:   0 on success, 1 when the settings are unusable (the reason is on stderr).

A settings ConfigMap carries the same two annotations as the connector Secret.
It holds non-secret source config fields that the descriptor lists under
`settings.fields`. The reconciler adds them to the source config and to the
cfg-hash, so a changed ConfigMap updates the source on the next tick.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass

CONNECTOR_ANNOTATION = "insight.cyberfabric.com/connector"
SOURCE_ID_ANNOTATION = "insight.cyberfabric.com/source-id"
PLATFORM_FIELDS = frozenset({"insight_tenant_id", "insight_source_id"})


class SettingsError(Exception):
    pass


@dataclass(frozen=True)
class Instance:
    connector: str
    source_id: str


def instance_settings(
    listing: dict, instance: Instance, allowed_fields: frozenset[str], secret_keys: frozenset[str]
) -> dict[str, str]:
    matches = [item for item in listing.get("items") or [] if _names(item) == instance]
    if not matches:
        return {}
    if len(matches) > 1:
        names = sorted(_metadata(item).get("name", "") for item in matches)
        raise SettingsError(f"{len(matches)} settings ConfigMaps name this instance: {', '.join(names)}")

    data = matches[0].get("data") or {}
    _check_fields(set(data), allowed_fields, secret_keys)
    return {key: str(value) for key, value in data.items()}


def _check_fields(fields: set[str], allowed_fields: frozenset[str], secret_keys: frozenset[str]) -> None:
    undeclared = sorted(fields - allowed_fields)
    if undeclared:
        raise SettingsError(f"fields not in the descriptor settings.fields: {', '.join(undeclared)}")
    shadowed = sorted(fields & (secret_keys | PLATFORM_FIELDS))
    if shadowed:
        raise SettingsError(f"fields also set by the Secret or the platform: {', '.join(shadowed)}")


def _metadata(item: dict) -> dict:
    return item.get("metadata") or {}


def _names(item: dict) -> Instance:
    annotations = _metadata(item).get("annotations") or {}
    return Instance(annotations.get(CONNECTOR_ANNOTATION, ""), annotations.get(SOURCE_ID_ANNOTATION, ""))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--connector", required=True)
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--fields", default="[]")
    parser.add_argument("--secret-keys", default="[]")
    args = parser.parse_args()

    try:
        listing = json.loads(sys.stdin.read() or "{}") or {}
        allowed_fields = frozenset(json.loads(args.fields))
        secret_keys = frozenset(json.loads(args.secret_keys))
        settings = instance_settings(listing, Instance(args.connector, args.source_id), allowed_fields, secret_keys)
    except json.JSONDecodeError as exc:
        print(f"connector_settings: bad JSON: {exc}", file=sys.stderr)
        return 1
    except SettingsError as exc:
        print(f"connector_settings: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(settings, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
