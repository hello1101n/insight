from __future__ import annotations

import json
import os
import sys

from pydantic import BaseModel, ConfigDict, JsonValue, ValidationError


class Destination(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    destinationId: str
    name: str
    connectionConfiguration: dict[str, JsonValue]


def main() -> int:
    try:
        destination = Destination.model_validate_json(sys.stdin.read())
    except ValidationError as error:
        for field in error.errors(include_input=False):
            print(f"Airbyte destination response: {field['loc']} ({field['type']}).", file=sys.stderr)
        return 1

    config = destination.connectionConfiguration
    if destination.destinationId != sys.argv[1] or not isinstance(config.get("username"), str):
        print("Airbyte destination identity or ClickHouse configuration did not match.", file=sys.stderr)
        return 1

    username = os.environ["RECONCILE_DEST_CLICKHOUSE_USERNAME"]
    password = os.environ["RECONCILE_DEST_CLICKHOUSE_PASSWORD"]
    print(
        json.dumps(
            {
                "destinationId": destination.destinationId,
                "name": destination.name,
                "connectionConfiguration": config | {"username": username, "password": password},
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
