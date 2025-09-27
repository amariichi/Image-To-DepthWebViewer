#!/usr/bin/env python3
"""Run backend and frontend servers in one terminal."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _python() -> str:
    return sys.executable


def launch_backend() -> subprocess.Popen:
    host = os.environ.get("RGBDE_BACKEND_HOST", "0.0.0.0")
    port = os.environ.get("RGBDE_BACKEND_PORT", "8000")
    cmd = [
        _python(),
        "-m",
        "uvicorn",
        "server.main:app",
        "--host",
        host,
        "--port",
        port,
        "--reload",
    ]
    print("::", " ".join(cmd))
    return subprocess.Popen(cmd, cwd=PROJECT_ROOT)


def launch_frontend() -> subprocess.Popen:
    port = os.environ.get("RGBDE_FRONTEND_PORT", "5173")
    env = os.environ.copy()
    env.setdefault("RGBDE_FRONTEND_PORT", port)
    cmd = [_python(), "scripts/run_frontend.py"]
    print("::", " ".join(cmd))
    return subprocess.Popen(cmd, cwd=PROJECT_ROOT, env=env)


def monitor(processes: list[tuple[str, subprocess.Popen]]) -> None:
    try:
        while True:
            for name, proc in processes:
                ret = proc.poll()
                if ret is not None:
                    raise RuntimeError(f"{name} exited with code {ret}")
            time.sleep(0.8)
    except KeyboardInterrupt:
        print("\n:: Keyboard interrupt received, shutting down...")
    except RuntimeError as exc:
        print(f":: {exc}")
    finally:
        for name, proc in processes:
            if proc.poll() is None:
                try:
                    proc.send_signal(signal.SIGTERM)
                except Exception:
                    pass
        for name, proc in processes:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    proc.kill()
                except Exception:
                    pass


def main() -> None:
    backend = launch_backend()
    frontend = launch_frontend()
    print(":: Backend -> http://localhost:%s" % os.environ.get("RGBDE_BACKEND_PORT", "8000"))
    print(":: Frontend -> http://localhost:%s" % os.environ.get("RGBDE_FRONTEND_PORT", "5173"))
    monitor([("backend", backend), ("frontend", frontend)])


if __name__ == "__main__":
    main()
