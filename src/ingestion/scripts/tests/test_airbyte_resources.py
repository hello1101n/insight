from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import airbyte_sync_trigger as trigger
from airbyte_resources import AirbyteResources, Sizes
from test_airbyte_launch import BASE, CONNECTION, Workflow

SOURCE = "11111111-1111-1111-1111-111111111111"
WORKSPACE = "22222222-2222-2222-2222-222222222222"


@dataclass
class Airbyte:
    allocation: dict = field(
        default_factory=lambda: {
            "default": {"memory_request": "500Mi"},
            "jobSpecific": [{"jobType": "check", "resourceRequirements": {"memory_request": "600Mi"}}],
        }
    )
    overrides: dict[str, str] = field(default_factory=dict)
    calls: list[str] = field(default_factory=list)
    launched: list[dict] = field(default_factory=list)
    connections: int = 1

    def request(self, url: str, _token: str, data: bytes | None) -> bytes:
        path = url.split("/api/v1/")[1]
        self.calls.append(path)
        if path == "connections/get":
            return json.dumps(
                {"connectionId": str(CONNECTION), "sourceId": SOURCE, "resourceRequirements": self.overrides}
            ).encode()
        if path == "connections/sync":
            self.launched.append(self.allocation)
            return b'{"job":{"id":19}}'
        if path == "sources/partial_update":
            assert data is not None
            self.allocation = json.loads(data)["resourceAllocation"]
        else:
            assert path == "sources/get"
        return json.dumps(
            {
                "sourceId": SOURCE,
                "workspaceId": WORKSPACE,
                "numConnections": self.connections,
                "resourceAllocation": self.allocation,
            }
        ).encode()


def test_launch_converges_to_its_snapshot_and_keeps_the_allocation(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    airbyte = Airbyte(overrides={"memory_limit": "3Gi"})
    initial = airbyte.allocation
    monkeypatch.setattr(trigger, "request", airbyte.request)
    monkeypatch.setattr(trigger, "jobs", lambda *_: ())
    monkeypatch.setattr(trigger, "oauth_token", lambda: "fixture")
    empty = Sizes()
    sizes = Sizes(airbyte_cpu_millis=1200, airbyte_memory_bytes=2**31)

    assert trigger.launch(Workflow(), BASE, CONNECTION, 600, 1800, sizes=empty).job_id == 19
    assert airbyte.calls == ["connections/sync"]
    assert trigger.launch(Workflow(), BASE, CONNECTION, 600, 1800, sizes=sizes).job_id == 19
    assert airbyte.launched[-1]["jobSpecific"][-1] == {
        "jobType": "sync",
        "resourceRequirements": {
            "cpu_request": "1200m",
            "cpu_limit": "1200m",
            "memory_request": "2147483648",
            "memory_limit": "2147483648",
        },
    }
    assert airbyte.allocation == airbyte.launched[-1]
    assert airbyte.allocation["jobSpecific"][0] == initial["jobSpecific"][0]
    assert "The Airbyte connection overrides the source resource settings." in capsys.readouterr().err

    assert trigger.launch(Workflow(), BASE, CONNECTION, 600, 1800, sizes=sizes).job_id == 19
    assert airbyte.calls.count("sources/partial_update") == 1
    newer_sizes = Sizes(airbyte_cpu_millis=2000)
    assert trigger.launch(Workflow(), BASE, CONNECTION, 600, 1800, sizes=newer_sizes).job_id == 19
    assert airbyte.launched[-1]["jobSpecific"][-1]["resourceRequirements"] == {
        "cpu_request": "2000m",
        "cpu_limit": "2000m",
    }


def test_clear_removes_only_the_sync_entry_and_writes_once() -> None:
    airbyte = Airbyte()
    initial = airbyte.allocation
    resources = AirbyteResources(airbyte.request, BASE)
    resources.converge("fixture", CONNECTION, Sizes(airbyte_cpu_millis=1200))
    resources.converge("fixture", CONNECTION, Sizes(), clear=True)
    assert airbyte.allocation == initial
    resources.converge("fixture", CONNECTION, Sizes(), clear=True)
    assert airbyte.calls.count("sources/partial_update") == 2
