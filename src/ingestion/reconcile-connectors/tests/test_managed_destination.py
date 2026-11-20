"""Only the release's own destination definition may change."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
STOCK = {
    "name": "Clickhouse",
    "destinationDefinitionId": "stock-id",
    "dockerRepository": "airbyte/destination-clickhouse",
    "dockerImageTag": "2.1.29",
}
OWN = {
    "name": "Insight ClickHouse instance",
    "destinationDefinitionId": "owned-id",
    "dockerRepository": "local/destination-clickhouse",
    "dockerImageTag": "2.1.29",
}


@pytest.mark.parametrize(
    ("existing", "action"),
    [
        (None, "create_custom"),
        (OWN, None),
        ({**OWN, "dockerImageTag": "2.1.28"}, "update"),
        ({**OWN, "dockerRepository": "other/destination"}, "refuse"),
    ],
)
def test_reconcile_converges_only_its_own_definition(tmp_path, existing, action):
    rows = [STOCK] + ([existing] if existing else [])
    (tmp_path / "listing").write_text(json.dumps({"destinationDefinitions": rows}))
    (tmp_path / "response").write_text(json.dumps(OWN))
    script = """
set -euo pipefail
source "$RECONCILE_ROOT/lib/airbyte.sh"
ab_workspace_id() { printf 'workspace'; }
ab__curl() {
  if [[ "$2" == */list_for_workspace ]]; then cat "$ANSWERS/listing"; return; fi
  printf '%s\\n%s' "$2" "$3" >"$ANSWERS/call"
  cat "$ANSWERS/response"
}
ab_managed_destination_definition
"""
    result = subprocess.run(
        ["bash", "-c", script],
        env={
            **os.environ,
            "RECONCILE_ROOT": str(ROOT),
            "AIRBYTE_URL": "http://airbyte.local",
            "ANSWERS": str(tmp_path),
            "INSIGHT_DESTINATION_OWNER": "instance",
            "INSIGHT_DESTINATION_REPOSITORY": OWN["dockerRepository"],
            "INSIGHT_DESTINATION_TAG": OWN["dockerImageTag"],
        },
        capture_output=True,
        text=True,
        check=False,
    )
    call = tmp_path / "call"
    if action == "refuse":
        assert result.returncode != 0 and not call.exists()
        return
    assert result.returncode == 0, result.stderr
    assert result.stdout == "owned-id\t2.1.29"
    if action:
        path, body = call.read_text().splitlines()
        assert path.endswith("/" + action)
        assert "stock-id" not in body
        assert json.loads(body)["workspaceId"] == "workspace"
    else:
        assert not call.exists()


@pytest.mark.parametrize(
    ("modes", "managed"),
    [(["append", "append_dedup"], True), (["append", "overwrite"], False), (["update"], False), ([], False)],
)
def test_only_a_selected_append_catalog_uses_the_instrumented_destination(modes, managed):
    from test_destination_version import RECONCILE_ENV

    catalog = {"streams": [{"config": {"selected": True, "destinationSyncMode": mode}} for mode in modes]}
    script = (
        RECONCILE_ENV
        + """
source "$RECONCILE_ROOT/lib/reconcile.sh"
ab_destination_definition_by_name() { printf 'stock\t2.1.29'; }
ab_managed_destination_definition() { printf 'tagged\t2.1.29'; }
ab_ensure_destination() { printf '%s' "$2"; }
reconcile_resolve_destination_id jira "$CATALOG"
"""
    )
    result = subprocess.run(
        ["bash", "-c", script],
        env={
            **os.environ,
            "RECONCILE_ROOT": str(ROOT),
            "CATALOG": json.dumps(catalog),
            "INSIGHT_DESTINATION_REPOSITORY": "example/tagged",
            "INSIGHT_DESTINATION_OWNER": "release",
        },
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == ("tagged" if managed else "stock")
