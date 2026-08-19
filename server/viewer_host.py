"""Same-origin frontend host and in-memory mobile scene relay."""

from __future__ import annotations

import json
import math
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles


PROJECT_ROOT = Path(__file__).resolve().parents[1]
WEBAPP_DIR = PROJECT_ROOT / "webapp"
DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024

_ALLOWED_MANIFEST_FIELDS = {
    "schemaVersion",
    "sourceName",
    "publishedAt",
    "frontOffset",
    "screenOccupancy",
    "baselineEyeZ",
    "depthSpan",
    "disparityBlend",
    "captureFovDeg",
}


@dataclass(frozen=True)
class PublishedScene:
    revision: int
    filename: str
    model: bytes
    manifest: dict[str, Any]
    # An optional smaller build of the same scene. A constrained browser cannot
    # be asked in advance how much memory it has, so it asks for this one only
    # after the full build has actually failed to load.
    reduced_model: bytes | None = None

    def variant(self, name: str) -> bytes:
        if name == "reduced" and self.reduced_model is not None:
            return self.reduced_model
        return self.model

    def has_variant(self, name: str) -> bool:
        return name != "reduced" or self.reduced_model is not None


class SceneStore:
    """Thread-safe storage for the most recently published mobile scene."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._revision = 0
        self._scene: PublishedScene | None = None

    def publish(
        self,
        filename: str,
        model: bytes,
        manifest: dict[str, Any],
        reduced_model: bytes | None = None,
    ) -> PublishedScene:
        with self._lock:
            self._revision += 1
            self._scene = PublishedScene(
                revision=self._revision,
                filename=filename,
                model=bytes(model),
                manifest=dict(manifest),
                reduced_model=bytes(reduced_model) if reduced_model else None,
            )
            return self._scene

    def current(self) -> PublishedScene | None:
        with self._lock:
            return self._scene

    def clear(self) -> None:
        with self._lock:
            self._scene = None


def _finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be a finite number")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{field} must be a finite number")
    return number


def validate_manifest(raw_manifest: str) -> dict[str, Any]:
    try:
        manifest = json.loads(raw_manifest)
    except json.JSONDecodeError as exc:
        raise ValueError("manifest must be valid JSON") from exc

    if not isinstance(manifest, dict):
        raise ValueError("manifest must be a JSON object")

    unexpected = sorted(set(manifest) - _ALLOWED_MANIFEST_FIELDS)
    if unexpected:
        raise ValueError(f"manifest contains unsupported fields: {', '.join(unexpected)}")
    if manifest.get("schemaVersion") != 1:
        raise ValueError("manifest.schemaVersion must be 1")

    for field in ("sourceName", "publishedAt"):
        value = manifest.get(field)
        if value is not None and (not isinstance(value, str) or not value.strip()):
            raise ValueError(f"manifest.{field} must be a non-empty string")

    if "frontOffset" in manifest:
        front_offset = _finite_number(manifest["frontOffset"], "manifest.frontOffset")
        if not -1.0 <= front_offset <= 1.0:
            raise ValueError("manifest.frontOffset must be between -1 and 1")
        manifest["frontOffset"] = front_offset

    if "screenOccupancy" in manifest:
        occupancy = _finite_number(manifest["screenOccupancy"], "manifest.screenOccupancy")
        if not 0.0 < occupancy <= 1.0:
            raise ValueError("manifest.screenOccupancy must be greater than 0 and at most 1")
        manifest["screenOccupancy"] = occupancy

    if "baselineEyeZ" in manifest:
        baseline_eye_z = _finite_number(manifest["baselineEyeZ"], "manifest.baselineEyeZ")
        if not 0.1 <= baseline_eye_z <= 10.0:
            raise ValueError("manifest.baselineEyeZ must be between 0.1 and 10")
        manifest["baselineEyeZ"] = baseline_eye_z

    if "depthSpan" in manifest:
        depth_span = _finite_number(manifest["depthSpan"], "manifest.depthSpan")
        # One world unit is half the virtual screen height. A monocular
        # head-tracked display has no vergence/accommodation conflict, so it can
        # carry far more depth than a stereo display; the ceiling only has to
        # stop a value that would break the projection.
        if not 0.0 < depth_span <= 8.0:
            raise ValueError("manifest.depthSpan must be greater than 0 and at most 8")
        manifest["depthSpan"] = depth_span

    if "disparityBlend" in manifest:
        blend = _finite_number(manifest["disparityBlend"], "manifest.disparityBlend")
        if not 0.0 <= blend <= 1.0:
            raise ValueError("manifest.disparityBlend must be between 0 and 1")
        manifest["disparityBlend"] = blend

    if manifest.get("captureFovDeg") is not None:
        capture_fov = _finite_number(manifest["captureFovDeg"], "manifest.captureFovDeg")
        if not 1.0 <= capture_fov <= 179.0:
            raise ValueError("manifest.captureFovDeg must be between 1 and 179")
        manifest["captureFovDeg"] = capture_fov

    return manifest


def _safe_filename(filename: str | None) -> str:
    candidate = Path(filename or "scene.glb").name.strip()
    candidate = "".join(character for character in candidate if ord(character) >= 32)
    return candidate or "scene.glb"


def create_app(
    webapp_dir: Path = WEBAPP_DIR,
    *,
    max_upload_bytes: int = DEFAULT_MAX_UPLOAD_BYTES,
) -> FastAPI:
    app = FastAPI(title="Image-To-Depth mobile viewer host")
    store = SceneStore()
    app.state.scene_store = store

    @app.post("/viewer-api/scene")
    async def publish_scene(
        model: UploadFile = File(...),
        manifest: str = Form(...),
        model_reduced: UploadFile | None = File(default=None, alias="modelReduced"),
    ) -> dict[str, Any]:
        try:
            parsed_manifest = validate_manifest(manifest)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        model_bytes = await model.read(max_upload_bytes + 1)
        if not model_bytes:
            raise HTTPException(status_code=400, detail="model must not be empty")
        if len(model_bytes) > max_upload_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"model exceeds the {max_upload_bytes}-byte upload limit",
            )

        reduced_bytes: bytes | None = None
        if model_reduced is not None:
            reduced_bytes = await model_reduced.read(max_upload_bytes + 1)
            if not reduced_bytes:
                reduced_bytes = None
            elif len(reduced_bytes) > max_upload_bytes:
                raise HTTPException(
                    status_code=413,
                    detail=f"modelReduced exceeds the {max_upload_bytes}-byte upload limit",
                )

        scene = store.publish(
            _safe_filename(model.filename),
            model_bytes,
            parsed_manifest,
            reduced_bytes,
        )
        return {
            "revision": scene.revision,
            "filename": scene.filename,
            "hasReduced": scene.reduced_model is not None,
        }

    @app.get("/viewer-api/scene/manifest")
    async def get_scene_manifest() -> dict[str, Any]:
        scene = store.current()
        if scene is None:
            return {"available": False, "revision": 0}
        return {
            "available": True,
            "revision": scene.revision,
            "filename": scene.filename,
            "manifest": dict(scene.manifest),
            "hasReduced": scene.reduced_model is not None,
        }

    @app.get("/viewer-api/scene/model")
    async def get_scene_model(request: Request) -> Response:
        scene = store.current()
        if scene is None:
            raise HTTPException(status_code=404, detail="no mobile scene has been published")

        requested = request.query_params.get("variant", "full")
        if requested not in {"full", "reduced"}:
            raise HTTPException(status_code=400, detail="variant must be full or reduced")
        served = requested if scene.has_variant(requested) else "full"
        payload = scene.variant(served)

        etag = f'"scene-{scene.revision}-{served}"'
        headers = {
            "ETag": etag,
            "X-Scene-Revision": str(scene.revision),
            "X-Scene-Variant": served,
            "Cache-Control": "no-cache",
            "Content-Disposition": f'inline; filename="{scene.filename}"',
        }
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers=headers)
        return Response(content=payload, media_type="model/gltf-binary", headers=headers)

    @app.delete("/viewer-api/scene")
    async def clear_scene() -> dict[str, bool]:
        store.clear()
        return {"cleared": True}

    @app.middleware("http")
    async def revalidate_static_assets(request: Request, call_next):
        """Stop the browser reusing stale copies of the frontend modules.

        This is a local development host, and the frontend is a set of native ES
        modules that import each other by name. A browser that keeps one of them
        while fetching another can end up linking a fresh module against a stale
        one, which fails at link time and silently leaves the whole page without
        any event listeners: buttons simply stop responding, with no visible
        error unless the console is open. Requiring revalidation costs one
        conditional request per file and removes that failure mode entirely.

        The scene endpoints set their own cache headers and are left alone.
        """
        response = await call_next(request)
        if not request.url.path.startswith("/viewer-api/"):
            response.headers.setdefault("Cache-Control", "no-cache")
        return response

    # API routes must be registered before this catch-all static mount.
    app.mount("/", StaticFiles(directory=str(webapp_dir), html=True), name="webapp")
    return app


app = create_app()
