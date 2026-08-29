from __future__ import annotations

import json
import math
import struct
import zlib
from pathlib import Path
from typing import Any


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
DEPTH_METADATA_KEYWORD = "LookingGlassGoDepthMetadata"
MIN_FOCAL_LENGTH_35MM = 10.0
MAX_FOCAL_LENGTH_35MM = 800.0
FULL_FRAME_DIAGONAL_MM = math.hypot(36.0, 24.0)


def validate_focal_length_35mm(value: Any) -> float | None:
    """Return a usable 35 mm-equivalent focal length or reject the request."""

    if value is None:
        return None
    try:
        focal = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("Focal length must be from 10 to 800 mm (35 mm equivalent).") from exc
    if not math.isfinite(focal) or not MIN_FOCAL_LENGTH_35MM <= focal <= MAX_FOCAL_LENGTH_35MM:
        raise ValueError("Focal length must be from 10 to 800 mm (35 mm equivalent).")
    return focal


def focal_length_pixels_from_35mm(width: int, height: int, focal_length_35mm: Any) -> float:
    """Convert a 35 mm-equivalent lens to pixels using the image diagonal."""

    if not isinstance(width, int) or not isinstance(height, int) or width < 1 or height < 1:
        raise ValueError("Image dimensions must be positive integers.")
    focal = validate_focal_length_35mm(focal_length_35mm)
    if focal is None:
        raise ValueError("A focal length is required for conversion.")
    return focal * math.hypot(width, height) / FULL_FRAME_DIAGONAL_MM


def tensor_to_float(value: Any) -> float | None:
    if value is None:
        return None
    if hasattr(value, "detach"):
        value = value.detach().cpu()
    if hasattr(value, "item"):
        return float(value.item())
    if hasattr(value, "reshape") and hasattr(value, "size"):
        if value.size == 0:
            return None
        return float(value.reshape(-1)[0])
    if isinstance(value, (list, tuple)):
        if not value:
            return None
        return tensor_to_float(value[0])

    return float(value)


def make_depth_metadata(
    source_file: str,
    width: int,
    height: int,
    input_focal_length_px: float | None,
    prediction_focal_length_px: float | None,
) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "source_file": source_file,
        "width": int(width),
        "height": int(height),
        "input_focal_length_px": input_focal_length_px,
        "focallength_px": prediction_focal_length_px,
    }

    if prediction_focal_length_px is not None and prediction_focal_length_px > 0:
        focal = float(prediction_focal_length_px)
        metadata["horizontal_fov_deg"] = math.degrees(2.0 * math.atan(width / (2.0 * focal)))
        metadata["vertical_fov_deg"] = math.degrees(2.0 * math.atan(height / (2.0 * focal)))

    return metadata


def embed_depth_metadata_in_png(path: str | Path, metadata: dict[str, Any]) -> None:
    png_path = Path(path)
    png_path.write_bytes(embed_depth_metadata_in_png_bytes(png_path.read_bytes(), metadata))


def embed_depth_metadata_in_png_bytes(png_bytes: bytes, metadata: dict[str, Any]) -> bytes:
    if not png_bytes.startswith(PNG_SIGNATURE):
        raise ValueError("Not a PNG file.")

    first_chunk_offset = len(PNG_SIGNATURE)
    if png_bytes[first_chunk_offset + 4:first_chunk_offset + 8] != b"IHDR":
        raise ValueError("PNG IHDR chunk not found.")

    ihdr_length = struct.unpack(">I", png_bytes[first_chunk_offset:first_chunk_offset + 4])[0]
    insert_offset = first_chunk_offset + 12 + ihdr_length
    metadata_text = json.dumps(metadata, ensure_ascii=False, separators=(",", ":"))
    itxt_chunk = make_itxt_chunk(DEPTH_METADATA_KEYWORD, metadata_text)
    return png_bytes[:insert_offset] + itxt_chunk + png_bytes[insert_offset:]


def make_itxt_chunk(keyword: str, text: str) -> bytes:
    keyword_bytes = keyword.encode("latin-1")
    text_bytes = text.encode("utf-8")
    if not keyword_bytes or len(keyword_bytes) > 79 or b"\x00" in keyword_bytes:
        raise ValueError(f"Invalid PNG iTXt keyword: {keyword}")

    data = keyword_bytes + b"\x00\x00\x00\x00\x00" + text_bytes
    chunk_type = b"iTXt"
    crc = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)
