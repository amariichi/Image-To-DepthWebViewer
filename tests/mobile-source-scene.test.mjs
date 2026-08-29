import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSourceSceneFromGlb,
  createSourceSceneFromRgbde,
} from '../webapp/src/mobile-source-scene.js';


function glbFixture() {
  return {
    positions: new Float32Array([
      -1, 1, -2,
      1, 1, -2,
      -1, -1, -2,
      1, -1, -2,
    ]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
    indices: new Uint16Array([0, 2, 1, 1, 2, 3]),
  };
}


test('published GLB normalizes into the shared source-scene contract', () => {
  const texture = { width: 640, height: 480 };
  const scene = createSourceSceneFromGlb(glbFixture(), {
    sourceName: 'desk.glb',
    captureFovDeg: 50,
  }, texture);
  assert.equal(scene.origin, 'published-glb');
  assert.equal(scene.sourceWidth, 640);
  assert.equal(scene.sourceHeight, 480);
  assert.equal(scene.captureFovDeg, 50);
  assert.equal('texture' in scene, false, 'decoded pixels transfer to the GPU, not source state');
  assert.deepEqual(scene.bounds, { min: [-1, -1, -2], max: [1, 1, -2] });
  assert.ok(Object.isFrozen(scene));
});


test('RGBDE construction keeps a flat camera-axis wall flat and uses the same axes', () => {
  const width = 8;
  const height = 6;
  const depth = new Float32Array(width * height).fill(2);
  const texture = { width, height };
  const scene = createSourceSceneFromRgbde({
    width,
    height,
    depth,
    depthStats: { min: 2, max: 2 },
    metadata: { verticalFovDeg: 60 },
    textureImage: texture,
  }, { maxVertices: 48, sourceName: 'phone.jpg' });
  assert.equal(scene.origin, 'local-rgbde');
  assert.equal(scene.sourceName, 'phone.jpg');
  assert.equal(scene.captureFovDeg, 60);
  assert.equal('metadata' in scene, false, 'source filename metadata is not retained');
  assert.ok([...scene.positions].filter((_, index) => index % 3 === 2)
    .every((z) => Math.abs(z + 2) < 1e-6));
  assert.ok(scene.bounds.min[0] < 0 && scene.bounds.max[0] > 0);
  assert.ok(scene.bounds.min[1] < 0 && scene.bounds.max[1] > 0);
  assert.equal(scene.bounds.min[2], -2);
  assert.equal(scene.bounds.max[2], -2);
  assert.ok(scene.positions.length / 3 <= 48);
  assert.equal(scene.uvs.length / 2, scene.positions.length / 3);
});


test('RGBDE without metadata pauses for an explicit vertical FOV', () => {
  const decoded = {
    width: 2,
    height: 2,
    depth: new Float32Array([1, 1, 1, 1]),
    depthStats: { min: 1, max: 1 },
    metadata: null,
    textureImage: { width: 2, height: 2 },
  };
  const paused = createSourceSceneFromRgbde(decoded, { maxVertices: 4 });
  assert.equal(paused.kind, 'needs-fov');
  assert.equal(paused.needsFov, true);
  const resumed = createSourceSceneFromRgbde(decoded, { maxVertices: 4, fovDeg: 32 });
  assert.equal(resumed.captureFovDeg, 32);
  assert.equal(resumed.positions.length / 3, 4);
});


test('GLB and RGBDE source scenes agree that +y is up and negative z is behind glass', () => {
  const glb = createSourceSceneFromGlb(glbFixture(), { captureFovDeg: 60 }, {
    width: 8,
    height: 6,
  });
  const rgbde = createSourceSceneFromRgbde({
    width: 8,
    height: 6,
    depth: new Float32Array(48).fill(2),
    depthStats: { min: 2, max: 2 },
    metadata: { verticalFovDeg: 60 },
    textureImage: { width: 8, height: 6 },
  }, { maxVertices: 48 });
  for (const scene of [glb, rgbde]) {
    assert.ok(scene.bounds.max[1] > scene.bounds.min[1]);
    assert.ok(scene.bounds.max[2] <= 0);
    assert.equal(scene.uvs[1], 0, 'top-row UV v=0 must map to positive y');
    assert.ok(scene.positions[1] > 0);
  }
});
