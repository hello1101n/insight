from __future__ import annotations

import html
import json
import os
import re
import sys
from collections.abc import Iterator

from pydantic import JsonValue, TypeAdapter, ValidationError

MASK = "[REDACTED]"
MAX_BODY_BYTES = 512
JSON_VALUE = TypeAdapter(JsonValue)


def passwords(value: JsonValue, sensitive: bool = False) -> Iterator[str]:
    if isinstance(value, dict):
        for key, item in value.items():
            yield from passwords(item, sensitive or "password" in key.casefold())
    elif isinstance(value, list):
        for item in value:
            yield from passwords(item, sensitive)
    elif sensitive and isinstance(value, str) and value:
        yield value


def secret_pattern(secrets: set[str]) -> re.Pattern[str]:
    spellings = set(secrets)
    for secret in secrets:
        spellings.add(html.escape(secret))
        spellings.add(json.dumps(secret, ensure_ascii=True)[1:-1])
        spellings.add(json.dumps(secret, ensure_ascii=False)[1:-1])
    return re.compile("|".join(map(re.escape, sorted(spellings, key=len, reverse=True))) or r"(?!)")


def redact(value: JsonValue, pattern: re.Pattern[str]) -> JsonValue:
    if isinstance(value, str):
        return pattern.sub(MASK, value)
    if isinstance(value, list):
        return [redact(item, pattern) for item in value]
    if isinstance(value, dict):
        return {pattern.sub(MASK, key): redact(item, pattern) for key, item in value.items()}
    return value


def one_line(value: str, limit: int) -> str:
    printable = "".join(char if char.isprintable() else " " for char in value)
    return printable.encode(errors="replace")[:limit].decode(errors="ignore").strip()


def main() -> None:
    operation, destination, status = sys.argv[1:]
    request, response = sys.stdin.read().split("\0", 1)
    configuration = json.loads(request)["connectionConfiguration"]
    secrets = set(passwords(configuration))
    for name in ("RECONCILE_DEST_CLICKHOUSE_PASSWORD", "AIRBYTE_TOKEN"):
        if secret := os.environ.get(name):
            secrets.add(secret)
    pattern = secret_pattern(secrets)

    try:
        value = JSON_VALUE.validate_json(response)
    except ValidationError:
        body = pattern.sub(MASK, html.unescape(response))
    else:
        body = json.dumps(redact(value, pattern), ensure_ascii=False)

    target = one_line(pattern.sub(MASK, destination), 128)
    reason = one_line(pattern.sub(MASK, body), MAX_BODY_BYTES)
    print(f"Airbyte destination {operation} failed. destination={target} HTTP {status} body={reason}")


if __name__ == "__main__":
    main()
