from __future__ import annotations

import json
import os
import unittest

import httpx
from fastapi.testclient import TestClient

from server.viewer_host import WEBAPP_DIR, create_app, default_backend_origin


def manifest(**overrides):
    payload = {
        "schemaVersion": 1,
        "sourceName": "fixture_RGBDE.png",
        "publishedAt": "2026-08-17T00:00:00.000Z",
        "frontOffset": 0,
        "screenOccupancy": 0.92,
        "depthSpan": 0.25,
    }
    payload.update(overrides)
    return json.dumps(payload)


class ViewerHostApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(create_app(WEBAPP_DIR))

    def tearDown(self) -> None:
        self.client.close()

    def publish(self, model: bytes = b"dummy-glb", filename: str = "fixture.glb"):
        return self.client.post(
            "/viewer-api/scene",
            files={"model": (filename, model, "model/gltf-binary")},
            data={"manifest": manifest()},
        )

    def test_no_current_scene_has_stable_manifest_and_404_model(self) -> None:
        response = self.client.get("/viewer-api/scene/manifest")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"available": False, "revision": 0})
        self.assertEqual(self.client.get("/viewer-api/scene/model").status_code, 404)

    def test_publish_and_fetch_returns_exact_model_and_manifest(self) -> None:
        model = b"\x67\x6c\x54\x46\x02\x00\x00\x00"
        published = self.publish(model=model, filename="scene.glb")
        self.assertEqual(published.status_code, 200)
        self.assertEqual(published.json(), {"revision": 1, "filename": "scene.glb", "hasReduced": False})

        scene_manifest = self.client.get("/viewer-api/scene/manifest")
        self.assertEqual(scene_manifest.status_code, 200)
        self.assertEqual(scene_manifest.json()["manifest"]["screenOccupancy"], 0.92)
        self.assertEqual(scene_manifest.json()["manifest"]["depthSpan"], 0.25)
        self.assertEqual(scene_manifest.json()["revision"], 1)

        fetched = self.client.get("/viewer-api/scene/model")
        self.assertEqual(fetched.status_code, 200)
        self.assertEqual(fetched.content, model)
        self.assertEqual(fetched.headers["content-type"], "model/gltf-binary")
        self.assertEqual(fetched.headers["etag"], '"scene-1-full"')
        self.assertEqual(fetched.headers["x-scene-revision"], "1")

        not_modified = self.client.get(
            "/viewer-api/scene/model",
            headers={"If-None-Match": fetched.headers["etag"]},
        )
        self.assertEqual(not_modified.status_code, 304)
        self.assertEqual(not_modified.content, b"")

    def test_republish_replaces_bytes_and_increments_revision(self) -> None:
        self.assertEqual(self.publish(model=b"first").json()["revision"], 1)
        self.assertEqual(self.publish(model=b"second").json()["revision"], 2)
        self.assertEqual(self.client.get("/viewer-api/scene/model").content, b"second")

    def test_malformed_or_sensitive_manifest_fields_are_rejected(self) -> None:
        invalid_manifests = [
            "not-json",
            json.dumps([]),
            json.dumps({"schemaVersion": 2}),
            manifest(screenOccupancy=0),
            manifest(depthSpan=0),
            # A monocular head-tracked display has no vergence/accommodation
            # conflict, so it can carry far more depth than a stereo display.
            manifest(depthSpan=40.01),
            manifest(disparityBlend=-0.1),
            manifest(disparityBlend=1.1),
            manifest(captureFovDeg=0),
            manifest(captureFovDeg=180),
            manifest(faceLandmarks=[]),
        ]
        for raw_manifest in invalid_manifests:
            with self.subTest(raw_manifest=raw_manifest):
                response = self.client.post(
                    "/viewer-api/scene",
                    files={"model": ("scene.glb", b"model", "model/gltf-binary")},
                    data={"manifest": raw_manifest},
                )
                self.assertEqual(response.status_code, 400)

    def test_presentation_fields_within_range_are_accepted(self) -> None:
        response = self.client.post(
            "/viewer-api/scene",
            files={"model": ("scene.glb", b"model", "model/gltf-binary")},
            data={"manifest": manifest(depthSpan=40.0, disparityBlend=0.5, captureFovDeg=62.5)},
        )
        self.assertEqual(response.status_code, 200)
        stored = self.client.get("/viewer-api/scene/manifest").json()["manifest"]
        self.assertEqual(stored["depthSpan"], 40.0)
        self.assertEqual(stored["disparityBlend"], 0.5)
        self.assertEqual(stored["captureFovDeg"], 62.5)

    def test_reduced_variant_is_served_only_when_it_was_published(self) -> None:
        # A constrained browser cannot be asked how much memory it has, so it
        # falls back to the smaller build only after a real load failure.
        self.client.post(
            "/viewer-api/scene",
            files={"model": ("scene.glb", b"full-model", "model/gltf-binary")},
            data={"manifest": manifest()},
        )
        self.assertFalse(self.client.get("/viewer-api/scene/manifest").json()["hasReduced"])
        only_full = self.client.get("/viewer-api/scene/model", params={"variant": "reduced"})
        self.assertEqual(only_full.content, b"full-model")
        self.assertEqual(only_full.headers["x-scene-variant"], "full")

        published = self.client.post(
            "/viewer-api/scene",
            files={
                "model": ("scene.glb", b"full-model", "model/gltf-binary"),
                "modelReduced": ("scene.glb", b"small-model", "model/gltf-binary"),
            },
            data={"manifest": manifest()},
        )
        self.assertTrue(published.json()["hasReduced"])
        self.assertTrue(self.client.get("/viewer-api/scene/manifest").json()["hasReduced"])

        reduced = self.client.get("/viewer-api/scene/model", params={"variant": "reduced"})
        self.assertEqual(reduced.content, b"small-model")
        self.assertEqual(reduced.headers["x-scene-variant"], "reduced")
        self.assertEqual(reduced.headers["x-scene-revision"], "2")

        full = self.client.get("/viewer-api/scene/model")
        self.assertEqual(full.content, b"full-model")
        self.assertEqual(full.headers["x-scene-variant"], "full")

        # The two variants must never share a cache identity.
        self.assertNotEqual(reduced.headers["etag"], full.headers["etag"])

        rejected = self.client.get("/viewer-api/scene/model", params={"variant": "tiny"})
        self.assertEqual(rejected.status_code, 400)

    def test_frontend_modules_must_be_revalidated_but_scene_headers_are_kept(self) -> None:
        # The frontend is a set of native ES modules that import each other by
        # name. A browser holding a stale copy of one while fetching another
        # links them together and fails, leaving the page with no event
        # listeners and no visible error.
        page = self.client.get("/")
        self.assertEqual(page.headers["cache-control"], "no-cache")

        self.client.post(
            "/viewer-api/scene",
            files={"model": ("scene.glb", b"model", "model/gltf-binary")},
            data={"manifest": manifest()},
        )
        model = self.client.get("/viewer-api/scene/model")
        # The scene endpoints set their own headers and must keep them.
        self.assertEqual(model.headers["cache-control"], "no-cache")
        self.assertEqual(model.headers["etag"], '"scene-1-full"')

    def test_upload_limit_and_empty_model_are_rejected(self) -> None:
        with TestClient(create_app(WEBAPP_DIR, max_upload_bytes=4)) as limited_client:
            oversized = limited_client.post(
                "/viewer-api/scene",
                files={"model": ("scene.glb", b"12345", "model/gltf-binary")},
                data={"manifest": manifest()},
            )
            self.assertEqual(oversized.status_code, 413)

            empty = limited_client.post(
                "/viewer-api/scene",
                files={"model": ("scene.glb", b"", "model/gltf-binary")},
                data={"manifest": manifest()},
            )
            self.assertEqual(empty.status_code, 400)

    def test_clear_removes_scene_without_reusing_revision(self) -> None:
        self.publish()
        self.assertEqual(self.client.delete("/viewer-api/scene").json(), {"cleared": True})
        self.assertFalse(self.client.get("/viewer-api/scene/manifest").json()["available"])
        self.assertEqual(self.publish().json()["revision"], 2)


class ViewerHostStaticTest(unittest.TestCase):
    def test_editor_and_mobile_shell_are_reachable(self) -> None:
        with TestClient(create_app(WEBAPP_DIR)) as client:
            editor = client.get("/")
            viewer = client.get("/viewer.html")
            stylesheet = client.get("/mobile-viewer.css")

        self.assertEqual(editor.status_code, 200)
        self.assertIn("Image-to-Depth Web Viewer", editor.text)
        self.assertEqual(viewer.status_code, 200)
        self.assertIn("Tracked Window", viewer.text)
        self.assertEqual(stylesheet.status_code, 200)


if __name__ == "__main__":
    unittest.main()


class BackendProxyTest(unittest.TestCase):
    """The editor reaches the depth backend through this origin.

    Naming the backend directly made it a cross-origin plain-text request from
    an HTTPS page, which each browser decides about differently: Chrome allows
    it because localhost is a trustworthy origin, Safari does not.
    """

    def _client(self, handler, **kwargs):
        app = create_app(WEBAPP_DIR, backend_origin="http://backend.test:8000", **kwargs)
        app.state.backend_transport = httpx.MockTransport(handler)
        return TestClient(app)

    def test_a_get_is_forwarded_and_the_body_returned(self) -> None:
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            return httpx.Response(200, json={"ready": True})

        with self._client(handler) as client:
            response = client.get("/api/status")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ready": True})
        self.assertEqual(seen["url"], "http://backend.test:8000/api/status")

    def test_an_upload_reaches_the_backend_intact(self) -> None:
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["method"] = request.method
            seen["body"] = request.content
            return httpx.Response(200, content=b"\x89PNG-depth", headers={
                "Content-Type": "image/png",
                # The editor reads the filename back out of this header.
                "X-RGBDE-Filename": "portrait_RGBDE.png",
            })

        with self._client(handler) as client:
            response = client.post("/api/process", content=b"multipart-payload")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"\x89PNG-depth")
        self.assertEqual(seen["method"], "POST")
        self.assertEqual(seen["body"], b"multipart-payload")
        # A response header the editor depends on must survive the hop.
        self.assertEqual(response.headers["X-RGBDE-Filename"], "portrait_RGBDE.png")

    def test_the_query_string_is_carried_through(self) -> None:
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["query"] = request.url.query.decode()
            return httpx.Response(200, json={})

        with self._client(handler) as client:
            client.get("/api/status?verbose=1")
        self.assertEqual(seen["query"], "verbose=1")

    def test_a_backend_error_is_passed_on_rather_than_masked(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(422, json={"detail": "image too large"})

        with self._client(handler) as client:
            response = client.post("/api/process", content=b"x")
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"], "image too large")

    def test_a_backend_that_is_not_running_says_so(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused", request=request)

        with self._client(handler) as client:
            response = client.get("/api/status")
        self.assertEqual(response.status_code, 502)
        detail = response.json()["detail"]
        self.assertIn("not reachable", detail)
        # The message has to name what to start, or it only says something broke.
        self.assertIn("run.py", detail)

    def test_hop_by_hop_headers_are_dropped_but_ordinary_ones_survive(self) -> None:
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["names"] = {key.lower() for key in request.headers}
            seen["content_type"] = request.headers.get("content-type")
            return httpx.Response(200, json={})

        with self._client(handler) as client:
            response = client.get("/api/status", headers={
                "Upgrade": "websocket",
                "TE": "trailers",
                "Content-Type": "application/json",
            })

        self.assertEqual(response.status_code, 200)
        # These describe the browser's connection to this host, not the message.
        self.assertNotIn("upgrade", seen["names"])
        self.assertNotIn("te", seen["names"])
        # The headers the backend actually reads have to arrive.
        self.assertEqual(seen["content_type"], "application/json")
        # The host must be the backend's, not the one the browser asked for.
        self.assertIn("host", seen["names"])

    def test_the_proxy_does_not_shadow_the_static_mount(self) -> None:
        # The editor itself is still served from this origin.
        def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("a page request must not reach the backend")

        with self._client(handler) as client:
            self.assertEqual(client.get("/viewer.html").status_code, 200)
            self.assertEqual(client.get("/index.html").status_code, 200)


class BackendOriginTest(unittest.TestCase):
    def test_the_port_follows_the_backend_environment_variable(self) -> None:
        previous = os.environ.get("RGBDE_BACKEND_PORT")
        os.environ["RGBDE_BACKEND_PORT"] = "8123"
        os.environ.pop("RGBDE_BACKEND_ORIGIN", None)
        try:
            # 127.0.0.1 rather than localhost: the name can resolve to the IPv6
            # loopback first, and the backend binds IPv4.
            self.assertEqual(default_backend_origin(), "http://127.0.0.1:8123")
        finally:
            if previous is None:
                os.environ.pop("RGBDE_BACKEND_PORT", None)
            else:
                os.environ["RGBDE_BACKEND_PORT"] = previous

    def test_an_explicit_origin_wins_and_loses_its_trailing_slash(self) -> None:
        os.environ["RGBDE_BACKEND_ORIGIN"] = "http://elsewhere:9000/"
        try:
            self.assertEqual(default_backend_origin(), "http://elsewhere:9000")
        finally:
            os.environ.pop("RGBDE_BACKEND_ORIGIN", None)


class MobileSourceSlotTest(unittest.TestCase):
    """The depth generated for the phone is kept here for the editor.

    Inference runs on this machine, so the RGBDE already passes through this
    host on its way out. Keeping a copy lets the editor open the same scene
    without the phone uploading bytes this machine produced, which is what a
    metered connection would otherwise be charged for twice.
    """

    PNG = b"\x89PNG\r\n\x1a\n" + b"rgbde-payload"

    def _client(self, handler, **kwargs):
        app = create_app(WEBAPP_DIR, backend_origin="http://backend.test:8000", **kwargs)
        app.state.backend_transport = httpx.MockTransport(handler)
        return TestClient(app)

    def _png_handler(self, filename: str = "pasted_RGBDE.png"):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                content=self.PNG,
                headers={"Content-Type": "image/png", "X-RGBDE-Filename": filename},
            )
        return handler

    def test_nothing_is_offered_before_the_phone_has_asked(self) -> None:
        with self._client(self._png_handler()) as client:
            status = client.get("/viewer-api/mobile-source")
            self.assertEqual(status.json(), {"available": False, "revision": 0})
            self.assertEqual(client.get("/viewer-api/mobile-source/image").status_code, 404)

    def test_a_marked_request_leaves_its_result_for_the_editor(self) -> None:
        with self._client(self._png_handler()) as client:
            forwarded = client.post(
                "/api/process?focal_length_35mm=50",
                files={"image": ("photo.jpg", b"jpeg-bytes", "image/jpeg")},
                headers={"X-RGBDE-Origin": "mobile"},
            )
            self.assertEqual(forwarded.status_code, 200)
            # The phone still receives its own answer unchanged.
            self.assertEqual(forwarded.content, self.PNG)

            status = client.get("/viewer-api/mobile-source").json()
            self.assertTrue(status["available"])
            self.assertEqual(status["revision"], 1)
            self.assertEqual(status["filename"], "pasted_RGBDE.png")
            self.assertEqual(status["focalLength35mm"], 50.0)
            self.assertEqual(status["byteLength"], len(self.PNG))

            image = client.get("/viewer-api/mobile-source/image")
            self.assertEqual(image.status_code, 200)
            self.assertEqual(image.content, self.PNG)
            self.assertEqual(image.headers["content-type"], "image/png")

    def test_the_editors_own_generation_is_not_offered_back_to_it(self) -> None:
        # The editor posts to the same endpoint through the same proxy. Without
        # the marker it would be handed back whatever it had just made itself.
        with self._client(self._png_handler()) as client:
            client.post(
                "/api/process",
                files={"image": ("photo.jpg", b"jpeg-bytes", "image/jpeg")},
            )
            self.assertFalse(client.get("/viewer-api/mobile-source").json()["available"])

    def test_a_failed_or_non_image_answer_is_not_kept(self) -> None:
        def failing(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"detail": "inference failed"})

        with self._client(failing) as client:
            client.post(
                "/api/process",
                files={"image": ("photo.jpg", b"jpeg-bytes", "image/jpeg")},
                headers={"X-RGBDE-Origin": "mobile"},
            )
            self.assertFalse(client.get("/viewer-api/mobile-source").json()["available"])

    def test_the_newest_generation_replaces_the_previous_one(self) -> None:
        with self._client(self._png_handler("first_RGBDE.png")) as client:
            client.post(
                "/api/process",
                files={"image": ("a.jpg", b"a", "image/jpeg")},
                headers={"X-RGBDE-Origin": "mobile"},
            )
            first = client.get("/viewer-api/mobile-source").json()

        with self._client(self._png_handler("second_RGBDE.png")) as client:
            for _ in range(2):
                client.post(
                    "/api/process",
                    files={"image": ("b.jpg", b"b", "image/jpeg")},
                    headers={"X-RGBDE-Origin": "mobile"},
                )
            second = client.get("/viewer-api/mobile-source").json()

        self.assertEqual(first["filename"], "first_RGBDE.png")
        self.assertEqual(second["filename"], "second_RGBDE.png")
        self.assertEqual(second["revision"], 2)

    def test_the_slot_can_be_emptied(self) -> None:
        with self._client(self._png_handler()) as client:
            client.post(
                "/api/process",
                files={"image": ("photo.jpg", b"jpeg-bytes", "image/jpeg")},
                headers={"X-RGBDE-Origin": "mobile"},
            )
            self.assertTrue(client.get("/viewer-api/mobile-source").json()["available"])
            self.assertEqual(client.delete("/viewer-api/mobile-source").json(), {"cleared": True})
            self.assertFalse(client.get("/viewer-api/mobile-source").json()["available"])
