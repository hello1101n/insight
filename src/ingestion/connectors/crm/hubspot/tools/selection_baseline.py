"""Write chart values that put every unreviewed HubSpot property in ``ignore``.

Run from the connector directory:

    HUBSPOT_ACCESS_TOKEN=... uv run python tools/selection_baseline.py \
        --source-id main [--existing connector-settings.yaml] > connector-settings.yaml

The output sets ``ingestion.reconcile.connectorSettings``; pass it to Helm with
``-f``. The script reads property definitions only, never property values.
Existing decisions and the entries of other instances stay. Review the result:
move to ``collect`` each property that Insight must store.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any

import yaml
from source_hubspot.api import Hubspot
from source_hubspot.constants import PROPERTY_DEFINITION_OBJECT_TYPES
from source_hubspot.selection import (
    PropertySelection,
    parse_property_selection,
    selection_json,
    with_unreviewed_ignored,
)

CONNECTOR = "hubspot"
FIELD = "hubspot_property_selection"


class _Literal(str):
    __slots__ = ()


def _literal_block(dumper: yaml.SafeDumper, value: _Literal) -> yaml.ScalarNode:
    return dumper.represent_scalar("tag:yaml.org,2002:str", value, style="|")


def _is_instance(entry: dict[str, Any], source_id: str) -> bool:
    return entry.get("connector") == CONNECTOR and entry.get("sourceId") == source_id


def connector_settings(values: dict[str, Any]) -> list[dict[str, Any]]:
    return ((values.get("ingestion") or {}).get("reconcile") or {}).get("connectorSettings") or []


def existing_selection(entries: list[dict[str, Any]], source_id: str) -> PropertySelection:
    for entry in entries:
        if _is_instance(entry, source_id):
            return parse_property_selection((entry.get("data") or {}).get(FIELD))
    return PropertySelection(objects={})


def values_document(entries: list[dict[str, Any]], source_id: str, selection: PropertySelection) -> str:
    entry = {"connector": CONNECTOR, "sourceId": source_id, "data": {FIELD: _Literal(selection_json(selection))}}
    others = [existing for existing in entries if not _is_instance(existing, source_id)]
    document = {"ingestion": {"reconcile": {"connectorSettings": [*others, entry]}}}
    dumper = yaml.SafeDumper
    dumper.add_representer(_Literal, _literal_block)
    return yaml.dump(document, Dumper=dumper, sort_keys=False)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--existing", type=Path, help="values file with the current connectorSettings")
    args = parser.parse_args()

    token = os.environ.get("HUBSPOT_ACCESS_TOKEN")
    if not token:
        sys.stderr.write("selection_baseline: set HUBSPOT_ACCESS_TOKEN\n")
        return 2

    values = yaml.safe_load(args.existing.read_text(encoding="utf-8")) or {} if args.existing else {}
    entries = connector_settings(values)
    hubspot = Hubspot(access_token=token)
    defined = {object_type: hubspot.properties_for(object_type) for object_type in PROPERTY_DEFINITION_OBJECT_TYPES}
    selection = with_unreviewed_ignored(existing_selection(entries, args.source_id), defined)
    sys.stdout.write(values_document(entries, args.source_id, selection))
    return 0


if __name__ == "__main__":
    sys.exit(main())
