from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from server.main import app, ascii_safe_filename, build_download_headers


class FilenameHelpersTest(unittest.TestCase):
    def test_ascii_safe_filename_normalizes_unicode_and_extension(self) -> None:
        result = ascii_safe_filename(" こんにちは/Depth\"Shot\".JPG ")
        self.assertEqual(result, "DepthShot.png")

    def test_ascii_safe_filename_falls_back_for_empty_stem(self) -> None:
        result = ascii_safe_filename("...")
        self.assertEqual(result, "rgbde_result.png")

    def test_build_download_headers_adds_encoded_name_when_needed(self) -> None:
        headers = build_download_headers("深度結果.png")
        self.assertEqual(headers["X-RGBDE-Filename"], "rgbde_result.png")
        self.assertIn("filename*=UTF-8''%E6%B7%B1%E5%BA%A6%E7%B5%90%E6%9E%9C.png", headers["Content-Disposition"])
        self.assertEqual(headers["X-RGBDE-Filename-Encoded"], "%E6%B7%B1%E5%BA%A6%E7%B5%90%E6%9E%9C.png")


class _FakeDepthResult:
    def __init__(self, png_bytes: bytes, filename: str) -> None:
        self.png_bytes = png_bytes
        self.filename = filename


class _FakeDepthService:
    device_label = "cpu"

    async def generate_rgbde(self, data: bytes, original_name: str) -> _FakeDepthResult:
        self.last_call = (data, original_name)
        return _FakeDepthResult(b"fake-png", "深度結果.png")


class _FailingDepthService:
    device_label = "cpu"

    async def generate_rgbde(self, data: bytes, original_name: str) -> _FakeDepthResult:
        raise ValueError("Only JPG and PNG inputs are supported.")


class ApiRoutesTest(unittest.TestCase):
    def test_status_endpoint_uses_lazy_service_lookup(self) -> None:
        fake_service = _FakeDepthService()
        with patch("server.main.get_depth_service", return_value=fake_service):
            with TestClient(app) as client:
                response = client.get("/api/status")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok", "device": "cpu"})

    def test_process_endpoint_returns_png_and_download_headers(self) -> None:
        fake_service = _FakeDepthService()
        with patch("server.main.get_depth_service", return_value=fake_service):
            with TestClient(app) as client:
                response = client.post(
                    "/api/process",
                    files={"image": ("example.png", b"raw-image", "image/png")},
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"fake-png")
        self.assertEqual(fake_service.last_call, (b"raw-image", "example.png"))
        self.assertEqual(response.headers["content-type"], "image/png")
        self.assertEqual(response.headers["x-rgbde-filename"], "rgbde_result.png")
        self.assertEqual(
            response.headers["x-rgbde-filename-encoded"],
            "%E6%B7%B1%E5%BA%A6%E7%B5%90%E6%9E%9C.png",
        )

    def test_process_endpoint_maps_value_error_to_400(self) -> None:
        with patch("server.main.get_depth_service", return_value=_FailingDepthService()):
            with TestClient(app) as client:
                response = client.post(
                    "/api/process",
                    files={"image": ("example.gif", b"raw-image", "image/gif")},
                )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"detail": "Only JPG and PNG inputs are supported."})
