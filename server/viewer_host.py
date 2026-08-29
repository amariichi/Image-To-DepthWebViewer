"""Same-origin frontend host and in-memory mobile scene relay."""

from __future__ import annotations

import json
import math
import os
import threading
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles


PROJECT_ROOT = Path(__file__).resolve().parents[1]
WEBAPP_DIR = PROJECT_ROOT / "webapp"
DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024

# Set by the phone on its own depth requests. The editor posts to the same
# endpoint through the same proxy, so without a marker the slot below would
# offer the desktop back whatever it had just made itself.
MOBILE_ORIGIN_HEADER = "x-rgbde-origin"
MOBILE_ORIGIN_VALUE = "mobile"

# Headers that describe one hop of a connection rather than the message, and so
# must not be passed along to the next one.
_HOP_BY_HOP_HEADERS = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
})


def default_backend_origin() -> str:
    """Where the depth backend is, as this host should reach it.

    127.0.0.1 rather than localhost: the name can resolve to the IPv6 loopback
    first, and the backend binds IPv4.
    """
    origin = os.environ.get("RGBDE_BACKEND_ORIGIN")
    if origin:
        return origin.rstrip("/")
    return f"http://127.0.0.1:{os.environ.get('RGBDE_BACKEND_PORT', '8000')}"


def forwardable_headers(headers, *, drop: frozenset[str] = frozenset()) -> dict[str, str]:
    unwanted = _HOP_BY_HOP_HEADERS | drop
    return {
        key: value for key, value in headers.items() if key.lower() not in unwanted
    }

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


@dataclass(frozen=True)
class MobileSource:
    revision: int
    filename: str
    media_type: str
    content: bytes
    focal_length_35mm: float | None
    created_at: float


class MobileSourceStore:
    """The RGBDE most recently generated for the phone, kept for the editor.

    Depth inference already runs on this machine, so the result passes through
    this process on its way to the phone. Keeping a copy here costs nothing on
    the link the phone is paying for, and lets the editor open the same scene
    without the phone uploading bytes this machine produced.

    Deliberately a pull: nothing is pushed at the editor, so a scene being
    worked on there is never replaced by someone using the phone next door.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._revision = 0
        self._source: MobileSource | None = None

    def capture(
        self,
        filename: str,
        media_type: str,
        content: bytes,
        focal_length_35mm: float | None = None,
    ) -> MobileSource:
        with self._lock:
            self._revision += 1
            self._source = MobileSource(
                revision=self._revision,
                filename=filename,
                media_type=media_type,
                content=bytes(content),
                focal_length_35mm=focal_length_35mm,
                created_at=time.time(),
            )
            return self._source

    def current(self) -> MobileSource | None:
        with self._lock:
            return self._source

    def clear(self) -> None:
        with self._lock:
            self._source = None


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
        # The span is a proportion of the fitted picture's height. Bounding the
        # relief at all is a choice, so the ceiling only has to stop a value
        # that would break the projection.
        if not 0.0 < depth_span <= 40.0:
            raise ValueError("manifest.depthSpan must be greater than 0 and at most 40")
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


def _rgbde_filename(headers, fallback: str = "mobile_RGBDE.png") -> str:
    """The name the backend gave its RGBDE, preferring the encoded header."""

    encoded = headers.get("x-rgbde-filename-encoded")
    if encoded:
        try:
            decoded = urllib.parse.unquote(encoded)
        except (UnicodeDecodeError, ValueError):
            decoded = ""
        if decoded.strip():
            return _safe_filename(decoded)
    plain = headers.get("x-rgbde-filename")
    return _safe_filename(plain) if plain and plain.strip() else fallback


def _requested_focal(query_params) -> float | None:
    raw = query_params.get("focal_length_35mm")
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _safe_filename(filename: str | None) -> str:
    candidate = Path(filename or "scene.glb").name.strip()
    candidate = "".join(character for character in candidate if ord(character) >= 32)
    return candidate or "scene.glb"


def create_app(
    webapp_dir: Path = WEBAPP_DIR,
    *,
    max_upload_bytes: int = DEFAULT_MAX_UPLOAD_BYTES,
    backend_origin: str | None = None,
) -> FastAPI:
    app = FastAPI(title="Image-To-Depth mobile viewer host")
    store = SceneStore()
    app.state.scene_store = store
    mobile_sources = MobileSourceStore()
    app.state.mobile_source_store = mobile_sources
    app.state.backend_origin = (backend_origin or default_backend_origin()).rstrip("/")
    # Substituted in tests so the proxy can be exercised without a backend.
    app.state.backend_transport = None

    @app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
    async def proxy_to_backend(path: str, request: Request) -> Response:
        """Reach the depth backend through the origin the page came from.

        The editor used to call the backend directly at http://localhost:8000.
        From a page served over HTTPS that is a cross-origin plain-text
        request, and whether it is allowed is a browser policy decision rather
        than anything this project controls: Chrome permits it because
        localhost counts as a trustworthy origin, and Safari does not. Going
        through this origin removes the question, along with the CORS case.
        """
        body = await request.body()
        # No read timeout: depth inference on a CPU takes far longer than any
        # default would allow. The connect timeout stays short so a backend
        # that is not running is reported quickly instead of appearing to hang.
        options: dict[str, Any] = {
            "timeout": httpx.Timeout(5.0, read=None, write=None, pool=None),
        }
        if app.state.backend_transport is not None:
            options["transport"] = app.state.backend_transport

        try:
            async with httpx.AsyncClient(**options) as client:
                upstream = await client.request(
                    request.method,
                    f"{app.state.backend_origin}/api/{path}",
                    params=request.query_params,
                    headers=forwardable_headers(
                        request.headers, drop=frozenset({"host", "content-length"})
                    ),
                    content=body,
                )
        except httpx.ConnectError:
            raise HTTPException(
                status_code=502,
                detail=(
                    f"The depth backend is not reachable at {app.state.backend_origin}. "
                    "Start it with scripts/run.py, or scripts/run_backend.py on its own."
                ),
            ) from None
        except httpx.HTTPError as error:
            raise HTTPException(
                status_code=502, detail=f"The depth backend could not be reached: {error}"
            ) from None

        # The depth this machine just computed is already here, in full, on its
        # way to the phone. Keeping a copy costs the phone nothing and saves it
        # uploading the same bytes back over a metered connection.
        if (
            request.method == "POST"
            and path == "process"
            and upstream.status_code == 200
            and request.headers.get(MOBILE_ORIGIN_HEADER, "").lower() == MOBILE_ORIGIN_VALUE
            and upstream.headers.get("content-type", "").lower().startswith("image/png")
            and 0 < len(upstream.content) <= max_upload_bytes
        ):
            mobile_sources.capture(
                filename=_rgbde_filename(upstream.headers),
                media_type="image/png",
                content=upstream.content,
                focal_length_35mm=_requested_focal(request.query_params),
            )

        # httpx has already decoded the body, so a surviving Content-Encoding
        # would describe the response as compressed when it no longer is.
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            headers=forwardable_headers(
                upstream.headers,
                drop=frozenset({"content-length", "content-encoding"}),
            ),
        )

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

    @app.get("/viewer-api/mobile-source")
    async def get_mobile_source_status() -> dict[str, Any]:
        source = mobile_sources.current()
        if source is None:
            return {"available": False, "revision": 0}
        return {
            "available": True,
            "revision": source.revision,
            "filename": source.filename,
            "focalLength35mm": source.focal_length_35mm,
            "createdAt": source.created_at,
            "byteLength": len(source.content),
        }

    @app.get("/viewer-api/mobile-source/image")
    async def get_mobile_source_image(request: Request) -> Response:
        source = mobile_sources.current()
        if source is None:
            raise HTTPException(
                status_code=404, detail="no image has been generated for the phone yet"
            )
        etag = f'"mobile-source-{source.revision}"'
        headers = {
            "ETag": etag,
            "X-Mobile-Source-Revision": str(source.revision),
            "Cache-Control": "no-cache",
            "Content-Disposition": f'inline; filename="{source.filename}"',
        }
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers=headers)
        return Response(content=source.content, media_type=source.media_type, headers=headers)

    @app.delete("/viewer-api/mobile-source")
    async def clear_mobile_source() -> dict[str, bool]:
        mobile_sources.clear()
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

        The scene endpoints and the proxied backend set their own cache
        headers and are left alone.
        """
        response = await call_next(request)
        path = request.url.path
        if not path.startswith("/viewer-api/") and not path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-cache")
        return response

    # API routes must be registered before this catch-all static mount.
    app.mount("/", StaticFiles(directory=str(webapp_dir), html=True), name="webapp")
    return app


app = create_app()
