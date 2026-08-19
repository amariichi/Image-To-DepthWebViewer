import assert from 'node:assert/strict';
import test from 'node:test';

import { createGlbBlob } from '../webapp/src/gltf-exporter.js';
import {
  MAX_MOBILE_PUBLISH_VERTICES,
  createMobilePublishMesh,
  fitMobileTextureSize,
} from '../webapp/src/mobile-publish-mesh.js';


function createGrid(meshX, meshY) {
  const vertices = (meshX + 1) * (meshY + 1);
  const positions = new Float32Array(vertices * 3);
  const uvs = new Float32Array(vertices * 2);
  for (let y = 0; y <= meshY; y += 1) {
    for (let x = 0; x <= meshX; x += 1) {
      const vertex = y * (meshX + 1) + x;
      positions[vertex * 3] = x;
      positions[vertex * 3 + 1] = y;
      positions[vertex * 3 + 2] = -(x + y + 1);
      uvs[vertex * 2] = x / meshX;
      uvs[vertex * 2 + 1] = y / meshY;
    }
  }
  return { positions, uvs, meshX, meshY };
}


function readGlbJson(blobBuffer) {
  const view = new DataView(blobBuffer);
  const jsonLength = view.getUint32(12, true);
  const bytes = new Uint8Array(blobBuffer, 20, jsonLength);
  return JSON.parse(new TextDecoder().decode(bytes).trim());
}


test('mobile publish resamples a dense grid below the 16-bit vertex ceiling', () => {
  const source = createGrid(1000, 500);
  const mobile = createMobilePublishMesh(source);
  assert.ok(mobile.vertexCount <= MAX_MOBILE_PUBLISH_VERTICES);
  assert.ok(mobile.vertexCount > 50_000);
  assert.ok(mobile.indices instanceof Uint16Array);
  let maxIndex = 0;
  for (const index of mobile.indices) maxIndex = Math.max(maxIndex, index);
  assert.ok(maxIndex < mobile.vertexCount);
  assert.deepEqual([...mobile.positions.slice(0, 3)], [0, 0, -1]);
  assert.deepEqual([...mobile.positions.slice(-3)], [1000, 500, -1501]);
  assert.deepEqual([...mobile.uvs.slice(-2)], [1, 1]);
});


test('mobile texture sizing neither upscales nor exceeds dimension/pixel budgets', () => {
  assert.deepEqual(fitMobileTextureSize(1280, 720), { width: 1280, height: 720 });
  const fourK = fitMobileTextureSize(3840, 2160);
  assert.ok(fourK.width <= 2048);
  assert.ok(fourK.height <= 2048);
  assert.ok(fourK.width * fourK.height <= 2_000_000);
  assert.ok(Math.abs(fourK.width / fourK.height - 16 / 9) < 0.01);
});


test('mobile GLB omits normals and keeps compact 16-bit indices', async () => {
  const mesh = createMobilePublishMesh(createGrid(4, 2));
  const blob = await createGlbBlob({ mesh, includeNormals: false });
  const json = readGlbJson(await blob.arrayBuffer());
  const primitive = json.meshes[0].primitives[0];
  assert.equal('NORMAL' in primitive.attributes, false);
  assert.equal(json.accessors[primitive.indices].componentType, 5123);
});


test('standard desktop GLB keeps normals and 32-bit indices by default', async () => {
  const grid = createGrid(2, 1);
  const blob = await createGlbBlob({
    mesh: {
      ...grid,
      indices: new Uint32Array([0, 3, 1, 1, 3, 4, 1, 4, 2, 2, 4, 5]),
    },
  });
  const json = readGlbJson(await blob.arrayBuffer());
  const primitive = json.meshes[0].primitives[0];
  assert.equal('NORMAL' in primitive.attributes, true);
  assert.equal(json.accessors[primitive.indices].componentType, 5125);
});
