"""Write a settings ConfigMap that puts every unreviewed HubSpot property in ``ignore``.

Run from the connector directory:

    HUBSPOT_ACCESS_TOKEN=... uv run python tools/selection_baseline.py \
        --source-id main [--name NAME] [--existing current.yaml] > hubspot-main.yaml

The script reads property definitions only, never property values. Existing
decisions stay. Review the result: move to ``collect`` each property that
Insight must store.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import yaml
from source_hubspot.api import Hubspot
from source_hubspot.constants import PROPERTY_DEFINITION_OBJECT_TYPES
from source_hubspot.selection import (
    PropertySelection,
    parse_property_selection,
    selection_json,
    with_unreviewed_ignored,
)

FIELD = "hubspot_property_selection"


class _Literal(str):
    __slots__ = ()


def _literal_block(dumper: yaml.SafeDumper, value: _Literal) -> yaml.ScalarNode:
    return dumper.represent_scalar("tag:yaml.org,2002:str", value, style="|")


def existing_selection(path: Path | None) -> PropertySelection:
    if path is None:
        return PropertySelection()
    document = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return parse_property_selection((document.get("data") or {}).get(FIELD))


def configmap(name: str, source_id: str, selection: PropertySelection) -> str:
    document = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {
            "name": name,
            "labels": {"app.kubernetes.io/part-of": "insight"},
            "annotations": {
                "insight.cyberfabric.com/connector": "hubspot",
                "insight.cyberfabric.com/source-id": source_id,
            },
        },
        "data": {FIELD: _Literal(selection_json(selection))},
    }
    dumper = yaml.SafeDumper
    dumper.add_representer(_Literal, _literal_block)
    return yaml.dump(document, Dumper=dumper, sort_keys=False)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--existing", type=Path)
    parser.add_argument("--name", help="ConfigMap name; the default is insight-hubspot-<source-id>-settings")
    args = parser.parse_args()

    token = os.environ.get("HUBSPOT_ACCESS_TOKEN")
    if not token:
        sys.stderr.write("selection_baseline: set HUBSPOT_ACCESS_TOKEN\n")
        return 2

    hubspot = Hubspot(access_token=token)
    defined = {object_type: hubspot.properties_for(object_type) for object_type in PROPERTY_DEFINITION_OBJECT_TYPES}
    selection = with_unreviewed_ignored(existing_selection(args.existing), defined)
    name = args.name or f"insight-hubspot-{args.source_id}-settings"
    sys.stdout.write(configmap(name, args.source_id, selection))
    return 0


if __name__ == "__main__":
    sys.exit(main())
