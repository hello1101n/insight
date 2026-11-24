from __future__ import annotations

import json
import ssl
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from threading import Condition, Event, Thread
from types import TracebackType
from typing import Self

from airbyte_resources import Response
from api_response import parse_response, response_errors, transient_error
from pydantic import Field, JsonValue, PositiveInt

LEASE_SECONDS = 60
RENEW_SECONDS = 10
RENEW_RETRY_SECONDS = 1
HOLD_SECONDS = 120
API_TIMEOUT_SECONDS = 5


class CapacityConfigurationError(RuntimeError):
    pass


class LeaseLost(OSError):
    pass


def lease_conflict(error: BaseException) -> bool:
    return isinstance(error, urllib.error.HTTPError) and error.code == 409


class Kubernetes:
    def __init__(self, context: ssl.SSLContext, token: Path) -> None:
        self.context = context
        self.token = token

    def read[Model: Response](
        self,
        path: str,
        model: type[Model],
        patch: dict[str, JsonValue] | None = None,
        *,
        timeout: float = API_TIMEOUT_SECONDS,
    ) -> Model:
        request = urllib.request.Request(
            f"https://kubernetes.default.svc{path}",
            data=json.dumps(patch).encode() if patch is not None else None,
            method="PATCH" if patch is not None else "GET",
            headers={
                "Authorization": f"Bearer {self.token.read_text().strip()}",
                "Content-Type": "application/merge-patch+json",
            },
        )
        try:
            # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
            with response_errors(), urllib.request.urlopen(request, timeout=timeout, context=self.context) as response:
                return parse_response(model, response.read())
        except urllib.error.HTTPError as error:
            if not (transient_error(error) or (patch is not None and lease_conflict(error))):
                operation = request.get_method()
                resource = path.partition("?")[0]
                raise CapacityConfigurationError(f"{operation} {resource} returned HTTP {error.code}") from None
            raise


class LeaseSpec(Response):
    holder: str | None = Field(default=None, alias="holderIdentity")
    duration: PositiveInt | None = Field(default=None, alias="leaseDurationSeconds")
    renewed_at: datetime | None = Field(default=None, alias="renewTime")


class LeaseMetadata(Response):
    version: str = Field(alias="resourceVersion")


class Lease(Response):
    metadata: LeaseMetadata
    spec: LeaseSpec = LeaseSpec()


class LeaseClient:
    def __init__(self, api: Kubernetes, namespace: str, holder: str, name: str) -> None:
        self.api = api
        self.path = f"/apis/coordination.k8s.io/v1/namespaces/{namespace}/leases/{name}"
        self.holder = holder
        self.observed: tuple[str | None, datetime | None] | None = None
        self.observed_at = 0.0

    def write(self, lease: Lease, duration: int | None, *, timeout: float = API_TIMEOUT_SECONDS) -> Lease:
        return self.api.read(
            self.path,
            Lease,
            {
                "metadata": {"resourceVersion": lease.metadata.version},
                "spec": {
                    "holderIdentity": self.holder if duration is not None else None,
                    "leaseDurationSeconds": duration,
                    "renewTime": datetime.now(UTC).isoformat(timespec="microseconds") if duration is not None else None,
                },
            },
            timeout=timeout,
        )

    def take(self) -> HeldLease | None:
        current = self.api.read(self.path, Lease)
        now = time.monotonic()
        spec = current.spec
        identity = (spec.holder, spec.renewed_at)
        if identity != self.observed:
            self.observed = identity
            self.observed_at = now
        if spec.holder:
            if spec.duration is None or spec.renewed_at is None:
                raise CapacityConfigurationError("The capacity Lease lacks an expiry.")
            if now - self.observed_at < spec.duration:
                return None
        try:
            acquired = self.write(current, LEASE_SECONDS)
        except urllib.error.HTTPError as error:
            if not lease_conflict(error):
                raise
            return None
        return HeldLease(self, acquired, now)


class HeldLease:
    def __init__(self, client: LeaseClient, lease: Lease, started_at: float) -> None:
        self.client = client
        self.lease = lease
        self.deadline = started_at + HOLD_SECONDS
        self.valid_until = started_at + min(LEASE_SECONDS, HOLD_SECONDS)
        self.stop = Event()
        self.lost = Event()
        self.changed = Condition()
        self.error: OSError | ValueError | CapacityConfigurationError | None = None
        self.thread = Thread(target=self._maintain, daemon=True)

    def __enter__(self) -> Self:
        self.thread.start()
        return self

    def __exit__(
        self, _kind: type[BaseException] | None, _error: BaseException | None, _trace: TracebackType | None
    ) -> None:
        self.close()

    def ensure_held(self, minimum_seconds: float = 0) -> None:
        with self.changed:
            while True:
                now = time.monotonic()
                if self.error is not None:
                    raise self.error
                if self.lost.is_set() or now >= self.valid_until or now + minimum_seconds >= self.deadline:
                    raise LeaseLost("The capacity Lease cannot cover submission.")
                if self.valid_until - now >= minimum_seconds:
                    return
                self.changed.wait(min(self.valid_until, self.deadline - minimum_seconds) - now)

    def close(self) -> None:
        self.stop.set()
        self.thread.join()

    def _renew(self, now: float, duration: int, timeout: float) -> None:
        try:
            self.lease = self.client.write(self.lease, duration, timeout=timeout)
        except urllib.error.HTTPError as error:
            if not lease_conflict(error):
                raise
            remaining = min(timeout, self.valid_until - time.monotonic())
            if remaining <= 0:
                raise LeaseLost("The capacity Lease expired.") from None
            current = self.client.api.read(self.client.path, Lease, timeout=remaining)
            if current.spec.holder != self.client.holder:
                raise LeaseLost("The capacity Lease changed holders.") from None
            self.lease = current
            raise
        with self.changed:
            self.valid_until = now + duration
            self.changed.notify_all()

    def _maintain(self) -> None:
        delay = RENEW_SECONDS
        retry_error = None
        try:
            while not self.stop.wait(max(0, min(delay, self.valid_until - time.monotonic()))):
                now = time.monotonic()
                remaining = self.valid_until - now
                duration = min(LEASE_SECONDS, int(self.deadline - now))
                if remaining <= 0 or duration <= 0:
                    if duration <= 0 and remaining > 0:
                        self.stop.wait(remaining)
                    self.error = retry_error
                    break
                try:
                    self._renew(now, duration, min(API_TIMEOUT_SECONDS, remaining))
                except OSError as error:
                    if not (transient_error(error) or lease_conflict(error)):
                        raise
                    retry_error = error
                    delay = RENEW_RETRY_SECONDS
                else:
                    retry_error = None
                    delay = RENEW_SECONDS
        except (OSError, ValueError, CapacityConfigurationError) as error:
            self.error = error
        finally:
            try:
                self.client.write(self.lease, None)
            except (OSError, ValueError, CapacityConfigurationError) as error:
                if self.error is None:
                    self.error = LeaseLost("The capacity Lease release conflicted.") if lease_conflict(error) else error
            finally:
                with self.changed:
                    self.lost.set()
                    self.changed.notify_all()
