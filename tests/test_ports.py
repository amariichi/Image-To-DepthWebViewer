from __future__ import annotations

import importlib.util
import os
import shutil
import socket
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("ports", PROJECT_ROOT / "scripts" / "ports.py")
ports = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ports)

SS_OUTPUT = """State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      2048         0.0.0.0:15173      0.0.0.0:*    users:(("other",pid=1111,fd=9))
LISTEN 0      2048         0.0.0.0:5173       0.0.0.0:*    users:(("python3",pid=3437548,fd=13))
LISTEN 0      4096            [::]:8000          [::]:*    users:(("python3",pid=2222,fd=7))
LISTEN 0      4096       127.0.0.1:631        0.0.0.0:*
"""


class ParseListenersTest(unittest.TestCase):
    def test_a_port_is_not_found_inside_a_longer_one(self) -> None:
        # Searching the line as text finds 5173 inside 15173 and names a
        # process that has nothing to do with the port that is busy.
        listeners = ports.parse_listeners(SS_OUTPUT)
        self.assertEqual(listeners[5173], 3437548)
        self.assertEqual(listeners[15173], 1111)

    def test_an_ipv6_listener_is_read(self) -> None:
        self.assertEqual(ports.parse_listeners(SS_OUTPUT)[8000], 2222)

    def test_rows_without_a_process_are_skipped(self) -> None:
        # A listener owned by another account shows no pid.
        self.assertNotIn(631, ports.parse_listeners(SS_OUTPUT))

    def test_the_header_row_is_not_mistaken_for_a_listener(self) -> None:
        self.assertEqual(ports.parse_listeners(SS_OUTPUT).keys(), {15173, 5173, 8000})

    def test_no_listeners_at_all(self) -> None:
        self.assertEqual(ports.parse_listeners(""), {})


class PortIsFreeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.listener.bind(("0.0.0.0", 0))
        self.listener.listen(1)
        self.port = self.listener.getsockname()[1]

    def tearDown(self) -> None:
        self.listener.close()

    def test_a_port_with_a_live_listener_is_not_free(self) -> None:
        self.assertFalse(ports.port_is_free(self.port))

    def test_the_port_is_free_once_the_listener_closes(self) -> None:
        # SO_REUSEADDR is set, matching uvicorn, so a port left in TIME_WAIT by
        # a stopped server reads as free -- which it is.
        self.listener.close()
        self.assertTrue(ports.port_is_free(self.port))

    def test_probing_does_not_leave_the_port_taken(self) -> None:
        self.listener.close()
        self.assertTrue(ports.port_is_free(self.port))
        self.assertTrue(ports.port_is_free(self.port))


class RequireFreePortTest(unittest.TestCase):
    def setUp(self) -> None:
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.listener.bind(("0.0.0.0", 0))
        self.listener.listen(1)
        self.port = self.listener.getsockname()[1]

    def tearDown(self) -> None:
        self.listener.close()

    def test_a_free_port_passes_quietly(self) -> None:
        self.listener.close()
        self.assertIsNone(ports.require_free_port(self.port, "frontend"))

    @unittest.skipUnless(shutil.which("ss"), "ss is needed to identify the holder")
    def test_a_busy_port_stops_the_run_and_names_the_holder(self) -> None:
        # The whole point: the failure has to carry enough to act on, since the
        # holder is nearly always an earlier instance of the same server.
        with self.assertRaises(SystemExit) as raised:
            ports.require_free_port(self.port, "frontend")
        message = str(raised.exception)
        self.assertIn(str(self.port), message)
        self.assertIn("frontend", message)
        self.assertIn(str(os.getpid()), message)
        self.assertIn(f"kill {os.getpid()}", message)

    def test_an_unidentifiable_holder_still_reports_the_port(self) -> None:
        original = ports.find_port_holder
        ports.find_port_holder = lambda port: None
        try:
            message = ports.describe_busy_port(self.port, "frontend")
        finally:
            ports.find_port_holder = original
        self.assertIn(str(self.port), message)
        self.assertIn("could not be identified", message)


if __name__ == "__main__":
    unittest.main()
