from __future__ import annotations

import json
import sys
from pathlib import Path
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest
from airbyte_estimate import Defaults, estimate
from airbyte_resources import AirbyteResources, Response
from pod_capacity import PodRequest

CONNECTION = UUID(int=1)
SOURCE = UUID(int=2)
DESTINATION = UUID(int=3)
SOURCE_DEF = UUID(int=4)
DEST_DEF = UUID(int=5)
GIB = 1024**3

DEFAULTS = Defaults.model_validate(
    {
        "orchestrator": {"cpu": "1", "memory": "2Gi"},
        "source": {"cpu": "1", "memory": "2Gi"},
        "destination": {"cpu": "500m", "memory": "1Gi"},
        "init": {"cpu": "1", "memory": "2Gi"},
    }
)


def scoped(cpu: str | None, memory: str | None, default: dict[str, str]) -> dict[str, object]:
    return {
        "jobSpecific": [
            {"jobType": "check_connection", "resourceRequirements": {"cpu_request": "99", "memory_request": "99Gi"}},
            {"jobType": "sync", "resourceRequirements": {"cpu_request": cpu, "memory_request": memory}},
        ],
        "default": default,
    }


@pytest.mark.parametrize(
    ("connection", "source", "source_definition", "destination", "destination_definition", "expected"),
    [
        (
            {"cpu_request": "300m", "memory_limit": "50Gi"},
            scoped("700m", None, {"memory_request": "3Gi"}),
            scoped("800m", "4Gi", {}),
            scoped("900m", "1Gi", {"memory_request": "3Gi"}),
            scoped("950m", "4Gi", {}),
            (1600, 6),
        ),
        (
            None,
            scoped("700m", None, {"cpu_request": "600m"}),
            scoped("800m", "4Gi", {"memory_request": "6Gi"}),
            scoped(None, "3Gi", {"cpu_request": "900m"}),
            scoped("950m", "4Gi", {}),
            (2600, 9),
        ),
        (
            None,
            scoped(None, None, {"cpu_request": "600m"}),
            scoped("800m", None, {"memory_request": "6Gi"}),
            None,
            scoped("950m", None, {"memory_request": "4Gi"}),
            (2550, 12),
        ),
        (None, None, None, None, None, (2500, 5)),
    ],
)
def test_estimate_uses_each_resource_field_in_precedence_order(
    connection: dict[str, str] | None,
    source: dict[str, object] | None,
    source_definition: dict[str, object] | None,
    destination: dict[str, object] | None,
    destination_definition: dict[str, object] | None,
    expected: tuple[int, int],
) -> None:
    replies = {
        "connections/get": (
            "connectionId",
            CONNECTION,
            {"sourceId": str(SOURCE), "destinationId": str(DESTINATION), "resourceRequirements": connection},
        ),
        "sources/get": ("sourceId", SOURCE, {"sourceDefinitionId": str(SOURCE_DEF), "resourceAllocation": source}),
        "destinations/get": (
            "destinationId",
            DESTINATION,
            {"destinationDefinitionId": str(DEST_DEF), "resourceAllocation": destination},
        ),
        "source_definitions/get": ("sourceDefinitionId", SOURCE_DEF, {"resourceRequirements": source_definition}),
        "destination_definitions/get": (
            "destinationDefinitionId",
            DEST_DEF,
            {"resourceRequirements": destination_definition},
        ),
    }

    def request(url: str, _token: str, body: bytes | None) -> bytes:
        key, uid, extra = replies[url.split("/api/v1/")[1]]
        assert json.loads(body or b"{}") == {key: str(uid)}
        return json.dumps({key: str(uid), **extra}).encode()

    requests = estimate(AirbyteResources(request, "https://example.com"), "fixture", CONNECTION, DEFAULTS)
    assert requests == PodRequest(cpu_millis=expected[0], memory_bytes=expected[1] * GIB)


def test_init_request_can_set_either_resource_of_the_estimate() -> None:
    defaults = DEFAULTS.model_copy(update={"init": type(DEFAULTS.init)(cpu="3", memory="4Gi")})

    class DefaultsOnly(AirbyteResources):
        def call[Model: Response](self, _token: str, path: str, body: dict[str, object], model: type[Model]) -> Model:
            values = {
                "connections/get": {"sourceId": str(SOURCE), "destinationId": str(DESTINATION)},
                "sources/get": {"sourceDefinitionId": str(SOURCE_DEF)},
                "destinations/get": {"destinationDefinitionId": str(DEST_DEF)},
            }
            return model.model_validate(body | values.get(path, {}))

    api = DefaultsOnly(lambda *_: b"", "https://example.com")
    assert estimate(api, "fixture", CONNECTION, defaults) == PodRequest(cpu_millis=3000, memory_bytes=5 * GIB)
