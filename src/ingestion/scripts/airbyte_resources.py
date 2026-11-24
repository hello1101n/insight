from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError

CPU = Annotated[int, Field(strict=True, ge=1, le=2**32 - 1)]
Memory = Annotated[int, Field(strict=True, ge=1, le=2**53 - 1)]


class Response(BaseModel):
    model_config = ConfigDict(frozen=True)


class Sizes(Response):
    airbyte_cpu_millis: CPU | None = None
    airbyte_memory_bytes: Memory | None = None

    def requirements(self) -> dict[str, str]:
        result = {}
        if self.airbyte_cpu_millis is not None:
            cpu = f"{self.airbyte_cpu_millis}m"
            result.update(cpu_request=cpu, cpu_limit=cpu)
        if self.airbyte_memory_bytes is not None:
            memory = str(self.airbyte_memory_bytes)
            result.update(memory_request=memory, memory_limit=memory)
        return result


class Connection(Response):
    id: UUID = Field(alias="connectionId")
    source: UUID = Field(alias="sourceId")
    requirements: dict[str, JsonValue] | None = Field(default=None, alias="resourceRequirements")


class JobResources(Response):
    model_config = ConfigDict(frozen=True, extra="allow")
    kind: str = Field(alias="jobType")
    requirements: dict[str, JsonValue] = Field(alias="resourceRequirements")


class Allocation(Response):
    model_config = ConfigDict(frozen=True, extra="allow")
    default: dict[str, JsonValue] | None = None
    jobs: tuple[JobResources, ...] = Field(default=(), alias="jobSpecific")

    def with_sizes(self, sizes: dict[str, str]) -> Allocation:
        sync = [job for job in self.jobs if job.kind == "sync"]
        if len(sync) > 1:
            raise ValueError("Airbyte returned multiple source allocations for sync jobs")
        if not sync:
            job = JobResources(jobType="sync", resourceRequirements=dict(sizes))
            return self.model_copy(update={"jobs": (*self.jobs, job)})

        previous = sync[0]
        previous_other = {
            key: value
            for key, value in previous.requirements.items()
            if key not in {"cpu_request", "cpu_limit", "memory_request", "memory_limit"}
        }
        job = previous.model_copy(update={"requirements": previous_other | sizes})
        return self.model_copy(update={"jobs": tuple(job if entry is previous else entry for entry in self.jobs)})

    def without_sync(self) -> Allocation:
        return self.model_copy(update={"jobs": tuple(job for job in self.jobs if job.kind != "sync")})


class Source(Response):
    id: UUID = Field(alias="sourceId")
    workspace: UUID = Field(alias="workspaceId")
    connections: int | None = Field(default=None, alias="numConnections")
    allocation: Allocation | None = Field(default=None, alias="resourceAllocation")


class ConnectionRef(Response):
    id: UUID = Field(alias="connectionId")


class Siblings(Response):
    count: int = Field(alias="num_connections")
    connections: tuple[ConnectionRef, ...]


def parse[Model: BaseModel](model: type[Model], raw: bytes | str) -> Model:
    try:
        return model.model_validate_json(raw)
    except ValidationError as error:
        issues = error.errors(include_input=False)
        raise ValueError(f"{model.__name__} has an invalid field: {issues[0]['type']}") from None


class AirbyteResources:
    def __init__(self, request: Callable[[str, str, bytes | None], bytes], url: str) -> None:
        self.request = request
        self.url = url

    def _airbyte[Model: BaseModel](
        self, token: str, path: str, body: dict[str, JsonValue], model: type[Model]
    ) -> Model:
        return parse(model, self.request(f"{self.url}/api/v1/{path}", token, json.dumps(body).encode()))

    def _source(self, token: str, source_id: UUID) -> Source:
        source = self._airbyte(token, "sources/get", {"sourceId": str(source_id)}, Source)
        if source.id != source_id:
            raise ValueError("Airbyte returned a different source")
        return source

    def _update_source(self, token: str, source: UUID, target: Allocation) -> None:
        updated = self._airbyte(
            token,
            "sources/partial_update",
            {
                "sourceId": str(source),
                "resourceAllocation": target.model_dump(mode="json", by_alias=True, exclude_none=True),
            },
            Source,
        )
        if updated.id != source or (updated.allocation or Allocation()) != target:
            raise ValueError("Airbyte did not confirm the source allocation")

    def converge(self, token: str, connection: UUID, sizes: Sizes, *, clear: bool = False) -> tuple[str, ...]:
        desired = sizes.requirements()
        if not desired and not clear:
            return ()

        live = self._airbyte(token, "connections/get", {"connectionId": str(connection)}, Connection)
        if live.id != connection:
            raise ValueError("Airbyte returned a different connection")
        source = self._source(token, live.source)
        count = source.connections
        if count is None:
            siblings = self._airbyte(
                token,
                "web_backend/connections/list",
                {"workspaceId": str(source.workspace), "sourceId": [str(source.id)], "pageSize": 2},
                Siblings,
            )
            if siblings.connections != (ConnectionRef(connectionId=connection),):
                raise ValueError("Airbyte did not confirm the source connection")
            count = siblings.count
        if count != 1:
            raise ValueError("Airbyte source sizing requires a dedicated source")

        current = source.allocation or Allocation()
        if clear:
            target = current.without_sync()
            overrides = ()
        else:
            overrides = tuple(key for key in desired if (live.requirements or {}).get(key))
            target = current.with_sizes(desired)
        if target != current:
            self._update_source(token, source.id, target)
        return overrides


def main() -> None:
    from airbyte_auth import airbyte_api_url, oauth_token, request

    connection = UUID(sys.argv[1])
    token = os.environ.get("AIRBYTE_TOKEN") or oauth_token()
    AirbyteResources(request, airbyte_api_url()).converge(token, connection, Sizes(), clear=True)


if __name__ == "__main__":
    main()
