from __future__ import annotations

import base64
import json
import re
import time

from conftest import AUTHENTICATOR, AUTHZ_CACHE_MAX_AGE, GW, SQL_TOKEN_STUB

ROUTES = ["/api/analytics", "/api/identity", "/api/authenticator"]
UUID_V7 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

UNAUTHENTICATED_TYPE = "gts://gts.cf.core.errors.err.v1~cf.core.err.unauthenticated.v1~"
SERVICE_UNAVAILABLE_TYPE = "gts://gts.cf.core.errors.err.v1~cf.core.err.service_unavailable.v1~"


def _b64url_json(segment):
    segment += "=" * (-len(segment) % 4)
    return json.loads(base64.urlsafe_b64decode(segment))


def test_no_cookie_401_on_every_route(client):
    for route in ROUTES:
        status, headers, _ = client.request(f"{GW}{route}/x")
        assert status == 401, f"{route}: got {status}"
        assert "www-authenticate" in headers, route


def test_401_body_is_canonical_problem(client):
    _, headers, body = client.request(f"{GW}/api/analytics/x")
    assert "problem+json" in headers.get("content-type", "")
    prob = json.loads(body)
    assert prob["type"] == UNAUTHENTICATED_TYPE
    assert prob["title"] == "Unauthenticated"
    assert prob["status"] == 401


def test_login_injects_verifiable_jwt_and_applies_hygiene(client):
    sid = client.login()
    resp = client.request(
        f"{GW}/api/analytics/data",
        headers={
            "Cookie": f"__Host-sid={sid}; keep=1",
            "Authorization": "Bearer FORGED",
            "X-Correlation-Id": "forged-corr",
        },
    )
    status, _, body = resp
    assert status == 200, f"got {status}"
    echoed = json.loads(body)["headers"]

    auth = echoed.get("authorization", "")
    assert auth.startswith("Bearer ") and auth != "Bearer FORGED", auth
    header, claims = auth.split(" ", 1)[1].split(".")[:2]
    assert _b64url_json(header)["alg"] == "ES256"
    assert "sub" in _b64url_json(claims)

    assert "__Host-sid" not in echoed.get("cookie", "")
    assert "keep=1" in echoed.get("cookie", "")

    corr = echoed.get("x-correlation-id", "")
    assert corr and corr != "forged-corr"
    assert UUID_V7.match(corr), corr


def test_correlation_ids_are_unique_per_request(client):
    sid = client.login()
    seen = set()
    for _ in range(3):
        _, _, body = client.request(f"{GW}/api/analytics/data", headers={"Cookie": f"__Host-sid={sid}"})
        seen.add(json.loads(body)["headers"].get("x-correlation-id"))
    assert len(seen) == 3, seen


def test_jwks_served_by_authenticator_not_gateway(client):
    status, _, body = client.request(f"{AUTHENTICATOR}/.well-known/jwks.json")
    assert status == 200, f"got {status}"
    assert "keys" in json.loads(body)


def test_spa_passthrough_on_root(client):
    status, _, body = client.request(f"{GW}/")
    assert status == 200 and json.loads(body)["path"] == "/"


def test_internal_and_unmatched_api_are_404(client):
    assert client.request(f"{GW}/internal/anything")[0] == 404
    assert client.request(f"{GW}/api/v1/nope")[0] == 404


class TestAuthenticatorDown:
    def test_cached_cookie_still_served(self, client, session_sid, authenticator_down):
        status, _, _ = client.request(f"{GW}/api/analytics/x", headers={"Cookie": f"__Host-sid={session_sid}"})
        assert status == 200, f"got {status}"

    def test_cold_cookie_fails_closed(self, client, authenticator_down):
        status, headers, body = client.request(
            f"{GW}/api/analytics/x", headers={"Cookie": "__Host-sid=cold-never-seen"}
        )
        assert status == 503, f"got {status}"
        assert "retry-after" in headers
        prob = json.loads(body)
        assert prob["type"] == SERVICE_UNAVAILABLE_TYPE
        assert prob["context"]["retry_after_seconds"] == 5


def test_revocation_within_cache_window(client, session_sid):
    logout = client.request(
        f"{GW}/auth/logout",
        headers={"Cookie": f"__Host-sid={session_sid}", "X-CSRF-Token": client.csrf_token(session_sid)},
        method="POST",
    )
    assert logout[0] == 200, f"logout got {logout[0]}"
    deadline = time.monotonic() + AUTHZ_CACHE_MAX_AGE + 5
    status = None
    while time.monotonic() < deadline:
        status, _, _ = client.request(f"{GW}/api/analytics/x", headers={"Cookie": f"__Host-sid={session_sid}"})
        if status == 401:
            break
        time.sleep(1)
    assert status == 401, f"revoked session still {status} after {AUTHZ_CACHE_MAX_AGE + 5}s"


def test_dead_upstream_5xx(client, echo_down):
    sid = client.login()
    status, _, _ = client.request(f"{GW}/api/analytics/x", headers={"Cookie": f"__Host-sid={sid}"})
    # Connection refused -> 502; unroutable (killed container) -> 504 at the
    # bounded proxy_connect_timeout. Either is the fail-fast dead-upstream path.
    assert status in (502, 504), f"got {status}"


def _stub_calls(client, token=None):
    _, _, body = client.request(f"{SQL_TOKEN_STUB}/calls")
    calls = json.loads(body)
    return calls["total"] if token is None else calls["by_token"].get(token, 0)


def _sql(client, token):
    return client.request(
        f"{GW}/api/sql/query",
        headers={"Authorization": f"Bearer {token}", "Cookie": "__Host-sid=ignored; keep=1"},
        method="POST",
        data={"q": "select 1"},
    )


def test_personal_token_is_exchanged_for_a_jwt(client):
    token = "isql_known_exchange_" + "A" * 23
    status, _, body = _sql(client, token)
    assert status == 200, f"got {status}"
    echoed = json.loads(body)["headers"]
    assert echoed["authorization"] == f"Bearer stub-jwt-for.{token}"
    assert "cookie" not in echoed
    assert UUID_V7.match(echoed.get("x-correlation-id", ""))


def test_personal_token_second_request_is_a_cache_hit(client):
    token = "isql_known_cached_" + "B" * 25
    assert _sql(client, token)[0] == 200
    assert _sql(client, token)[0] == 200
    assert _stub_calls(client, token) == 1


def test_refused_personal_token_is_401_and_asked_again(client):
    token = "isql_refused_" + "C" * 30
    for attempt in (1, 2):
        status, headers, body = _sql(client, token)
        assert status == 401, f"got {status}"
        assert "www-authenticate" in headers
        assert json.loads(body)["type"] == UNAUTHENTICATED_TYPE
        assert _stub_calls(client, token) == attempt


def test_instance_token_reaches_the_upstream_unchanged(client):
    before = _stub_calls(client)
    status, _, body = _sql(client, "instance-token-" + "D" * 20)
    assert status == 200, f"got {status}"
    echoed = json.loads(body)["headers"]
    assert echoed["authorization"] == "Bearer instance-token-" + "D" * 20
    assert "cookie" not in echoed
    assert _stub_calls(client) == before


def test_authenticator_internal_paths_are_404(client):
    cookie = {"Cookie": f"__Host-sid={client.login()}"}
    for path in ("/api/authenticator/internal/authz", "/api/authenticator/internal/sql-token/authz"):
        assert client.request(f"{GW}{path}")[0] == 404, path
        assert client.request(f"{GW}{path}", headers=cookie)[0] == 404, path
    assert client.request(f"{GW}/api/identity/internal/persons/by-email-override", headers=cookie)[0] == 200
    assert client.request(f"{GW}/api/authenticator/v1/sql-tokens", headers=cookie)[0] == 200


def test_unknown_token_flood_is_429_and_auth_stays_open(client):
    sid = client.login()
    statuses = [_sql(client, f"isql_flood_{i:04d}_" + "E" * 20)[0] for i in range(80)]
    assert 429 in statuses, statuses
    assert set(statuses) <= {401, 429}, statuses
    status, headers, body = _sql(client, "isql_flood_after_" + "E" * 20)
    assert status == 429
    assert json.loads(body)["status"] == 429
    assert client.request(f"{GW}/auth/csrf", headers={"Cookie": f"__Host-sid={sid}"})[0] == 200
