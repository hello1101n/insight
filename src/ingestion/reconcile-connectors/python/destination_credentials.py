from __future__ import annotations

import json
import os
import sys
from collections.abc import Mapping

from compose_destination_config import warehouse_endpoint
from pydantic import BaseModel, ConfigDict, JsonValue, TypeAdapter, ValidationError

WAREHOUSE_FIELDS = ("host", "port", "protocol")
MASK = "**********"
CONFIGURATION = TypeAdapter(dict[str, JsonValue])


class Destination(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    destinationId: str
    name: str
    connectionConfiguration: dict[str, JsonValue] | None = None


class DestinationList(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    destinations: list[Destination]


class WarehouseMismatch(ValueError):
    pass


def warehouse_value(key: str, value: object) -> object:
    if key == "host" and isinstance(value, str):
        return value.removesuffix(".").casefold()
    return value


def require_same_warehouse(destination: Destination, desired: Mapping[str, object]) -> None:
    current = destination.connectionConfiguration or {}
    differences = [
        key
        for key in WAREHOUSE_FIELDS
        if not warehouse_value(key, desired.get(key))
        or warehouse_value(key, current.get(key)) != warehouse_value(key, desired.get(key))
    ]
    tunnel = current.get("tunnel_method")
    if tunnel is not None and tunnel != {"tunnel_method": "NO_TUNNEL"}:
        differences.append("tunnel_method")
    if differences:
        destination_id = "".join(char for char in destination.destinationId if char.isprintable())
        raise WarehouseMismatch(f"destination={destination_id} fields={','.join(differences)}")


def named_drift(name: str, payload: str) -> int:
    desired_json, response = payload.split("\0", 1)
    desired = CONFIGURATION.validate_json(desired_json)
    destinations = DestinationList.model_validate_json(response).destinations
    destination = next((item for item in destinations if item.name == name), None)
    if destination is None:
        return 0

    current = destination.connectionConfiguration or {}
    drift = [
        key
        for key in sorted(current.keys() | desired.keys())
        if current.get(key) != MASK
        and warehouse_value(key, current.get(key, MASK)) != warehouse_value(key, desired.get(key, MASK))
    ]
    print(f"{destination.destinationId}\t{' '.join(drift)}")
    return 0


def credentials_update(destination_id: str, payload: str) -> int:
    destination = Destination.model_validate_json(payload)
    config = destination.connectionConfiguration or {}
    if destination.destinationId != destination_id:
        print("Airbyte destination identity or ClickHouse configuration did not match.", file=sys.stderr)
        return 1

    require_same_warehouse(destination, warehouse_endpoint(os.environ))
    if not isinstance(config.get("username"), str):
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


def main() -> int:
    operation, target = sys.argv[1:]
    payload = sys.stdin.read()
    try:
        if operation == "drift":
            return named_drift(target, payload)
        return credentials_update(target, payload)
    except WarehouseMismatch as error:
        print(f"Airbyte destination warehouse differs. {error}")
        return 3
    except ValidationError as error:
        for field in error.errors(include_input=False):
            print(f"Airbyte destination response: {field['loc'][:1]} ({field['type']}).", file=sys.stderr)
    except KeyError as error:
        print(f"Airbyte destination configuration requires {error}.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
