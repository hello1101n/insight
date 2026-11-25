from __future__ import annotations

import json
from typing import Annotated, Self

import yaml
from pydantic import BaseModel, ConfigDict, Field

_PARAMETER = "sync_resources"
AIRBYTE_MANAGED = "insight.cyberfabric.com/airbyte-resources-managed"
_DEPLOYMENT = "insight.cyberfabric.com/deployment-resources"
Cpu = Annotated[int, Field(ge=1, le=2**32 - 1)]
Memory = Annotated[int, Field(ge=1, le=2**53 - 1)]
QueryMemory = Annotated[int, Field(ge=2, le=2**53 - 1)]


class InstanceResources(BaseModel):
    model_config = ConfigDict(frozen=True, strict=True, extra="forbid")

    airbyte_cpu_millis: Cpu | None = None
    airbyte_memory_bytes: Memory | None = None
    dbt_cpu_millis: Cpu | None = None
    dbt_memory_bytes: Memory | None = None
    identity_cpu_millis: Cpu | None = None
    identity_memory_bytes: Memory | None = None
    dbt_query_memory_bytes: QueryMemory | None = None

    def has_airbyte_sizes(self) -> bool:
        return self.airbyte_cpu_millis is not None or self.airbyte_memory_bytes is not None

    def over(self, defaults: Self) -> Self:
        return defaults.model_copy(update=self.model_dump(exclude_none=True))


def pod_patch(cpu_millis: int | None, memory_bytes: int | None, query_bytes: int | None = None) -> str:
    if cpu_millis is None and memory_bytes is None and query_bytes is None:
        return "{}"

    sizes = {}
    if cpu_millis is not None:
        sizes["cpu"] = f"{cpu_millis}m"
    if memory_bytes is not None:
        sizes["memory"] = str(memory_bytes)

    main: dict[str, object] = {"name": "main"}
    if sizes:
        main["resources"] = {"limits": sizes, "requests": sizes}
    if query_bytes is not None:
        main["env"] = [{"name": "DBT_QUERY_MEMORY_BYTES", "value": str(query_bytes)}]

    return json.dumps({"containers": [main]}, sort_keys=True, separators=(",", ":"))


def render_resources(
    manifest: str, requested: InstanceResources, defaults: InstanceResources, *, cron: bool, managed: bool = False
) -> str:
    inherited = defaults.model_dump_json(exclude_none=True)
    effective_settings = requested.over(defaults)
    effective = effective_settings.model_dump_json(exclude_none=True)
    document = yaml.safe_load(manifest)
    spec = document["spec"]
    if cron:
        annotations = document["metadata"]["annotations"]
        if inherited != "{}":
            annotations[_DEPLOYMENT] = inherited
        if managed or effective_settings.has_airbyte_sizes():
            annotations[AIRBYTE_MANAGED] = "true"
        spec = spec["workflowSpec"]
    parameters = spec["arguments"]["parameters"]
    if effective != "{}":
        parameters.append({"name": _PARAMETER, "value": effective})

    dbt_patch = pod_patch(
        effective_settings.dbt_cpu_millis,
        effective_settings.dbt_memory_bytes,
        effective_settings.dbt_query_memory_bytes,
    )
    identity_patch = pod_patch(effective_settings.identity_cpu_millis, effective_settings.identity_memory_bytes)
    parameters.extend(
        [{"name": "dbt_pod_patch", "value": dbt_patch}, {"name": "identity_pod_patch", "value": identity_patch}]
    )
    return yaml.safe_dump(document, sort_keys=False)
