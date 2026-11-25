from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from fractions import Fraction
from math import ceil
from typing import Literal, Self

import insight_logging
from airbyte_resources import Response
from pydantic import AwareDatetime, Field, NonNegativeInt

QUANTITY = re.compile(r"([+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)([a-zA-Z]*)")
SCALE = {"": 1, "n": Fraction(1, 10**9), "u": Fraction(1, 10**6), "m": Fraction(1, 1000)}
SCALE.update(zip("kMGTPE", (1000**power for power in range(1, 7)), strict=True))
SCALE.update(zip(("Ki", "Mi", "Gi", "Ti", "Pi", "Ei"), (1024**power for power in range(1, 7)), strict=True))


def quantity(raw: str) -> Fraction:
    match = QUANTITY.fullmatch(raw)
    if match is None or match[2] not in SCALE:
        raise ValueError("Invalid Kubernetes resource quantity")
    return Fraction(match[1]) * SCALE[match[2]]


class PodRequest(Response):
    cpu_millis: NonNegativeInt
    memory_bytes: NonNegativeInt

    def fits(self, available: PodRequest, used: PodRequest) -> bool:
        return (
            used.cpu_millis + self.cpu_millis <= available.cpu_millis
            and used.memory_bytes + self.memory_bytes <= available.memory_bytes
        )

    def __add__(self, other: PodRequest) -> PodRequest:
        return PodRequest(
            cpu_millis=self.cpu_millis + other.cpu_millis, memory_bytes=self.memory_bytes + other.memory_bytes
        )


@dataclass(frozen=True)
class Requests:
    cpu: Fraction
    memory: Fraction

    @classmethod
    def read(cls, raw: Mapping[str, str]) -> Self:
        return cls(quantity(raw.get("cpu", "0")), quantity(raw.get("memory", "0")))

    def __add__(self, other: Requests) -> Requests:
        return Requests(self.cpu + other.cpu, self.memory + other.memory)

    def max(self, other: Requests) -> Requests:
        return Requests(max(self.cpu, other.cpu), max(self.memory, other.memory))

    def to_pod_request(self) -> PodRequest:
        return PodRequest(cpu_millis=ceil(self.cpu * 1000), memory_bytes=ceil(self.memory))


ZERO = Requests(Fraction(0), Fraction(0))
NO_REQUEST = ZERO.to_pod_request()


def pod_request(
    containers: Iterable[Requests], init: Iterable[tuple[Requests, bool]], overhead: Requests = ZERO
) -> PodRequest:
    total = ZERO
    for container in containers:
        total += container
    sidecars = ZERO
    init_peak = ZERO
    for request, restartable in init:
        if restartable:
            sidecars += request
            init_peak = init_peak.max(sidecars)
        else:
            init_peak = init_peak.max(sidecars + request)
    return ((total + sidecars).max(init_peak) + overhead).to_pod_request()


class OwnerReference(Response):
    kind: str


class Metadata(Response):
    name: str
    namespace: str = ""
    labels: dict[str, str] = Field(default_factory=dict)
    created_at: AwareDatetime | None = Field(default=None, alias="creationTimestamp")


class PodMetadata(Metadata):
    annotations: dict[str, str] = Field(default_factory=dict)
    owners: tuple[OwnerReference, ...] = Field(default=(), alias="ownerReferences")
    deleted_at: AwareDatetime | None = Field(default=None, alias="deletionTimestamp")


class Condition(Response):
    kind: str = Field(alias="type")
    status: str
    reason: str | None = None


class ContainerResources(Response):
    requests: dict[str, str] = Field(default_factory=dict)


class Container(Response):
    resources: ContainerResources = ContainerResources()
    restart_policy: str | None = Field(default=None, alias="restartPolicy")


class PodSpec(Response):
    node: str | None = Field(default=None, alias="nodeName")
    containers: tuple[Container, ...]
    init: tuple[Container, ...] = Field(default=(), alias="initContainers")
    overhead: dict[str, str] = Field(default_factory=dict)


class PodStatus(Response):
    phase: str | None = None
    conditions: tuple[Condition, ...] = ()


class Pod(Response):
    metadata: PodMetadata
    spec: PodSpec
    status: PodStatus = PodStatus()

    def stays_on_node(self) -> bool:
        return self.metadata.deleted_at is None and (
            "kubernetes.io/config.mirror" in self.metadata.annotations
            or any(owner.kind == "DaemonSet" for owner in self.metadata.owners)
        )

    def request(self) -> PodRequest:
        return pod_request(
            (Requests.read(container.resources.requests) for container in self.spec.containers),
            (
                (Requests.read(container.resources.requests), container.restart_policy == "Always")
                for container in self.spec.init
            ),
            Requests.read(self.spec.overhead),
        )

    def blocks_airbyte_queue(self, namespace: str, now: datetime, max_age_seconds: int) -> bool:
        if (
            self.metadata.namespace != namespace
            or self.metadata.labels.get("airbyte") != "job-pod"
            or self.status.phase != "Pending"
            or self.spec.node is not None
        ):
            return False

        scheduled = next((c for c in self.status.conditions if c.kind == "PodScheduled"), None)
        if scheduled is not None and scheduled.status == "True":
            return False

        created = self.metadata.created_at
        age = (now - created).total_seconds() if created is not None else None
        if age is not None and age > max_age_seconds:
            return False

        insight_logging.configure("airbyte-sync").info(
            "A Pending Airbyte pod holds the capacity queue.",
            extra={
                "namespace": namespace,
                "pod": self.metadata.name,
                "age_seconds": age,
                "pod_scheduled_reason": scheduled.reason if scheduled is not None else None,
            },
        )
        return True


class Taint(Response):
    key: str
    effect: str
    value: str = ""


class Toleration(Response):
    key: str = ""
    effect: Literal["", "NoSchedule", "PreferNoSchedule", "NoExecute"] = ""
    operator: Literal["", "Equal", "Exists"] = "Equal"
    value: str = ""

    def matches(self, taint: Taint) -> bool:
        if self.effect and self.effect != taint.effect:
            return False
        if self.operator == "Exists":
            return not self.key or self.key == taint.key
        return self.key == taint.key and self.value == taint.value


class NodeSpec(Response):
    unschedulable: bool = False
    taints: tuple[Taint, ...] = ()


class NodeStatus(Response):
    allocatable: dict[str, str] = Field(default_factory=dict)
    conditions: tuple[Condition, ...] = ()


class Node(Response):
    metadata: Metadata
    spec: NodeSpec = NodeSpec()
    status: NodeStatus

    def schedulable(self) -> bool:
        return not self.spec.unschedulable and any(
            c.kind == "Ready" and c.status == "True" for c in self.status.conditions
        )

    def has_blocking_taint(self, tolerations: tuple[Toleration, ...], *, ignore_conditions: bool = False) -> bool:
        return any(
            taint.effect in {"NoSchedule", "NoExecute"}
            and not (ignore_conditions and taint.key.startswith("node.kubernetes.io/"))
            and not any(toleration.matches(taint) for toleration in tolerations)
            for taint in self.spec.taints
        )


class Capacity(Enum):
    FITS = "fits"
    WAIT = "wait"
    TOO_LARGE = "too_large"


def placement(
    request: PodRequest,
    nodes: Iterable[Node],
    pods: Iterable[Pod],
    namespace: str,
    selector: Mapping[str, str],
    pending_max_age_seconds: int = 1800,
    *,
    tolerations: tuple[Toleration, ...] = (),
) -> Capacity:
    matching = [
        node for node in nodes if all(node.metadata.labels.get(key) == value for key, value in selector.items())
    ]
    if not matching:
        return Capacity.WAIT

    eligible = [node for node in matching if not node.has_blocking_taint(tolerations, ignore_conditions=True)]
    allocatable = {node.metadata.name: Requests.read(node.status.allocatable).to_pod_request() for node in eligible}
    if not any(request.fits(available, NO_REQUEST) for available in allocatable.values()):
        return Capacity.TOO_LARGE

    now = datetime.now(UTC)
    used: dict[str, PodRequest] = {}
    permanent: dict[str, PodRequest] = {}
    queued = False
    for pod in pods:
        queued = pod.blocks_airbyte_queue(namespace, now, pending_max_age_seconds) or queued
        node = pod.spec.node
        if node is None or node not in allocatable or pod.status.phase in {"Succeeded", "Failed"}:
            continue
        occupied = pod.request()
        used[node] = used.get(node, NO_REQUEST) + occupied
        if pod.stays_on_node():
            permanent[node] = permanent.get(node, NO_REQUEST) + occupied

    if not any(request.fits(available, permanent.get(node, NO_REQUEST)) for node, available in allocatable.items()):
        return Capacity.TOO_LARGE
    if not queued and any(
        node.schedulable()
        and not node.has_blocking_taint(tolerations)
        and request.fits(allocatable[node.metadata.name], used.get(node.metadata.name, NO_REQUEST))
        for node in eligible
    ):
        return Capacity.FITS
    return Capacity.WAIT
