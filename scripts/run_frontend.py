#!/usr/bin/env python3
"""Serve the editor, mobile viewer, and same-origin scene relay."""

from __future__ import annotations

import argparse
import ipaddress
import os
import socket
import subprocess
import sys
from pathlib import Path

import uvicorn

DEFAULT_PORT = int(os.environ.get("RGBDE_FRONTEND_PORT", "5173"))
DEFAULT_HOST = os.environ.get("RGBDE_FRONTEND_HOST", "0.0.0.0")
PROJECT_ROOT = Path(__file__).resolve().parents[1]
CERT_DIR = PROJECT_ROOT / ".certs"
CERT_PATH = CERT_DIR / "viewer.crt"
KEY_PATH = CERT_DIR / "viewer.key"

# Safari rejects server certificates valid for more than 398 days, whether or
# not they were issued by a public authority.
CERT_VALID_DAYS = 365


def detect_lan_addresses() -> list[str]:
    """The addresses a phone on the same network could reach this host by.

    Opening a UDP socket to a routable address picks the interface the kernel
    would actually route through, without sending anything.
    """
    addresses: list[str] = []
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        addresses.append(probe.getsockname()[0])
    except OSError:
        pass
    finally:
        probe.close()

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            address = info[4][0]
            if address not in addresses and not address.startswith("127."):
                addresses.append(address)
    except OSError:
        pass
    return addresses


def build_san(addresses: list[str]) -> str:
    """The subject alternative names the certificate must carry.

    A common name alone has not been accepted for years; without a matching
    SAN entry the phone rejects the certificate outright rather than offering
    to continue.
    """
    entries = ["DNS:localhost", "IP:127.0.0.1"]
    for address in addresses:
        try:
            ipaddress.ip_address(address)
        except ValueError:
            entry = f"DNS:{address}"
        else:
            entry = f"IP:{address}"
        if entry not in entries:
            entries.append(entry)
    return ",".join(entries)


def cert_covers(cert_path: Path, san: str) -> bool:
    """Whether an existing certificate still names every current address.

    A laptop that moved to a different network gets a different address, and a
    certificate that no longer names it would fail on the phone with an error
    that looks nothing like its cause.
    """
    if not cert_path.exists():
        return False
    try:
        result = subprocess.run(
            ["openssl", "x509", "-noout", "-ext", "subjectAltName", "-in", str(cert_path)],
            capture_output=True,
            text=True,
            check=True,
        )
        # A certificate that expires while the server is up would fail on the
        # phone partway through a session.
        subprocess.run(
            ["openssl", "x509", "-noout", "-checkend", "86400", "-in", str(cert_path)],
            capture_output=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return False

    # openssl prints an address entry as "IP Address:1.2.3.4" rather than in the
    # "IP:1.2.3.4" form the request takes, so the two have to be matched in the
    # printed spelling.
    present = result.stdout.replace(" ", "")
    for entry in san.split(","):
        kind, _, value = entry.partition(":")
        token = f"IPAddress:{value}" if kind == "IP" else f"DNS:{value}"
        if token not in present:
            return False
    return True


def ensure_self_signed_cert(cert_path: Path, key_path: Path, addresses: list[str]) -> None:
    san = build_san(addresses)
    if cert_covers(cert_path, san) and key_path.exists():
        return

    cert_path.parent.mkdir(parents=True, exist_ok=True)
    common_name = addresses[0] if addresses else "localhost"
    try:
        subprocess.run(
            [
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                "-days", str(CERT_VALID_DAYS),
                "-keyout", str(key_path),
                "-out", str(cert_path),
                "-subj", f"/CN={common_name}",
                "-addext", f"subjectAltName={san}",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
    except FileNotFoundError:
        raise SystemExit(
            "openssl was not found, and it is needed to create the certificate.\n"
            "Install it, or pass a certificate you already have with --cert/--key."
        ) from None
    except subprocess.CalledProcessError as error:
        raise SystemExit(f"Could not create the certificate:\n{error.stderr}") from None

    key_path.chmod(0o600)
    print(f"Created a self-signed certificate for {san} in {cert_path.parent}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--https",
        action="store_true",
        help="Serve over HTTPS. The mobile viewer's camera needs this on anything "
             "but localhost.",
    )
    parser.add_argument(
        "--cert",
        type=Path,
        help="Certificate to use instead of the generated self-signed one, for "
             "example the one from `tailscale cert`.",
    )
    parser.add_argument("--key", type=Path, help="Private key matching --cert.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default=DEFAULT_HOST)
    args = parser.parse_args(argv)

    if bool(args.cert) != bool(args.key):
        parser.error("--cert and --key must be given together.")
    if args.cert and not args.https:
        args.https = True
    return args


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    if str(PROJECT_ROOT) not in sys.path:
        sys.path.insert(0, str(PROJECT_ROOT))
    from server.viewer_host import app

    addresses = detect_lan_addresses()
    ssl_options: dict[str, str] = {}

    if args.https:
        if args.cert:
            cert_path, key_path = args.cert, args.key
            for path in (cert_path, key_path):
                if not path.exists():
                    raise SystemExit(f"{path} does not exist.")
        else:
            cert_path, key_path = CERT_PATH, KEY_PATH
            ensure_self_signed_cert(cert_path, key_path, addresses)
        ssl_options = {"ssl_certfile": str(cert_path), "ssl_keyfile": str(key_path)}

    scheme = "https" if args.https else "http"
    print(f"Serving editor and mobile viewer at {scheme}://localhost:{args.port}")
    if args.https:
        for address in addresses:
            print(f"  Mobile viewer: {scheme}://{address}:{args.port}/viewer.html")
        if not args.cert:
            print("  The phone will warn about the certificate once; continue past it.")
    else:
        print("  The mobile viewer's camera needs HTTPS. Restart with --https to enable it.")

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning", **ssl_options)


if __name__ == "__main__":
    main()
