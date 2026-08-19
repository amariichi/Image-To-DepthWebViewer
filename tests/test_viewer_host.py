from __future__ import annotations

import json
import unittest

from fastapi.testclient import TestClient

from server.viewer_host import WEBAPP_DIR, create_app


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
            manifest(depthSpan=8.01),
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
            data={"manifest": manifest(depthSpan=8.0, disparityBlend=0.5, captureFovDeg=62.5)},
        )
        self.assertEqual(response.status_code, 200)
        stored = self.client.get("/viewer-api/scene/manifest").json()["manifest"]
        self.assertEqual(stored["depthSpan"], 8.0)
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
