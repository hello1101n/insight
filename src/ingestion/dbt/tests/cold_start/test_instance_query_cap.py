from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import yaml

DBT_DIR = Path(__file__).resolve().parents[2]
PROFILE_WRITER = DBT_DIR.parent / "scripts/dbt_profiles.py"


def test_instance_cap_replaces_every_model_memory_setting(tmp_path: Path) -> None:
    cap = 5 * 2**30 + 1
    settings = {
        "max_memory_usage": cap,
        "max_bytes_before_external_group_by": cap // 2,
        "max_bytes_before_external_sort": cap // 2,
        "max_bytes_ratio_before_external_group_by": 0,
        "max_bytes_ratio_before_external_sort": 0,
    }
    env = os.environ | {
        "CLICKHOUSE_URL": "http://example.test:8123",
        "CLICKHOUSE_USER": "example",
        "CLICKHOUSE_PASSWORD": "",
        "CLICKHOUSE_DATABASE": "analytics",
        "DBT_LOG_PATH": str(tmp_path / "logs"),
    }
    env.pop("DBT_QUERY_MEMORY_BYTES", None)
    dbt = Path(sys.executable).with_name("dbt")

    def parse(name: str, memory: str) -> dict[str, dict]:
        target = tmp_path / name
        args = [
            str(dbt),
            "parse",
            "--project-dir",
            str(DBT_DIR),
            "--profiles-dir",
            str(tmp_path),
            "--target-path",
            str(target),
            "--no-partial-parse",
        ]
        env["DBT_QUERY_MEMORY_BYTES"] = memory
        result = subprocess.run(args, env=env, capture_output=True, text=True, check=False, timeout=120)
        assert result.returncode == 0, result.stdout + result.stderr
        return json.loads((target / "manifest.json").read_text())["nodes"]

    subprocess.run(
        [sys.executable, str(PROFILE_WRITER), "--profiles-dir", str(tmp_path)], env=env, check=True, timeout=30
    )
    baseline = parse("default", "")
    capped = parse("capped", str(cap))
    changed = 0
    for key, node in baseline.items():
        if node["resource_type"] != "model":
            continue
        previous = node["config"].get("query_settings") or {}
        actual = capped[key]["config"].get("query_settings") or {}
        if previous.keys() & settings.keys():
            assert actual == previous | settings, key
            changed += 1
        else:
            assert actual == previous, key
    assert changed > 15
    subprocess.run(
        [sys.executable, str(PROFILE_WRITER), "--profiles-dir", str(tmp_path)], env=env, check=True, timeout=30
    )
    profile = yaml.safe_load((tmp_path / "profiles.yml").read_text())["ingestion"]["outputs"]["k8s"]
    assert profile["custom_settings"] == settings
