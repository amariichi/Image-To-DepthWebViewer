from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from server.main import (
    ascii_safe_filename,
    build_download_headers,
    process_image,
    status,
)


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

    async def generate_rgbde(
        self,
        data: bytes,
        original_name: str,
        *,
        focal_length_35mm: float | None = None,
    ) -> _FakeDepthResult:
        self.last_call = (data, original_name, focal_length_35mm)
        return _FakeDepthResult(b"fake-png", "深度結果.png")


class _FailingDepthService:
    device_label = "cpu"

    async def generate_rgbde(
        self,
        data: bytes,
        original_name: str,
        *,
        focal_length_35mm: float | None = None,
    ) -> _FakeDepthResult:
        raise ValueError("Only JPG and PNG inputs are supported.")


class _FakeUpload:
    def __init__(self, filename: str, content: bytes) -> None:
        self.filename = filename
        self.content = content

    async def read(self) -> bytes:
        return self.content


class ApiRoutesTest(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def upload(name: str, content: bytes = b"raw-image") -> _FakeUpload:
        return _FakeUpload(name, content)

    async def test_status_endpoint_uses_lazy_service_lookup(self) -> None:
        fake_service = _FakeDepthService()
        with patch("server.main.get_depth_service", return_value=fake_service):
            response = await status()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.body), {"status": "ok", "device": "cpu"})

    async def test_process_endpoint_returns_png_and_download_headers(self) -> None:
        fake_service = _FakeDepthService()
        with patch("server.main.get_depth_service", return_value=fake_service):
            response = await process_image(self.upload("example.png"), None)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(fake_service.last_call, (b"raw-image", "example.png", None))
        self.assertEqual(response.headers["content-type"], "image/png")
        self.assertEqual(response.headers["x-rgbde-filename"], "rgbde_result.png")
        self.assertEqual(
            response.headers["x-rgbde-filename-encoded"],
            "%E6%B7%B1%E5%BA%A6%E7%B5%90%E6%9E%9C.png",
        )

    async def test_process_endpoint_maps_value_error_to_400(self) -> None:
        with patch("server.main.get_depth_service", return_value=_FailingDepthService()):
            with self.assertRaises(HTTPException) as caught:
                await process_image(self.upload("example.gif"), None)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(caught.exception.detail, "Only JPG and PNG inputs are supported.")

    async def test_process_endpoint_forwards_35mm_equivalent_focal_override(self) -> None:
        fake_service = _FakeDepthService()
        with patch("server.main.get_depth_service", return_value=fake_service):
            response = await process_image(self.upload("example.jpg"), 28.0)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(fake_service.last_call, (b"raw-image", "example.jpg", 28.0))

    async def test_process_endpoint_rejects_invalid_focal_override(self) -> None:
        fake_service = _FakeDepthService()
        with patch("server.main.get_depth_service", return_value=fake_service):
            with self.assertRaises(HTTPException) as caught:
                await process_image(self.upload("example.jpg"), 9.0)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("10 to 800", caught.exception.detail)
        self.assertFalse(hasattr(fake_service, "last_call"))
