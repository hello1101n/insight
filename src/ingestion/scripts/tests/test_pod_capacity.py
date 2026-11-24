from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest
from pod_capacity import Node, Pod, PodRequest, fits


def node(name: str, **settings: object) -> Node:
    spec = {key: settings[key] for key in ("taints", "unschedulable") if key in settings}
    return Node.model_validate(
        {
            "metadata": {"name": name, "labels": {"pool": settings.get("pool", "jobs")}},
            "spec": spec,
            "status": {
                "allocatable": {"cpu": "4", "memory": "8Gi"},
                "conditions": [{"type": "Ready", "status": settings.get("ready", "True")}],
            },
        }
    )


def pod(name: str, *, on: str | None = "example", phase: str = "Running") -> Pod:
    return Pod.model_validate(
        {
            "metadata": {"name": name, "namespace": "example-app"},
            "spec": {
                "nodeName": on,
                "containers": [
                    {"resources": {"requests": {"cpu": "0.5", "memory": "500M"}}},
                    {"resources": {"requests": {"cpu": "5e-1", "memory": "500M"}}},
                ],
                "initContainers": [
                    {"resources": {"requests": {"cpu": "1200m", "memory": "128Mi"}}},
                    {"resources": {"requests": {"cpu": "250m", "memory": "2Gi"}}},
                ],
                "overhead": {"cpu": "100m", "memory": "32Mi"},
            },
            "status": {"phase": phase},
        }
    )


def test_pod_request_takes_the_per_resource_maximum_then_adds_overhead() -> None:
    assert pod("example").request() == PodRequest(cpu_millis=1300, memory_bytes=2 * 1024**3 + 32 * 1024**2)


def test_restartable_init_requests_count_during_later_init_and_steady_state() -> None:
    def container(cpu: str, memory: str, *, sidecar: bool = False) -> dict[str, object]:
        result: dict[str, object] = {"resources": {"requests": {"cpu": cpu, "memory": memory}}}
        if sidecar:
            result["restartPolicy"] = "Always"
        return result

    pod = Pod.model_validate(
        {
            "metadata": {"name": "example", "namespace": "example-app"},
            "spec": {
                "containers": [container("1", "2Gi")],
                "initContainers": [
                    container("100m", "3Gi"),
                    container("250m", "1Gi", sidecar=True),
                    container("3", "1Gi"),
                    container("500m", "2Gi", sidecar=True),
                ],
                "overhead": {"cpu": "100m", "memory": "64Mi"},
            },
        }
    )
    assert pod.request() == PodRequest(cpu_millis=3350, memory_bytes=5 * 1024**3 + 64 * 1024**2)


def test_exact_fit_uses_bound_pods_in_any_namespace_and_ignores_terminal_pods() -> None:
    nodes = [node("full"), node("fits")]
    pods = [pod("first", on="full"), pod("second", on="full"), pod("running", on="fits")]
    pods.extend(pod(phase.lower(), on="fits", phase=phase) for phase in ("Succeeded", "Failed"))
    pods.append(pod("unbound", on=None))
    exact = PodRequest(cpu_millis=2700, memory_bytes=6 * 1024**3 - 32 * 1024**2)
    assert fits(exact, nodes, pods, "example-airbyte", {})
    assert not fits(exact, nodes[:1], pods, "example-airbyte", {})
    for request in (
        PodRequest(cpu_millis=2701, memory_bytes=exact.memory_bytes),
        PodRequest(cpu_millis=2700, memory_bytes=exact.memory_bytes + 1),
    ):
        assert not fits(request, nodes, pods, "example-airbyte", {}), request


@pytest.mark.parametrize(
    ("settings", "eligible"),
    [
        ({}, True),
        ({"ready": "False"}, False),
        ({"unschedulable": True}, False),
        ({"pool": "other"}, False),
        ({"taints": [{"key": "example", "effect": "NoSchedule"}]}, False),
        ({"taints": [{"key": "example", "effect": "NoExecute"}]}, False),
        ({"taints": [{"key": "example", "effect": "PreferNoSchedule"}]}, True),
        ({"taints": [{"key": "node.kubernetes.io/not-ready", "effect": "NoSchedule"}]}, True),
        ({"taints": [{"key": "node.kubernetes.io/unreachable", "effect": "NoExecute"}]}, True),
    ],
)
def test_only_eligible_nodes_offer_capacity(settings: dict[str, object], eligible: bool) -> None:
    request = PodRequest(cpu_millis=1, memory_bytes=1)
    assert fits(request, [node("example", **settings)], [], "example-airbyte", {"pool": "jobs"}) is eligible, settings


@pytest.mark.parametrize(
    ("labels", "scheduled", "available"),
    [
        pytest.param({"airbyte": "job-pod"}, True, True, id="scheduled-job"),
        pytest.param({}, False, True, id="unlabelled-pod"),
        pytest.param({"airbyte": "job-pod"}, False, False, id="unscheduled-job"),
    ],
)
def test_only_unscheduled_airbyte_jobs_block_capacity(labels: dict[str, str], scheduled: bool, available: bool) -> None:
    namespace = "example-airbyte"
    pending = Pod.model_validate(
        {
            "metadata": {"name": "example-pod", "namespace": namespace, "labels": labels},
            "spec": {"nodeName": "example" if scheduled else None, "containers": [{}]},
            "status": {"phase": "Pending", "conditions": [{"type": "PodScheduled", "status": str(scheduled)}]},
        }
    )
    request = PodRequest(cpu_millis=1, memory_bytes=1)

    assert fits(request, [node("example")], [pending], namespace, {}) is available
