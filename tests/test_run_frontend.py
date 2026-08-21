from __future__ import annotations

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "run_frontend", PROJECT_ROOT / "scripts" / "run_frontend.py"
)
run_frontend = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(run_frontend)


class BuildSanTest(unittest.TestCase):
    def test_localhost_is_always_named(self) -> None:
        # The editor is opened on the serving machine itself, so the certificate
        # has to cover that as well as the address the phone uses.
        san = run_frontend.build_san([])
        self.assertIn("DNS:localhost", san)
        self.assertIn("IP:127.0.0.1", san)

    def test_addresses_are_typed_and_deduplicated(self) -> None:
        san = run_frontend.build_san(["192.168.1.5", "192.168.1.5", "host.ts.net"])
        self.assertEqual(san.count("192.168.1.5"), 1)
        self.assertIn("IP:192.168.1.5", san)
        # A name is not an address and must not be offered as one.
        self.assertIn("DNS:host.ts.net", san)

    def test_a_loopback_address_is_not_repeated(self) -> None:
        san = run_frontend.build_san(["127.0.0.1"])
        self.assertEqual(san.count("127.0.0.1"), 1)


class SelfSignedCertTest(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        base = Path(self._dir.name)
        self.cert = base / "viewer.crt"
        self.key = base / "viewer.key"

    def tearDown(self) -> None:
        self._dir.cleanup()

    def test_a_certificate_is_created_and_then_reused(self) -> None:
        run_frontend.ensure_self_signed_cert(self.cert, self.key, ["192.168.1.5"])
        self.assertTrue(self.cert.exists())
        self.assertTrue(self.key.exists())
        # The private key must not be readable by other accounts on the machine.
        # The certificate is public by design and is deliberately not restricted.
        self.assertEqual(self.key.stat().st_mode & 0o077, 0)

        # Regenerating on every start would make the phone re-prompt each time.
        first = self.cert.read_bytes()
        run_frontend.ensure_self_signed_cert(self.cert, self.key, ["192.168.1.5"])
        self.assertEqual(self.cert.read_bytes(), first)

    def test_the_certificate_names_the_address_as_a_san(self) -> None:
        # A common name alone has not been accepted for years: without a SAN
        # entry the phone refuses outright rather than offering to continue.
        run_frontend.ensure_self_signed_cert(self.cert, self.key, ["192.168.1.5"])
        printed = subprocess.run(
            ["openssl", "x509", "-noout", "-ext", "subjectAltName", "-in", str(self.cert)],
            capture_output=True, text=True, check=True,
        ).stdout
        self.assertIn("192.168.1.5", printed)

    def test_moving_to_another_network_replaces_the_certificate(self) -> None:
        # A laptop that changed networks has a different address, and a stale
        # certificate would fail on the phone for a reason that looks unrelated.
        run_frontend.ensure_self_signed_cert(self.cert, self.key, ["192.168.1.5"])
        first = self.cert.read_bytes()
        run_frontend.ensure_self_signed_cert(self.cert, self.key, ["10.0.0.9"])
        self.assertNotEqual(self.cert.read_bytes(), first)

    def test_coverage_is_matched_in_the_spelling_openssl_prints(self) -> None:
        # openssl prints "IP Address:1.2.3.4" rather than the "IP:1.2.3.4" form
        # the request takes. Comparing the request form directly reported every
        # certificate as stale, so one was issued on every start.
        run_frontend.ensure_self_signed_cert(self.cert, self.key, ["192.168.1.5"])
        san = run_frontend.build_san(["192.168.1.5"])
        self.assertTrue(run_frontend.cert_covers(self.cert, san))
        self.assertFalse(run_frontend.cert_covers(self.cert, run_frontend.build_san(["10.0.0.9"])))

    def test_a_missing_certificate_is_not_covered(self) -> None:
        self.assertFalse(run_frontend.cert_covers(self.cert, "DNS:localhost"))


class ArgumentTest(unittest.TestCase):
    def test_plain_http_remains_the_default(self) -> None:
        args = run_frontend.parse_args([])
        self.assertFalse(args.https)
        self.assertIsNone(args.cert)

    def test_supplying_a_certificate_implies_https(self) -> None:
        # Passing a certificate and still being served plain HTTP would be a
        # silent failure: the camera stays blocked with nothing to explain it.
        args = run_frontend.parse_args(["--cert", "a.crt", "--key", "a.key"])
        self.assertTrue(args.https)

    def test_a_certificate_without_its_key_is_rejected(self) -> None:
        with self.assertRaises(SystemExit):
            run_frontend.parse_args(["--cert", "a.crt"])
        with self.assertRaises(SystemExit):
            run_frontend.parse_args(["--key", "a.key"])

    def test_the_port_can_be_moved(self) -> None:
        self.assertEqual(run_frontend.parse_args(["--port", "8443"]).port, 8443)


if __name__ == "__main__":
    unittest.main()
