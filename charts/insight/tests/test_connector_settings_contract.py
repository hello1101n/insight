"""The chart renders one settings ConfigMap per configured connector instance."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import yaml

CHART = Path(__file__).resolve().parents[1]
SELECTION = json.dumps({"deals": {"collect": ["deal_type"], "ignore": []}})


def render(*overrides: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "helm",
            "template",
            "contract-test",
            str(CHART),
            "--namespace",
            "synthetic",
            "-f",
            str(CHART / "tests/values.yaml"),
            *overrides,
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def settings_configmaps(stdout: str) -> list[dict]:
    documents = [doc for doc in yaml.safe_load_all(stdout) if doc]
    return [
        doc
        for doc in documents
        if doc["kind"] == "ConfigMap" and "connector-settings" in str(doc["metadata"].get("labels"))
    ]


def test_no_configured_instance_renders_no_settings():
    result = render()
    assert result.returncode == 0, result.stderr
    assert settings_configmaps(result.stdout) == []


def test_a_configured_instance_renders_a_configmap_reconcile_finds(tmp_path: Path):
    values = {
        "ingestion": {
            "reconcile": {
                "connectorSettings": [
                    {"connector": "hubspot", "sourceId": "main", "data": {"hubspot_property_selection": SELECTION}}
                ]
            }
        }
    }
    (tmp_path / "settings.yaml").write_text(yaml.safe_dump(values), encoding="utf-8")

    result = render("-f", str(tmp_path / "settings.yaml"))
    assert result.returncode == 0, result.stderr

    [configmap] = settings_configmaps(result.stdout)

    assert configmap["metadata"]["labels"]["app.kubernetes.io/part-of"] == "insight"
    assert configmap["metadata"]["annotations"] == {
        "insight.cyberfabric.com/connector": "hubspot",
        "insight.cyberfabric.com/source-id": "main",
    }
    assert json.loads(configmap["data"]["hubspot_property_selection"]) == json.loads(SELECTION)


def test_an_instance_without_a_source_id_fails_the_render():
    result = render("--set", "ingestion.reconcile.connectorSettings[0].connector=hubspot")
    assert result.returncode != 0
    assert "sourceId is required" in result.stderr
