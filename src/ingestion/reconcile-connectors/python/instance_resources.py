from __future__ import annotations

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


def render_resources(
    manifest: str, requested: InstanceResources, defaults: InstanceResources, *, cron: bool, managed: bool = False
) -> str:
    inherited = defaults.model_dump_json(exclude_none=True)
    effective_settings = requested.over(defaults)
    effective = effective_settings.model_dump_json(exclude_none=True)
    if effective == "{}" and not managed:
        return manifest

    document = yaml.safe_load(manifest)
    spec = document["spec"]
    if cron:
        annotations = document["metadata"]["annotations"]
        if inherited != "{}":
            annotations[_DEPLOYMENT] = inherited
        if managed or effective_settings.has_airbyte_sizes():
            annotations[AIRBYTE_MANAGED] = "true"
        spec = spec["workflowSpec"]
    if effective != "{}":
        spec["arguments"]["parameters"].append({"name": _PARAMETER, "value": effective})
    return yaml.safe_dump(document, sort_keys=False)
