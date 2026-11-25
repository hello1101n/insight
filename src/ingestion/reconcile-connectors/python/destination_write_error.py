from __future__ import annotations

import html
import json
import os
import re
import sys
from collections.abc import Iterator

from pydantic import BaseModel, ConfigDict, JsonValue, TypeAdapter, ValidationError

MASK = "[REDACTED]"
MAX_BODY_BYTES = 512
JSON_VALUE = TypeAdapter(JsonValue)


class DestinationWrite(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    connectionConfiguration: dict[str, JsonValue]


def sensitive_key(key: str) -> bool:
    key = key.casefold()
    return any(part in key for part in ("password", "secret", "token"))


def secret_values(value: JsonValue, sensitive: bool = False) -> Iterator[str]:
    if isinstance(value, dict):
        for key, item in value.items():
            yield from secret_values(item, sensitive or sensitive_key(key))
    elif isinstance(value, list):
        for item in value:
            yield from secret_values(item, sensitive)
    elif sensitive and isinstance(value, str) and value:
        yield value


def encoded_character(char: str) -> str:
    utf16 = char.encode("utf-16-be", errors="surrogatepass").hex()
    unicode_escapes = "".join(r"\\[uU]" + utf16[index : index + 4] for index in range(0, len(utf16), 4))
    percent_escapes = "".join(f"%{byte:02x}" for byte in char.encode(errors="surrogatepass"))
    literals = {char, json.dumps(char, ensure_ascii=False)[1:-1], html.escape(char)}
    if char == "/":
        literals.add(r"\/")
    if char == " ":
        literals.add("+")
    return "(?:" + "|".join([*map(re.escape, sorted(literals)), f"(?i:{unicode_escapes}|{percent_escapes})"]) + ")"


def secret_pattern(secrets: set[str]) -> re.Pattern[str]:
    values = secrets | {html.unescape(secret) for secret in secrets}
    patterns = ["".join(map(encoded_character, secret)) for secret in sorted(values - {""}, key=len, reverse=True)]
    return re.compile("|".join(patterns) or r"(?!)")


def redact(value: JsonValue, pattern: re.Pattern[str]) -> JsonValue:
    if isinstance(value, str):
        return pattern.sub(MASK, value)
    if isinstance(value, list):
        return [redact(item, pattern) for item in value]
    if isinstance(value, dict):
        return {
            pattern.sub(MASK, key): MASK if sensitive_key(key) else redact(item, pattern) for key, item in value.items()
        }
    return value


def one_line(value: str, pattern: re.Pattern[str], limit: int) -> str:
    printable = "".join(char if char.isprintable() else " " for char in value)
    masked = pattern.sub(MASK, printable)
    return masked.encode(errors="replace")[:limit].decode(errors="ignore").strip()


def main() -> None:
    operation, destination, status = sys.argv[1:]
    request, token, response = sys.stdin.read().split("\0", 2)
    try:
        configuration = DestinationWrite.model_validate_json(request).connectionConfiguration
    except ValidationError:
        print(f"Airbyte destination {operation} failed. HTTP {status} body=[REDACTED]")
        return
    secrets = set(secret_values(configuration))
    for secret in (os.environ.get("RECONCILE_DEST_CLICKHOUSE_PASSWORD"), token):
        if secret:
            secrets.add(secret)
    pattern = secret_pattern(secrets)

    try:
        value = JSON_VALUE.validate_json(response)
    except ValidationError:
        body = html.unescape(pattern.sub(MASK, response))
    else:
        body = json.dumps(redact(value, pattern), ensure_ascii=False)

    target = one_line(pattern.sub(MASK, destination), pattern, 128)
    reason = one_line(body, pattern, MAX_BODY_BYTES)
    print(f"Airbyte destination {operation} failed. destination={target} HTTP {status} body={reason}")


if __name__ == "__main__":
    main()
