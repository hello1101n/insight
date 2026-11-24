from pathlib import Path

import yaml
from instance_resources import InstanceResources, render_resources
from pydantic import BaseModel, ConfigDict, TypeAdapter

FIXTURE = Path(__file__).resolve().parents[4] / "tests/fixtures/connector-resource-parameters.json"


class Case(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    requested: InstanceResources
    defaults: InstanceResources
    sync_resources: str
    dbt_pod_patch: str
    identity_pod_patch: str


def test_workflows_use_the_shared_resource_parameter_contract() -> None:
    cases = TypeAdapter(list[Case]).validate_json(FIXTURE.read_bytes())
    for cron in (True, False):
        arguments = {"arguments": {"parameters": [{"name": "insight_source_id", "value": "main"}]}}
        spec = {"workflowSpec": arguments} if cron else arguments
        manifest = yaml.safe_dump({"metadata": {"annotations": {}}, "spec": spec})

        for case in cases:
            result = yaml.safe_load(render_resources(manifest, case.requested, case.defaults, cron=cron))["spec"]
            parameters = (result["workflowSpec"] if cron else result)["arguments"]["parameters"]
            actual = {p["name"]: p["value"] for p in parameters}
            expected = {
                "insight_source_id": "main",
                "dbt_pod_patch": case.dbt_pod_patch,
                "identity_pod_patch": case.identity_pod_patch,
            }
            if case.sync_resources != "{}":
                expected["sync_resources"] = case.sync_resources

            assert actual == expected, (case.name, cron)
            assert len(parameters) == len(expected), (case.name, cron)
