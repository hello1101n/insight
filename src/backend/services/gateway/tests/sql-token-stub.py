#!/usr/bin/env python3
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KNOWN_PREFIX = "isql_known"
UNAVAILABLE_PREFIX = "isql_unavailable"
LOCK = threading.Lock()
CALLS = {"total": 0, "by_token": {}}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status, headers, body=b""):
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/calls":
            with LOCK:
                body = json.dumps(CALLS).encode()
            return self._send(200, {"Content-Type": "application/json"}, body)
        if self.path != "/internal/sql-token/authz":
            return self._send(404, {})
        auth = self.headers.get("Authorization", "")
        token = auth[len("Bearer ") :] if auth.startswith("Bearer ") else ""
        with LOCK:
            CALLS["total"] += 1
            CALLS["by_token"][token] = CALLS["by_token"].get(token, 0) + 1
        if token.startswith(KNOWN_PREFIX):
            return self._send(
                200,
                {"X-Gateway-Jwt": f"Bearer stub-jwt-for.{token}", "Cache-Control": "max-age=30"},
            )
        if token.startswith(UNAVAILABLE_PREFIX):
            return self._send(503, {"Cache-Control": "no-store"})
        self._send(401, {"Cache-Control": "no-store"})

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    host, _, port = (sys.argv[1] if len(sys.argv) > 1 else "0.0.0.0:9091").partition(":")
    ThreadingHTTPServer((host, int(port)), Handler).serve_forever()
