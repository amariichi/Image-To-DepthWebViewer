from __future__ import annotations

import json
import math
import struct
import unittest
import zlib

from rgbde_metadata import (
    DEPTH_METADATA_KEYWORD,
    embed_depth_metadata_in_png_bytes,
    focal_length_pixels_from_35mm,
    make_depth_metadata,
    validate_focal_length_35mm,
)


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def make_chunk(chunk_type: bytes, data: bytes) -> bytes:
    crc = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)


def make_minimal_png() -> bytes:
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
    raw_scanline = b"\x00\xff\x00\x00\xff"
    return (
        PNG_SIGNATURE
        + make_chunk(b"IHDR", ihdr)
        + make_chunk(b"IDAT", zlib.compress(raw_scanline))
        + make_chunk(b"IEND", b"")
    )


def iter_chunks(png_bytes: bytes):
    offset = len(PNG_SIGNATURE)
    while offset < len(png_bytes):
        length = struct.unpack(">I", png_bytes[offset:offset + 4])[0]
        chunk_type = png_bytes[offset + 4:offset + 8]
        data = png_bytes[offset + 8:offset + 8 + length]
        yield chunk_type, data
        offset += 12 + length


def parse_itxt(data: bytes) -> tuple[str, dict]:
    keyword, rest = data.split(b"\x00", 1)
    # compression flag, compression method, empty language tag, empty translated keyword
    json_text = rest[4:].decode("utf-8")
    return keyword.decode("latin-1"), json.loads(json_text)


class RgbdeMetadataTest(unittest.TestCase):
    def test_35mm_equivalent_conversion_uses_the_image_diagonal(self) -> None:
        landscape = focal_length_pixels_from_35mm(400, 300, 50)
        portrait = focal_length_pixels_from_35mm(300, 400, 50)

        self.assertAlmostEqual(landscape, portrait)
        self.assertAlmostEqual(landscape, 50 * 500 / math.hypot(36, 24))

    def test_35mm_equivalent_validation_has_a_bounded_user_range(self) -> None:
        self.assertIsNone(validate_focal_length_35mm(None))
        self.assertEqual(validate_focal_length_35mm("28"), 28.0)
        for value in (0, 9.9, 800.1, math.inf, "wide"):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "10 to 800"):
                    validate_focal_length_35mm(value)

    def test_make_depth_metadata_adds_fov_from_prediction_focal_length(self) -> None:
        metadata = make_depth_metadata("source.png", 400, 200, 500.0, 1000.0)

        self.assertEqual(metadata["source_file"], "source.png")
        self.assertEqual(metadata["input_focal_length_px"], 500.0)
        self.assertEqual(metadata["focallength_px"], 1000.0)
        self.assertAlmostEqual(
            metadata["horizontal_fov_deg"],
            math.degrees(2.0 * math.atan(400 / 2000.0)),
        )
        self.assertAlmostEqual(
            metadata["vertical_fov_deg"],
            math.degrees(2.0 * math.atan(200 / 2000.0)),
        )

    def test_embed_depth_metadata_in_png_bytes_inserts_itxt_after_ihdr(self) -> None:
        metadata = make_depth_metadata("source.png", 400, 200, None, 1000.0)
        png_bytes = embed_depth_metadata_in_png_bytes(make_minimal_png(), metadata)
        chunks = list(iter_chunks(png_bytes))

        self.assertEqual(chunks[0][0], b"IHDR")
        self.assertEqual(chunks[1][0], b"iTXt")
        keyword, payload = parse_itxt(chunks[1][1])
        self.assertEqual(keyword, DEPTH_METADATA_KEYWORD)
        self.assertEqual(payload["source_file"], "source.png")
        self.assertEqual(payload["focallength_px"], 1000.0)


if __name__ == "__main__":
    unittest.main()
