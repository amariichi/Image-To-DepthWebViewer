#!/usr/bin/env python3
"""Run backend and frontend servers in one terminal."""

from __future__ import annotations

import argparse
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


def frontend_command(args: argparse.Namespace) -> list[str]:
    """The frontend command, carrying through the options it accepts.

    This is the recommended way to start, so anything the mobile viewer needs
    has to be reachable from here. Without the passthrough the camera could
    only be enabled by abandoning this script and running the two servers by
    hand, which the instructions present as the alternative rather than the
    requirement.
    """
    cmd = [_python(), "scripts/run_frontend.py"]
    if args.https:
        cmd.append("--https")
    if args.cert:
        cmd += ["--cert", str(args.cert), "--key", str(args.key)]
    return cmd


def launch_frontend(args: argparse.Namespace) -> subprocess.Popen:
    port = os.environ.get("RGBDE_FRONTEND_PORT", "5173")
    env = os.environ.copy()
    env.setdefault("RGBDE_FRONTEND_PORT", port)
    cmd = frontend_command(args)
    print("::", " ".join(cmd))
    return subprocess.Popen(cmd, cwd=PROJECT_ROOT, env=env)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--https",
        action="store_true",
        help="Serve the frontend over HTTPS, which the mobile viewer's camera "
             "needs on anything but localhost.",
    )
    parser.add_argument(
        "--cert",
        type=Path,
        help="Certificate to use instead of a generated self-signed one, for "
             "example the one from `tailscale cert`.",
    )
    parser.add_argument("--key", type=Path, help="Private key matching --cert.")
    args = parser.parse_args(argv)
    if bool(args.cert) != bool(args.key):
        parser.error("--cert and --key must be given together.")
    return args


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


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    backend = launch_backend()
    frontend = launch_frontend(args)
    scheme = "https" if (args.https or args.cert) else "http"
    print(":: Backend -> http://localhost:%s" % os.environ.get("RGBDE_BACKEND_PORT", "8000"))
    print(":: Frontend -> %s://localhost:%s" % (scheme, os.environ.get("RGBDE_FRONTEND_PORT", "5173")))
    monitor([("backend", backend), ("frontend", frontend)])


if __name__ == "__main__":
    main()
