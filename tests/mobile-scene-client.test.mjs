import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MOBILE_PRESENTATION_DEFAULTS,
  createMobileSceneManifest,
  fetchPublishedScenePair,
  mobileDepthSpanForMagnification,
  publishMobileScene,
} from '../webapp/src/mobile-scene-client.js';


test('creates a presentation-only schema v1 mobile manifest', () => {
  const manifest = createMobileSceneManifest({
    sourceName: ' portrait_RGBDE.png ',
    publishedAt: '2026-08-17T00:00:00.000Z',
  });

  assert.deepEqual(manifest, {
    schemaVersion: 1,
    sourceName: 'portrait_RGBDE.png',
    publishedAt: '2026-08-17T00:00:00.000Z',
    ...MOBILE_PRESENTATION_DEFAULTS,
    captureFovDeg: null,
  });
  assert.equal('faceLandmarks' in manifest, false);
  assert.equal('geometryFov' in manifest, false);
  assert.equal(manifest.frontOffset, 0);
  // One world unit is half the physical screen height, so a span of 1 is a
  // miniature roughly half a screen height deep behind the glass.
  assert.equal(manifest.depthSpan, 1);
  assert.equal(manifest.baselineEyeZ, 4.5);
  assert.equal(manifest.disparityBlend, 1);
  assert.equal(manifest.captureFovDeg, null);
});


test('maps desktop depth magnification to a bounded mobile relief span', () => {
  assert.equal(mobileDepthSpanForMagnification(0.5), 1);
  assert.equal(mobileDepthSpanForMagnification(0.1), 0.2);
  assert.equal(mobileDepthSpanForMagnification(100), 1.8);
});


test('a published capture field of view is carried through and validated', () => {
  assert.equal(createMobileSceneManifest({ captureFovDeg: 62.5 }).captureFovDeg, 62.5);
  assert.equal(createMobileSceneManifest({ captureFovDeg: 0 }).captureFovDeg, null);
  assert.equal(createMobileSceneManifest({ captureFovDeg: Number.NaN }).captureFovDeg, null);
});


test('publishes a GLB and returns the relay revision', async () => {
  const calls = [];
  const result = await publishMobileScene({
    blob: new Blob([new Uint8Array([0x67, 0x6c, 0x54, 0x46])], { type: 'model/gltf-binary' }),
    filename: 'scene.glb',
    manifest: createMobileSceneManifest({ sourceName: 'scene_RGBDE.png' }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ revision: 4, filename: 'scene.glb' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  assert.deepEqual(result, { revision: 4, filename: 'scene.glb' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/viewer-api/scene');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body.get('model').name, 'scene.glb');
  assert.equal(JSON.parse(calls[0].options.body.get('manifest')).schemaVersion, 1);
});


test('surfaces relay validation errors and rejects empty blobs', async () => {
  await assert.rejects(
    () => publishMobileScene({
      blob: new Blob([]),
      filename: 'empty.glb',
      manifest: {},
      fetchImpl: async () => new Response(),
    }),
    /non-empty GLB/,
  );

  await assert.rejects(
    () => publishMobileScene({
      blob: new Blob(['model']),
      filename: 'scene.glb',
      manifest: {},
      fetchImpl: async () => new Response(JSON.stringify({ detail: 'manifest.schemaVersion must be 1' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    }),
    /schemaVersion must be 1/,
  );
});


test('retries until manifest and GLB revisions form one atomic scene pair', async () => {
  const responses = [
    new Response(JSON.stringify({ available: true, revision: 4, filename: 'old.glb', manifest: {} })),
    new Response('new-model-race', { headers: { 'X-Scene-Revision': '5' } }),
    new Response(JSON.stringify({ available: true, revision: 5, filename: 'new.glb', manifest: {} })),
    new Response('new-model', { headers: { 'X-Scene-Revision': '5' } }),
  ];
  const calls = [];
  const pair = await fetchPublishedScenePair({
    fetchImpl: async (url) => {
      calls.push(url);
      return responses.shift();
    },
  });
  assert.equal(pair.envelope.revision, 5);
  assert.equal(await pair.modelResponse.text(), 'new-model');
  assert.deepEqual(calls, [
    '/viewer-api/scene/manifest',
    '/viewer-api/scene/model',
    '/viewer-api/scene/manifest',
    '/viewer-api/scene/model',
  ]);
});


test('unchanged and unavailable scenes never re-download the GLB', async () => {
  const unchanged = await fetchPublishedScenePair({
    knownRevision: 7,
    knownPublishedAt: '2026-08-17T20:00:00.000Z',
    fetchImpl: async () => new Response(JSON.stringify({
      available: true,
      revision: 7,
      manifest: { publishedAt: '2026-08-17T20:00:00.000Z' },
    })),
  });
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.modelResponse, null);

  const unavailable = await fetchPublishedScenePair({
    fetchImpl: async () => new Response(JSON.stringify({ available: false, revision: 0 })),
  });
  assert.equal(unavailable.envelope.available, false);
  assert.equal(unavailable.modelResponse, null);
});


test('same revision after a relay restart reloads when publish identity changed', async () => {
  let calls = 0;
  const pair = await fetchPublishedScenePair({
    knownRevision: 1,
    knownPublishedAt: 'before-restart',
    fetchImpl: async (url) => {
      calls += 1;
      if (url.endsWith('manifest')) {
        return new Response(JSON.stringify({
          available: true,
          revision: 1,
          manifest: { publishedAt: 'after-restart' },
        }));
      }
      return new Response('replacement', { headers: { 'X-Scene-Revision': '1' } });
    },
  });
  assert.equal(pair.unchanged, false);
  assert.equal(await pair.modelResponse.text(), 'replacement');
  assert.equal(calls, 2);
});
