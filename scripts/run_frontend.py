#!/usr/bin/env python3
"""Serve the static webapp directory for local development."""

from __future__ import annotations

import http.server
import os
import socketserver
from pathlib import Path

DEFAULT_PORT = int(os.environ.get("RGBDE_FRONTEND_PORT", "5173"))
WEBAPP_DIR = Path(__file__).resolve().parents[1] / "webapp"


class QuietHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:  # noqa: A003 - matches base signature
        pass


def main() -> None:
    os.chdir(WEBAPP_DIR)
    handler = QuietHTTPRequestHandler
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", DEFAULT_PORT), handler) as httpd:
        print(f"Serving {WEBAPP_DIR} at http://localhost:{DEFAULT_PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopping frontend server…")


if __name__ == "__main__":
    main()
