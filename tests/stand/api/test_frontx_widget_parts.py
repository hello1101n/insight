"""The edge serves the FrontX widget parts, and the page policy lets them run.

    GET /widgets/widgets.json             200, a list of widget part paths
    GET <each listed widget.gts.json>     200
    GET /                                 Content-Security-Policy: script-src 'self' blob:

The FrontX dashboard template loads its widget types at run time: it reads
`/widgets/widgets.json`, then each `widget.gts.json` that list names, and runs
the widget code it fetches from a `blob:` URL. A missing part or a policy
without `blob:` leaves every FrontX cell empty while the rest of the SPA works,
and only a person who turned on "Show planned sections" would see it. These
checks need no session: the parts are static files, like the SPA bundle.
"""

from __future__ import annotations

import pytest
from insight_stand import ApiClient

WIDGET_LIST = "/widgets/widgets.json"


def _script_sources(policy: str) -> list[str]:
    for directive in policy.split(";"):
        name, *sources = directive.split()
        if name == "script-src":
            return sources
    return []


@pytest.mark.reliability
def test_every_widget_part_the_list_names_is_served(api_client: ApiClient) -> None:
    listing = api_client.get(WIDGET_LIST)
    assert listing.status_code == 200, f"{WIDGET_LIST}: {listing.status_code} {listing.text[:300]}"

    parts = listing.json()
    assert isinstance(parts, list), f"{WIDGET_LIST} is not a list: {listing.text[:300]}"
    assert parts, f"{WIDGET_LIST} names no widget part, so FrontX can draw no cell"

    unserved = []
    for part in parts:
        assert isinstance(part, str), f"not a path: {part!r}"
        assert part.startswith("/widgets/") and part.endswith("/widget.gts.json"), part
        response = api_client.get(part)
        if response.status_code != 200:
            unserved.append(f"{part}: {response.status_code}")

    assert not unserved, "\n".join(unserved)


@pytest.mark.security
def test_the_page_lets_scripts_run_from_itself_and_from_blobs_only(api_client: ApiClient) -> None:
    response = api_client.get("/")
    assert response.status_code == 200, f"/: {response.status_code}"

    policy = response.headers.get("content-security-policy", "")
    assert _script_sources(policy) == ["'self'", "blob:"], f"script-src of {policy!r}"
