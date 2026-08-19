import assert from 'node:assert/strict';
import test from 'node:test';

import { createGlbBlob } from '../webapp/src/gltf-exporter.js';
import { createDeformedPositions } from '../webapp/src/mesh-evaluator.js';
import { normalizeReliefDepth } from '../webapp/src/mobile-relief.js';
import {
  MAX_MOBILE_PUBLISH_VERTICES,
  MOBILE_PUBLISH_PROFILES,
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


test('mobile publish resamples a dense grid and keeps the image boundary', () => {
  const source = createGrid(1000, 500);
  const mobile = createMobilePublishMesh(source);
  assert.ok(mobile.vertexCount <= MAX_MOBILE_PUBLISH_VERTICES);
  // The old ceiling was the 16-bit index limit, which cost real mesh
  // resolution for a saving of a few megabytes. WebGL2 draws 32-bit indices
  // without an extension, so the grid now stays near the desktop density.
  assert.ok(mobile.vertexCount > 200_000);
  assert.ok(mobile.indices instanceof Uint32Array);
  let maxIndex = 0;
  for (const index of mobile.indices) maxIndex = Math.max(maxIndex, index);
  assert.ok(maxIndex < mobile.vertexCount);
  assert.deepEqual([...mobile.positions.slice(0, 3)], [0, 0, -1]);
  assert.deepEqual([...mobile.positions.slice(-3)], [1000, 500, -1501]);
  assert.deepEqual([...mobile.uvs.slice(-2)], [1, 1]);
});


test('the reduced fallback profile stays inside the 16-bit index ceiling', () => {
  const source = createGrid(1000, 500);
  const reduced = createMobilePublishMesh(source, {
    maxVertices: MOBILE_PUBLISH_PROFILES.reduced.maxVertices,
  });
  assert.ok(reduced.vertexCount <= MOBILE_PUBLISH_PROFILES.reduced.maxVertices);
  assert.ok(reduced.indices instanceof Uint16Array);
  // Both profiles must still describe the same picture, corner for corner.
  assert.deepEqual([...reduced.positions.slice(0, 3)], [0, 0, -1]);
  assert.deepEqual([...reduced.positions.slice(-3)], [1000, 500, -1501]);
  assert.deepEqual([...reduced.uvs.slice(0, 2)], [0, 0]);
  assert.deepEqual([...reduced.uvs.slice(-2)], [1, 1]);
});


test('the reduced texture budget is strictly smaller than the full one', () => {
  const full = fitMobileTextureSize(3840, 2160, {
    maxDimension: MOBILE_PUBLISH_PROFILES.full.maxTextureDimension,
    maxPixels: MOBILE_PUBLISH_PROFILES.full.maxTexturePixels,
  });
  const reduced = fitMobileTextureSize(3840, 2160, {
    maxDimension: MOBILE_PUBLISH_PROFILES.reduced.maxTextureDimension,
    maxPixels: MOBILE_PUBLISH_PROFILES.reduced.maxTexturePixels,
  });
  assert.ok(reduced.width * reduced.height < full.width * full.height);
  assert.ok(Math.abs(reduced.width / reduced.height - 16 / 9) < 0.01);
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


test('depth magnification is carried by the relief span, not applied twice', () => {
  // The manifest already expresses Depth Magnification as the mobile relief
  // span. Applying it to the published geometry as well counts it twice, and
  // the second count is not neutral: squeezing the source range toward the near
  // plane shifts the disparity mapping, so a near subject ends up with a
  // smaller share of a smaller budget.
  const mesh = {
    baseDepthMin: 1,
    baseDepths: new Float32Array([1.0, 1.3, 3.0]),
    rayDirections: new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1]),
    positions: new Float32Array(9),
  };
  const magnified = createDeformedPositions(mesh, { magnification: 0.5 });
  const plain = createDeformedPositions(mesh, { magnification: 1 });

  // Magnification 0.5 halves the published depth range.
  assert.ok(Math.abs(-magnified[8] - 2.0) < 1e-6, `far sample landed at ${-magnified[8]}`);
  assert.ok(Math.abs(-plain[8] - 3.0) < 1e-6, `far sample landed at ${-plain[8]}`);

  // The subject's share of the relief budget is what that costs.
  const magnifiedShare = normalizeReliefDepth(-magnified[5], { near: -magnified[2], far: -magnified[8] }, 1);
  const plainShare = normalizeReliefDepth(-plain[5], { near: -plain[2], far: -plain[8] }, 1);
  assert.ok(
    plainShare > magnifiedShare * 1.25,
    `expected the unsqueezed range to give the subject more: ${magnifiedShare} vs ${plainShare}`,
  );
});
