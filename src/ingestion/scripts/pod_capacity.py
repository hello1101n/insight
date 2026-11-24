from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from fractions import Fraction
from math import ceil
from typing import Self

from airbyte_resources import Response
from pydantic import Field, NonNegativeInt

QUANTITY = re.compile(r"([+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)([a-zA-Z]*)")
SCALE = {"": 1, "n": Fraction(1, 10**9), "u": Fraction(1, 10**6), "m": Fraction(1, 1000)}
SCALE.update(zip("kMGTPE", (1000**power for power in range(1, 7)), strict=True))
SCALE.update(zip(("Ki", "Mi", "Gi", "Ti", "Pi", "Ei"), (1024**power for power in range(1, 7)), strict=True))
PLACEMENT_TAINTS = {"node.kubernetes.io/not-ready", "node.kubernetes.io/unreachable"}


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


class Metadata(Response):
    name: str
    namespace: str = ""
    labels: dict[str, str] = Field(default_factory=dict)


class Condition(Response):
    kind: str = Field(alias="type")
    status: str


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
    metadata: Metadata
    spec: PodSpec
    status: PodStatus = PodStatus()

    def request(self) -> PodRequest:
        return pod_request(
            (Requests.read(container.resources.requests) for container in self.spec.containers),
            (
                (Requests.read(container.resources.requests), container.restart_policy == "Always")
                for container in self.spec.init
            ),
            Requests.read(self.spec.overhead),
        )

    def unscheduled_airbyte_job(self, namespace: str) -> bool:
        return (
            self.metadata.namespace == namespace
            and self.metadata.labels.get("airbyte") == "job-pod"
            and not any(c.kind == "PodScheduled" and c.status == "True" for c in self.status.conditions)
        )


class Taint(Response):
    key: str
    effect: str


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

    def eligible(self, selector: Mapping[str, str]) -> bool:
        return (
            any(c.kind == "Ready" and c.status == "True" for c in self.status.conditions)
            and not self.spec.unschedulable
            and not any(
                t.effect in {"NoSchedule", "NoExecute"} and t.key not in PLACEMENT_TAINTS for t in self.spec.taints
            )
            and all(self.metadata.labels.get(key) == value for key, value in selector.items())
        )


def fits(
    request: PodRequest, nodes: Iterable[Node], pods: Iterable[Pod], namespace: str, selector: Mapping[str, str]
) -> bool:
    free = {
        node.metadata.name: Requests.read(node.status.allocatable).to_pod_request()
        for node in nodes
        if node.eligible(selector)
    }
    used: dict[str, PodRequest] = {}
    for pod in pods:
        if pod.unscheduled_airbyte_job(namespace):
            return False
        node = pod.spec.node
        if node is None or node not in free or pod.status.phase in {"Succeeded", "Failed"}:
            continue
        current = used.get(node, NO_REQUEST)
        occupied = pod.request()
        used[node] = PodRequest(
            cpu_millis=current.cpu_millis + occupied.cpu_millis,
            memory_bytes=current.memory_bytes + occupied.memory_bytes,
        )

    return any(request.fits(available, used.get(node, NO_REQUEST)) for node, available in free.items())
