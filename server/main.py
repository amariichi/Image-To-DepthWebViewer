from __future__ import annotations

import io
import logging
import unicodedata
from pathlib import Path
from typing import TYPE_CHECKING, Annotated
from urllib.parse import quote

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

if TYPE_CHECKING:
    from .depth_service import DepthProService

logger = logging.getLogger(__name__)

def read_app_version() -> str:
    version_path = Path(__file__).resolve().parents[1] / "VERSION"
    try:
        return version_path.read_text(encoding="utf-8").strip() or "0.0.0"
    except OSError:
        return "0.0.0"


app = FastAPI(title="RGBDE Depth Service", version=read_app_version())

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-RGBDE-Filename", "X-RGBDE-Filename-Encoded"],
)


@app.on_event("startup")
async def preload_model() -> None:
    service = get_depth_service()
    logger.info("Depth Pro model initialised on %s", service.device_label)


@app.get("/api/status")
async def status() -> JSONResponse:
    service = get_depth_service()
    return JSONResponse({"status": "ok", "device": service.device_label})


@app.post("/api/process")
async def process_image(image: Annotated[UploadFile, File(...)]) -> StreamingResponse:
    service = get_depth_service()
    content = await image.read()
    if not content:
        raise HTTPException(status_code=400, detail="No image payload received.")

    try:
        result = await service.generate_rgbde(content, image.filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - defensive logging
        logger.exception("Depth generation failed")
        raise HTTPException(status_code=500, detail="Depth generation failed.") from exc

    stream = io.BytesIO(result.png_bytes)
    headers = build_download_headers(result.filename)
    return StreamingResponse(stream, media_type="image/png", headers=headers)


def build_download_headers(filename: str) -> dict[str, str]:
    fallback = ascii_safe_filename(filename)
    encoded = quote(filename, safe="")
    disposition = (
        f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"
    )
    headers: dict[str, str] = {
        "Content-Disposition": disposition,
        "X-RGBDE-Filename": fallback,
    }
    if fallback != filename:
        headers["X-RGBDE-Filename-Encoded"] = encoded
    return headers


def ascii_safe_filename(name: str) -> str:
    raw_name = (name or '').replace('\\', '/').split('/')[-1].strip()
    path = Path(raw_name)
    normalized_stem = unicodedata.normalize('NFKD', path.stem)
    ascii_stem = normalized_stem.encode('ascii', 'ignore').decode('ascii', 'ignore')
    stem = ascii_stem.replace('"', '').replace("'", '').strip()
    stem = stem.replace('/', '_').replace('\\', '_')
    stem = stem.strip('._ ') or 'rgbde_result'
    suffix = path.suffix.lower()
    if suffix != '.png':
        suffix = '.png'
    return f"{stem}{suffix}"


def get_depth_service() -> "DepthProService":
    from .depth_service import get_depth_service as _get_depth_service

    return _get_depth_service()
