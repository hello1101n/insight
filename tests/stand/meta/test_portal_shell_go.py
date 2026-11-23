"""`PortalShell.go()` survives one reset of the portal's entry script, and only one.
A script the stand's edge injects from another origin is not the portal's, so its
failure to load fails nothing.

Run 44624330960 went red because the CDN reset the connection carrying the
cached entry script: the shell stayed blank and the next click timed out 30 s
later with no word about why. These tests serve the shell from a local server
that resets that script the same way (headers, part of the body, then RST).
"""

from __future__ import annotations

import socket
import struct
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from playwright.sync_api import Browser, Page
from ui.pages.portal_shell import PortalShell

pytestmark = pytest.mark.reliability

SHELL = b'<!doctype html><script type="module" src="/assets/index.js"></script><div id="root">'
BEACON = b'<script defer src="https://beacon.example.com/beacon.min.js"></script>'
ENTRY = (
    b"document.getElementById('root').innerHTML = '<nav data-testid=\"lens-rail\">"
    b"<ul><li><button><span>Explore</span></button></li></ul></nav>';\n//" + b"x" * 200_000
)


class Stand:
    def __init__(self) -> None:
        self.resets = 0
        self.entry_requests = 0
        self.injected = b""


class Handler(BaseHTTPRequestHandler):
    stand: Stand

    def log_message(self, format: str, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        body = ENTRY if self.path == "/assets/index.js" else SHELL + self.stand.injected
        self.send_response(200)
        self.send_header("Content-Type", "text/javascript" if body is ENTRY else "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Security-Policy", "script-src 'self'")
        self.end_headers()
        if body is ENTRY:
            self.stand.entry_requests += 1
            if self.stand.resets:
                self.stand.resets -= 1
                self.wfile.write(body[:4096])
                self.wfile.flush()
                # SO_LINGER 0 turns close() into an RST, as the runner saw from the CDN.
                self.connection.setsockopt(
                    socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0)
                )
                self.close_connection = True
                return
        self.wfile.write(body)


@pytest.fixture
def stand() -> Stand:
    return Stand()


@pytest.fixture
def shell_page(browser: Browser, stand: Stand) -> Iterator[Page]:
    handler = type("StandHandler", (Handler,), {"stand": stand})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    context = browser.new_context(base_url=f"http://127.0.0.1:{server.server_address[1]}")
    try:
        yield context.new_page()
    finally:
        context.close()
        server.shutdown()
        server.server_close()


def test_one_reset_of_the_entry_script_is_reloaded_away(shell_page: Page, stand: Stand) -> None:
    stand.resets = 1

    shell = PortalShell(shell_page)
    shell.go()

    assert shell.rail.zones().first.is_visible()
    assert stand.entry_requests == 2


def test_a_reset_that_persists_fails_naming_the_script(shell_page: Page, stand: Stand) -> None:
    stand.resets = 2

    with pytest.raises(AssertionError, match=r"/assets/index\.js net::ERR_CONNECTION_RESET"):
        PortalShell(shell_page).go()
    assert stand.entry_requests == 2


def test_an_outside_script_the_policy_blocks_is_not_a_failed_load(
    shell_page: Page, stand: Stand
) -> None:
    stand.injected = BEACON

    shell = PortalShell(shell_page)
    shell.go()

    assert shell.rail.zones().first.is_visible()
    assert stand.entry_requests == 1
