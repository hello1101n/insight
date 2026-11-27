"""Settings ConfigMap of a connector instance: selection, validation and the push on change.

Run: pytest src/ingestion/reconcile-connectors/tests
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest
from connector_settings import Instance, SettingsError, instance_settings
from reconcile_inputs import sync_user

ROOT = Path(__file__).resolve().parents[1]
CONNECTOR_DIR = ROOT.parent / "connectors" / "crm" / "hubspot"
TENANT = "example-tenant"
SOURCE_NAME = f"hubspot-main-{TENANT}"
SECRET_HASH = "d" * 64
DESTINATION = "dest-1"
HUBSPOT_MAIN = Instance("hubspot", "main")
FIELDS = frozenset({"hubspot_property_selection"})


def configmap(name: str, data: dict, connector: str = "hubspot", source_id: str = "main") -> dict:
    return {
        "metadata": {
            "name": name,
            "annotations": {
                "insight.cyberfabric.com/connector": connector,
                "insight.cyberfabric.com/source-id": source_id,
            },
        },
        "data": data,
    }


SELECTION = json.dumps({"deals": {"collect": ["deal_type"]}})


class TestInstanceSettings:
    def test_settings_come_from_the_configmap_that_names_the_instance(self):
        listing = {
            "items": [
                configmap("other-source", {"hubspot_property_selection": "{}"}, source_id="eu"),
                configmap("other-connector", {"hubspot_property_selection": "{}"}, connector="zendesk"),
                configmap("insight-hubspot-main-settings", {"hubspot_property_selection": SELECTION}),
            ]
        }
        assert instance_settings(listing, HUBSPOT_MAIN, FIELDS, frozenset()) == {
            "hubspot_property_selection": SELECTION
        }

    @pytest.mark.parametrize("listing", [{}, {"items": []}, {"items": [configmap("x", {}, source_id="eu")]}])
    def test_no_configmap_means_no_settings(self, listing):
        assert instance_settings(listing, HUBSPOT_MAIN, FIELDS, frozenset()) == {}

    @pytest.mark.parametrize(
        ("listing", "secret_keys"),
        [
            ({"items": [configmap("a", {}), configmap("b", {})]}, frozenset()),
            ({"items": [configmap("a", {"hubspot_start_date": "2024-01-01"})]}, frozenset()),
            ({"items": [configmap("a", {"hubspot_property_selection": SELECTION})]}, FIELDS),
            ({"items": [configmap("a", {"insight_tenant_id": "x"})]}, frozenset()),
        ],
    )
    def test_unusable_settings_are_rejected(self, listing, secret_keys):
        with pytest.raises(SettingsError):
            instance_settings(listing, HUBSPOT_MAIN, FIELDS | {"insight_tenant_id"}, secret_keys)


STUBS = """
kubectl() {
  case "$*" in
    'apply -f -') cat > "$APPLIED_YAML" ;;
    *'get configmap'*) cat "$CONFIGMAPS" ;;
    *) printf '{"stringData": {"hubspot_access_token": "t"}}' ;;
  esac
}
valsec_check_secret()    { return 0; }
reconcile_definitions()  { printf 'noop\\tnone\\tdef-1\\n'; }
reconcile_rename_former_tenant() { return 0; }
reconcile_classify_change() { printf 'noop'; }
reconcile_resolve_schedule() { printf 'annotation\\n0 6 * * *'; }
ab_workspace_id()        { printf 'ws-1'; }
ab_list_sources()        { cat "$SOURCES"; }
ab_list_connections()    { cat "$CONNECTIONS"; }
ab_update_source()       { printf 'UPDATE_SOURCE %s %s\\n' "$1" "$2" >> "$CALLS"; }
argo_delete_former_tenant_cronworkflows() { return 0; }
argo_submit_sync_trigger() { printf 'SYNC_TRIGGER %s\\n' "$1" >> "$CALLS"; }
adopt_tag_connection() {
  printf 'TAG %s\\n' "${2:0:12}" >> "$CALLS"
  python3 - "$CONNECTIONS" "$2" <<'PY'
import json, sys
path, cfg_hash = sys.argv[1], sys.argv[2][:12]
connections = json.load(open(path))
connections[0]["tags"] = [{"name": "insight"}, {"name": f"cfg-hash:{cfg_hash}"}]
json.dump(connections, open(path, "w"))
PY
}
"""


def tick(tmp_path: Path, items: list[dict]) -> tuple[int, list[str]]:
    calls = tmp_path / "calls"
    calls.unlink(missing_ok=True)
    (tmp_path / "configmaps.json").write_text(json.dumps({"items": items}), encoding="utf-8")
    script = f"""
    set -uo pipefail
    export INSIGHT_NAMESPACE=insight INSIGHT_TENANT_ID={TENANT} CONNECTORS_DIR="{ROOT.parent / "connectors"}"
    export AIRBYTE_URL=http://127.0.0.1:1 CONFIGMAPS="{tmp_path / "configmaps.json"}"
    export SOURCES="{tmp_path / "sources.json"}" CONNECTIONS="{tmp_path / "connections.json"}" CALLS="{calls}"
    export APPLIED_YAML="{tmp_path / "applied.yaml"}" ARGO_SERVICE_ACCOUNT=example-account
    source "{ROOT}/lib/reconcile.sh"
    {STUBS}
    {sync_user(tmp_path / "sync-user", DESTINATION)}
    ab_destination_credentials_init || exit 1
    _reconcile_one_connector hubspot "{CONNECTOR_DIR}" 3.10.0 cdk "" "" \\
      bronze_hubspot main insight-hubspot-main {SECRET_HASH} 0 0 "" ""
    """
    result = subprocess.run(
        ["bash", "-c", script],
        env={key: value for key, value in os.environ.items() if not key.startswith("CONNECTOR_SCHEDULES_DB_")},
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode, calls.read_text(encoding="utf-8").splitlines() if calls.exists() else []


def seed(tmp_path: Path) -> None:
    source = {"sourceId": "src-1", "name": SOURCE_NAME, "sourceDefinitionId": "def-1", "connectionConfiguration": {}}
    connection = {
        "connectionId": "conn-1",
        "sourceId": "src-1",
        "destinationId": DESTINATION,
        "name": f"{SOURCE_NAME}-conn",
        "tags": [{"name": "insight"}],
    }
    (tmp_path / "sources.json").write_text(json.dumps([source]), encoding="utf-8")
    (tmp_path / "connections.json").write_text(json.dumps([connection]), encoding="utf-8")


def pushed_config(calls: list[str]) -> dict:
    pushes = [c for c in calls if c.startswith("UPDATE_SOURCE ")]
    assert len(pushes) == 1, calls
    return json.loads(pushes[0].split(" ", 2)[2])


def test_a_changed_configmap_is_pushed_once_with_the_source_config(tmp_path: Path) -> None:
    seed(tmp_path)
    first = [configmap("insight-hubspot-main-settings", {"hubspot_property_selection": SELECTION})]
    changed_selection = json.dumps({"deals": {"collect": ["deal_type"], "ignore": ["notes_field"]}})
    second = [configmap("insight-hubspot-main-settings", {"hubspot_property_selection": changed_selection})]

    _, adopted = tick(tmp_path, first)
    _, steady = tick(tmp_path, first)
    _, changed = tick(tmp_path, second)
    _, settled = tick(tmp_path, second)

    assert pushed_config(adopted)["hubspot_property_selection"] == SELECTION, adopted
    assert steady == [], f"a tick without a change must not touch the source: {steady}"
    assert pushed_config(changed)["hubspot_property_selection"] == changed_selection, changed
    assert "SYNC_TRIGGER hubspot" in changed, f"a changed selection syncs: {changed}"
    assert settled == [], f"the tick after a change is steady again: {settled}"


def test_an_unusable_configmap_leaves_the_source_alone(tmp_path: Path) -> None:
    seed(tmp_path)
    items = [configmap("insight-hubspot-main-settings", {"hubspot_access_token": "x"})]

    returncode, calls = tick(tmp_path, items)

    assert returncode != 0, "an unusable ConfigMap is a failed instance"
    assert calls == [], f"nothing reaches Airbyte: {calls}"
