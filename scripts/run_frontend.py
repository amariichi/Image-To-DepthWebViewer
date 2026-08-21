#!/usr/bin/env python3
"""Serve the editor, mobile viewer, and same-origin scene relay."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import uvicorn

DEFAULT_PORT = int(os.environ.get("RGBDE_FRONTEND_PORT", "5173"))
DEFAULT_HOST = os.environ.get("RGBDE_FRONTEND_HOST", "0.0.0.0")
PROJECT_ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    if str(PROJECT_ROOT) not in sys.path:
        sys.path.insert(0, str(PROJECT_ROOT))
    from server.viewer_host import app

    print(f"Serving editor and mobile viewer at http://localhost:{DEFAULT_PORT}")
    uvicorn.run(
        app,
        host=DEFAULT_HOST,
        port=DEFAULT_PORT,
        log_level="warning",
    )


if __name__ == "__main__":
    main()
