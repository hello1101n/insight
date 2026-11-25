from __future__ import annotations

from collections.abc import Mapping
from typing import Self
from uuid import UUID

from airbyte_resources import AirbyteResources, Response
from pod_capacity import PodRequest, Requests, Toleration, pod_request
from pydantic import Field, PositiveInt


class ContainerDefault(Response):
    cpu: str
    memory: str

    def request(self) -> Requests:
        return Requests.read({"cpu": self.cpu, "memory": self.memory})


class Defaults(Response):
    orchestrator: ContainerDefault
    source: ContainerDefault
    destination: ContainerDefault
    init: ContainerDefault

    def validate_quantities(self) -> None:
        for container in (self.orchestrator, self.source, self.destination, self.init):
            container.request()


class Requirements(Response):
    cpu_request: str | None = None
    memory_request: str | None = None

    def over(self, default: Self) -> Self:
        return self.model_copy(
            update={
                "cpu_request": self.cpu_request or default.cpu_request,
                "memory_request": self.memory_request or default.memory_request,
            }
        )


class EstimateConnection(Response):
    id: UUID = Field(alias="connectionId")
    source: UUID = Field(alias="sourceId")
    destination: UUID = Field(alias="destinationId")
    requirements: Requirements | None = Field(default=None, alias="resourceRequirements")


class JobRequirements(Response):
    kind: str = Field(alias="jobType")
    requirements: Requirements | None = Field(default=None, alias="resourceRequirements")


class ScopedRequirements(Response):
    default: Requirements | None = None
    jobs: tuple[JobRequirements, ...] | None = Field(default=None, alias="jobSpecific")

    def over(self, fallback: Requirements) -> Requirements:
        sync = [entry.requirements for entry in self.jobs or () if entry.kind == "sync"]
        if len(sync) > 1:
            raise ValueError("Airbyte returned multiple resource allocations for sync jobs")
        defaults = (self.default or Requirements()).over(fallback)
        return (sync[0] if sync and sync[0] is not None else Requirements()).over(defaults)


class Actor(Response):
    allocation: ScopedRequirements | None = Field(default=None, alias="resourceAllocation")


class Source(Actor):
    id: UUID = Field(alias="sourceId")
    definition: UUID = Field(alias="sourceDefinitionId")


class Destination(Actor):
    id: UUID = Field(alias="destinationId")
    definition: UUID = Field(alias="destinationDefinitionId")


class Definition(Response):
    requirements: ScopedRequirements | None = Field(default=None, alias="resourceRequirements")


class SourceDefinition(Definition):
    id: UUID = Field(alias="sourceDefinitionId")


class DestinationDefinition(Definition):
    id: UUID = Field(alias="destinationDefinitionId")


class Settings(Response):
    node_selector: dict[str, str] = Field(alias="nodeSelector")
    tolerations: tuple[Toleration, ...] = ()
    requests: Defaults
    pending_max_age_seconds: PositiveInt = Field(default=1800, alias="pendingMaxAgeSeconds")
    wait_limit_seconds: PositiveInt = Field(default=21600, alias="waitLimitSeconds")


def actor_request(
    connection: Requirements | None, actor: Actor, definition: Definition, default: ContainerDefault
) -> Requests:
    fallback = Requirements(cpu_request=default.cpu, memory_request=default.memory)
    from_definition = (definition.requirements or ScopedRequirements()).over(fallback)
    from_actor = (actor.allocation or ScopedRequirements()).over(from_definition)
    effective = (connection or Requirements()).over(from_actor)
    quantities: Mapping[str, str] = {
        "cpu": effective.cpu_request or default.cpu,
        "memory": effective.memory_request or default.memory,
    }
    return Requests.read(quantities)


def estimate(api: AirbyteResources, token: str, connection: UUID, defaults: Defaults) -> PodRequest:
    live = api.call(token, "connections/get", {"connectionId": str(connection)}, EstimateConnection)
    if live.id != connection:
        raise ValueError("Airbyte returned a different connection")
    source = api.call(token, "sources/get", {"sourceId": str(live.source)}, Source)
    destination = api.call(token, "destinations/get", {"destinationId": str(live.destination)}, Destination)
    if source.id != live.source or destination.id != live.destination:
        raise ValueError("Airbyte returned a different actor")

    source_def = api.call(
        token, "source_definitions/get", {"sourceDefinitionId": str(source.definition)}, SourceDefinition
    )
    dest_def = api.call(
        token,
        "destination_definitions/get",
        {"destinationDefinitionId": str(destination.definition)},
        DestinationDefinition,
    )
    if source_def.id != source.definition or dest_def.id != destination.definition:
        raise ValueError("Airbyte returned a different actor definition")

    return pod_request(
        (
            defaults.orchestrator.request(),
            actor_request(live.requirements, source, source_def, defaults.source),
            actor_request(live.requirements, destination, dest_def, defaults.destination),
        ),
        ((defaults.init.request(), False),),
    )
