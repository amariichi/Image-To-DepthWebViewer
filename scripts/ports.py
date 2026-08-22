"""Saying which process holds a port, rather than only that one is taken.

A server that cannot bind fails after the startup messages have already been
printed, so the run reads as three lines of success followed by an errno. The
port is almost always held by an earlier instance of the same server, and the
only thing missing to act on it is which process that is.
"""

from __future__ import annotations

import re
import socket
import subprocess

_PID_IN_SS_OUTPUT = re.compile(r"pid=(\d+)")


def port_is_free(port: int, host: str = "0.0.0.0") -> bool:
    """Whether a server could bind here.

    `SO_REUSEADDR` matches what uvicorn sets, so a port left in `TIME_WAIT` by
    a stopped server reads as free -- which it is. On Linux the option does not
    extend to a port with a live listener, so this still reports those as busy.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((host, port))
        except OSError:
            return False
    return True


def _command_of(pid: int) -> str:
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as handle:
            parts = [p.decode(errors="replace") for p in handle.read().split(b"\0") if p]
    except OSError:
        return "unknown"
    if not parts:
        return "unknown"
    # The interpreter's absolute path is noise next to the script it is running.
    meaningful = [p for p in parts[1:] if not p.startswith("-")]
    return meaningful[0] if meaningful else parts[0]


def _started_at(pid: int) -> str | None:
    try:
        result = subprocess.run(
            ["ps", "-o", "lstart=", "-p", str(pid)],
            capture_output=True, text=True, check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    return result.stdout.strip() or None


def parse_listeners(ss_output: str) -> dict[int, int]:
    """Port to process id, from the output of `ss -ltnp`.

    The port is taken from the local address column and compared as a number.
    Searching the line as text would find 5173 inside 15173 and name a process
    that has nothing to do with the port that is busy.
    """
    listeners: dict[int, int] = {}
    for line in ss_output.splitlines():
        fields = line.split()
        if len(fields) < 4:
            continue
        port_text = fields[3].rsplit(":", 1)[-1]
        if not port_text.isdigit():
            continue
        match = _PID_IN_SS_OUTPUT.search(line)
        if match is None:
            continue
        listeners.setdefault(int(port_text), int(match.group(1)))
    return listeners


def find_port_holder(port: int) -> dict | None:
    """The listening process on a port, as far as `ss` will say."""
    try:
        result = subprocess.run(
            ["ss", "-ltnp"], capture_output=True, text=True, check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None

    pid = parse_listeners(result.stdout).get(port)
    if pid is None:
        return None
    return {"pid": pid, "command": _command_of(pid), "started": _started_at(pid)}


def describe_busy_port(port: int, label: str) -> str:
    holder = find_port_holder(port)
    if holder is None:
        # `ss` may be absent, or the holder may belong to another account.
        return (
            f"Port {port} ({label}) is already in use, and the process holding it "
            f"could not be identified."
        )
    started = f", started {holder['started']}" if holder["started"] else ""
    return (
        f"Port {port} ({label}) is already in use by PID {holder['pid']} "
        f"({holder['command']}{started}).\n"
        f"Stop it with: kill {holder['pid']}"
    )


def require_free_port(port: int, label: str, host: str = "0.0.0.0") -> None:
    """Fail before any setup work when the port cannot be had.

    Checked up front so the certificate is not issued and the addresses are not
    printed for a server that is about to fail to start.
    """
    if port_is_free(port, host):
        return
    raise SystemExit(describe_busy_port(port, label))
