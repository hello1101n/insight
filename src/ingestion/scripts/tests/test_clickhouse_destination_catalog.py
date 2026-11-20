from pathlib import Path
from runpy import run_path

import pytest

ENTRYPOINT = Path(__file__).resolve().parents[2] / "tools" / "destination-clickhouse" / "entrypoint.py"
adapt = run_path(str(ENTRYPOINT))["append_catalog"]


def test_legacy_append_uses_actual_job_and_preserves_keys():
    catalog = {
        "streams": [{"stream": {"name": "issues"}, "destination_sync_mode": "append_dedup", "primary_key": [["id"]]}]
    }
    assert adapt(catalog, "370")
    assert catalog["streams"] == [
        {
            "stream": {"name": "issues"},
            "destination_sync_mode": "append_dedup",
            "primary_key": [["id"]],
            "sync_id": 370,
            "generation_id": 0,
            "minimum_generation_id": 0,
        }
    ]


@pytest.mark.parametrize(
    "stream",
    [
        {"destination_sync_mode": "overwrite"},
        {"destination_sync_mode": "append", "generation_id": 99},
        {"destination_sync_mode": "unknown"},
    ],
)
def test_refuses_unattributable_generation(stream):
    with pytest.raises(ValueError):
        adapt({"streams": [stream]}, "371")


def test_native_refresh_preserves_generation_and_sync():
    stream = {"destination_sync_mode": "overwrite", "sync_id": 8, "generation_id": 6, "minimum_generation_id": 6}
    original = stream.copy()
    assert not adapt({"streams": [stream]}, "372")
    assert stream == original
