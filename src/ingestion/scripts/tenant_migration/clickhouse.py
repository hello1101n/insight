"""ClickHouse over HTTP with the standard library, as the toolbox image ships it."""

from __future__ import annotations

import itertools
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from http.client import HTTPResponse

#: One statement may copy a large Bronze table; the hook's own deadline bounds the run.
TIMEOUT_SECS = 3 * 3600.0


class ClickHouseError(RuntimeError):
    pass


@dataclass(frozen=True)
class ClickHouse:
    url: str
    user: str
    password: str
    #: Every statement's query_id starts with it, so an interrupted run can cancel what it left running.
    run_id: str = field(default_factory=lambda: f"tenant_migration-{uuid.uuid4()}")
    _counter: itertools.count = field(default_factory=itertools.count, compare=False, repr=False)

    @classmethod
    def from_env(cls) -> ClickHouse:
        values = {
            name: os.environ.get(name, "") for name in ("CLICKHOUSE_URL", "CLICKHOUSE_USER", "CLICKHOUSE_PASSWORD")
        }
        missing = [name for name, value in values.items() if not value]
        if missing:
            raise SystemExit(f"{', '.join(missing)} must be set")
        url = values["CLICKHOUSE_URL"]
        if urllib.parse.urlsplit(url).scheme not in ("http", "https"):
            raise SystemExit(f"CLICKHOUSE_URL must be an http(s) URL, got {url!r}")
        return cls(url=url.rstrip("/") + "/", user=values["CLICKHOUSE_USER"], password=values["CLICKHOUSE_PASSWORD"])

    def _request(self, body: bytes, *, params: dict[str, str]) -> HTTPResponse:
        url = self.url + "?" + urllib.parse.urlencode(params)
        request = urllib.request.Request(
            url, data=body, headers={"X-ClickHouse-User": self.user, "X-ClickHouse-Key": self.password}, method="POST"
        )
        try:
            # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
            response: HTTPResponse = urllib.request.urlopen(request, timeout=TIMEOUT_SECS)
            return response
        except urllib.error.HTTPError as error:
            raise ClickHouseError(error.read().decode("utf-8", "replace").strip()) from error
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            raise ClickHouseError(f"ClickHouse unreachable at {self.url}: {error}") from error

    def execute(self, sql: str, *, fmt: str | None = None, params: dict[str, str] | None = None) -> str:
        """Run one statement; `fmt` names the output format without touching the SQL.

        `params` binds each `{name:Type}` placeholder in `sql` server-side, sent as `param_<name>`.
        """
        query = {"query_id": f"{self.run_id}-{next(self._counter)}"}
        if fmt:
            query["default_format"] = fmt
        for name, value in (params or {}).items():
            query[f"param_{name}"] = value
        with self._request(sql.encode("utf-8"), params=query) as response:
            return response.read().decode("utf-8")

    def rows(self, sql: str) -> list[list[str]]:
        text = self.execute(sql, fmt="TabSeparatedRaw")
        return [line.split("\t") for line in text.splitlines() if line]

    def scalar(self, sql: str) -> int:
        """One non-negative integer, or an error: a guard must never read garbage as zero."""
        text = self.execute(sql).strip()
        if not text.isdigit():
            raise ClickHouseError(f"expected a number from {sql!r}, got {text!r}")
        return int(text)

    def cancel_running(self) -> None:
        """Stop a statement this run left running server-side, e.g. a copy cut off by SIGTERM."""
        self.execute(
            "KILL QUERY WHERE startsWith(query_id, {prefix:String}) SYNC", params={"prefix": f"{self.run_id}-"}
        )
