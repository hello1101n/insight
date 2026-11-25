from __future__ import annotations

import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest
from pod_capacity import Capacity, Node, Pod, PodRequest, Toleration, placement

CORDON_TAINT = {"key": "node.kubernetes.io/unschedulable", "effect": "NoSchedule"}


def node(name: str, **settings: object) -> Node:
    spec = {key: settings[key] for key in ("taints", "unschedulable") if key in settings}
    return Node.model_validate(
        {
            "metadata": {"name": name, "labels": {"pool": settings.get("pool", "jobs")}},
            "spec": spec,
            "status": {
                "allocatable": {"cpu": settings.get("cpu", "4"), "memory": "8Gi"},
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
    assert placement(exact, nodes, pods, "example-airbyte", {}) is Capacity.FITS
    assert placement(exact, nodes[:1], pods, "example-airbyte", {}) is Capacity.WAIT
    for request in (
        PodRequest(cpu_millis=2701, memory_bytes=exact.memory_bytes),
        PodRequest(cpu_millis=2700, memory_bytes=exact.memory_bytes + 1),
    ):
        assert placement(request, nodes, pods, "example-airbyte", {}) is Capacity.WAIT, request


@pytest.mark.parametrize(
    ("settings", "eligible"),
    [
        ({}, True),
        ({"ready": "False"}, False),
        ({"unschedulable": True, "taints": [CORDON_TAINT]}, False),
        ({"pool": "other"}, False),
        ({"taints": [{"key": "example", "effect": "NoSchedule"}]}, False),
        ({"taints": [{"key": "example", "effect": "NoExecute"}]}, False),
        ({"taints": [{"key": "example", "effect": "PreferNoSchedule"}]}, True),
        ({"taints": [{"key": "node.kubernetes.io/not-ready", "effect": "NoSchedule"}]}, False),
        ({"taints": [{"key": "node.kubernetes.io/unreachable", "effect": "NoExecute"}]}, False),
        ({"taints": [{"key": "node.kubernetes.io/memory-pressure", "effect": "NoSchedule"}]}, False),
    ],
)
def test_only_eligible_nodes_offer_capacity(settings: dict[str, object], eligible: bool) -> None:
    request = PodRequest(cpu_millis=1, memory_bytes=1)
    assert (
        placement(request, [node("example", **settings)], [], "example-airbyte", {"pool": "jobs"}) is Capacity.FITS
    ) is eligible, settings


@pytest.mark.parametrize(
    "settings",
    [
        pytest.param({"unschedulable": True, "taints": [CORDON_TAINT]}, id="cordoned"),
        pytest.param({"ready": "False"}, id="unready"),
        pytest.param(
            {"taints": [{"key": "node.kubernetes.io/memory-pressure", "effect": "NoSchedule"}]}, id="memory-pressure"
        ),
    ],
)
def test_unavailable_matching_node_sets_the_size_limit(settings: dict[str, object]) -> None:
    request = PodRequest(cpu_millis=4000, memory_bytes=1)
    small = node("small", cpu="3")
    large = node("large", **settings)
    assert placement(request, [small, large], [], "example-airbyte", {"pool": "jobs"}) is Capacity.WAIT
    other = node("other", pool="other")
    assert placement(request, [small, other], [], "example-airbyte", {"pool": "jobs"}) is Capacity.TOO_LARGE


@pytest.mark.parametrize("nodes", [[], [node("other", pool="other")]], ids=["no-nodes", "other-pool"])
def test_capacity_waits_when_the_selector_matches_no_nodes(nodes: list[Node]) -> None:
    request = PodRequest(cpu_millis=4000, memory_bytes=1)

    assert placement(request, nodes, [], "example-airbyte", {"pool": "jobs"}) is Capacity.WAIT


@pytest.mark.parametrize("effect", ["NoSchedule", "NoExecute"])
def test_foreign_taints_exclude_nodes_from_the_size_limit(effect: str) -> None:
    request = PodRequest(cpu_millis=4000, memory_bytes=1)
    small = node("small", cpu="3")
    large = node("large", taints=[{"key": "example", "effect": effect}])

    assert placement(request, [small, large], [], "example-airbyte", {"pool": "jobs"}) is Capacity.TOO_LARGE


@pytest.mark.parametrize(
    ("settings", "effect", "cordoned", "expected"),
    [
        pytest.param({"key": "dedicated", "value": "jobs"}, "NoSchedule", False, Capacity.FITS, id="equal"),
        pytest.param({"key": "dedicated", "value": "other"}, "NoSchedule", False, Capacity.TOO_LARGE, id="value"),
        pytest.param({"key": "other", "operator": "Exists"}, "NoSchedule", False, Capacity.TOO_LARGE, id="key"),
        pytest.param({"operator": "Exists"}, "NoExecute", False, Capacity.FITS, id="wildcard"),
        pytest.param(
            {"operator": "Exists", "effect": "NoSchedule"}, "NoExecute", False, Capacity.TOO_LARGE, id="effect"
        ),
        pytest.param({"key": "dedicated", "operator": "Exists"}, "NoSchedule", True, Capacity.WAIT, id="cordoned"),
    ],
)
def test_matching_tolerations_include_dedicated_nodes_in_capacity(
    settings: dict[str, str], effect: str, cordoned: bool, expected: Capacity
) -> None:
    taints = [{"key": "dedicated", "value": "jobs", "effect": effect}]
    if cordoned:
        taints.append(CORDON_TAINT)
    nodes = [node("small", cpu="3"), node("large", taints=taints, unschedulable=cordoned)]
    request = PodRequest(cpu_millis=4000, memory_bytes=1)
    tolerations = (Toleration.model_validate(settings),)

    assert placement(request, nodes, [], "example-airbyte", {}, tolerations=tolerations) is expected


@pytest.mark.parametrize(
    "metadata",
    [{"ownerReferences": [{"kind": "DaemonSet"}]}, {"annotations": {"kubernetes.io/config.mirror": "example"}}],
)
def test_permanent_pod_requests_reduce_the_size_limit(metadata: dict[str, object]) -> None:
    permanent = pod("resident")
    permanent = permanent.model_copy(
        update={"metadata": type(permanent.metadata).model_validate({"name": "resident", **metadata})}
    )
    request = PodRequest(cpu_millis=2701, memory_bytes=1)
    nodes = [node("example")]
    assert placement(request, nodes, [permanent], "example-airbyte", {}) is Capacity.TOO_LARGE


@pytest.mark.parametrize(
    ("on", "metadata", "expected"),
    [
        pytest.param("example", {}, Capacity.WAIT, id="ordinary-pod"),
        pytest.param(
            "example",
            {"ownerReferences": [{"kind": "DaemonSet"}], "deletionTimestamp": "2026-01-01T00:00:00Z"},
            Capacity.WAIT,
            id="terminating-daemonset",
        ),
        pytest.param(
            "example",
            {"annotations": {"kubernetes.io/config.mirror": "example"}, "deletionTimestamp": "2026-01-01T00:00:00Z"},
            Capacity.WAIT,
            id="terminating-mirror",
        ),
        pytest.param(None, {"ownerReferences": [{"kind": "DaemonSet"}]}, Capacity.FITS, id="unscheduled-daemonset"),
    ],
)
def test_nonpermanent_pods_do_not_reduce_the_size_limit(
    on: str | None, metadata: dict[str, object], expected: Capacity
) -> None:
    resident = pod("resident", on=on)
    resident = resident.model_copy(
        update={"metadata": type(resident.metadata).model_validate({"name": "resident", **metadata})}
    )
    request = PodRequest(cpu_millis=2701, memory_bytes=1)

    assert placement(request, [node("example")], [resident], "example-airbyte", {}) is expected


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

    assert (placement(request, [node("example")], [pending], namespace, {}) is Capacity.FITS) is available


@pytest.mark.parametrize("age_seconds", [1799, 1800, 1801])
def test_old_pending_airbyte_pods_stop_holding_the_queue(
    age_seconds: int, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import json

    import pod_capacity

    now = datetime(2026, 1, 1, tzinfo=UTC)

    class Clock:
        @staticmethod
        def now(_timezone: object) -> datetime:
            return now

    monkeypatch.setattr(pod_capacity, "datetime", Clock)
    pending = Pod.model_validate(
        {
            "metadata": {
                "name": "example-blocker",
                "namespace": "airbyte",
                "creationTimestamp": (now - timedelta(seconds=age_seconds)).isoformat(),
                "labels": {"airbyte": "job-pod"},
            },
            "spec": {"containers": [{}]},
            "status": {
                "phase": "Pending",
                "conditions": [{"type": "PodScheduled", "status": "False", "reason": "Unschedulable"}],
            },
        }
    )
    request = PodRequest(cpu_millis=1, memory_bytes=1)

    expected = Capacity.WAIT if age_seconds <= 1800 else Capacity.FITS
    assert placement(request, [node("example")], [pending], "airbyte", {}) is expected
    lines = capsys.readouterr().err.splitlines()
    if expected is Capacity.WAIT:
        fields = json.loads(lines[-1])["fields"]
        assert fields.pop("message") == "A Pending Airbyte pod holds the capacity queue."
        assert fields == {
            "namespace": "airbyte",
            "pod": "example-blocker",
            "age_seconds": age_seconds,
            "pod_scheduled_reason": "Unschedulable",
        }
    else:
        assert lines == []
