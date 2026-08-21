import assert from 'node:assert/strict';
import test from 'node:test';

import { parseGlb } from '../webapp/src/glb-loader.js';


function pad4(bytes, fill = 0) {
  const padded = new Uint8Array(bytes.length + ((4 - (bytes.length % 4)) % 4));
  padded.fill(fill);
  padded.set(bytes);
  return padded;
}

function createFixture({
  missingUv = false,
  version = 2,
  compactIndices = false,
  imageMimeType = 'image/png',
} = {}) {
  const positions = new Float32Array([
    -1, -1, 0,
    1, -1, 0,
    0, 1, 0,
  ]);
  const uvs = new Float32Array([0, 1, 1, 1, 0.5, 0]);
  const indices = compactIndices
    ? new Uint16Array([0, 1, 2])
    : new Uint32Array([0, 1, 2]);
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const binary = new Uint8Array(positions.byteLength + uvs.byteLength + indices.byteLength + png.byteLength);
  let binaryOffset = 0;
  binary.set(new Uint8Array(positions.buffer), binaryOffset);
  const positionOffset = binaryOffset;
  binaryOffset += positions.byteLength;
  binary.set(new Uint8Array(uvs.buffer), binaryOffset);
  const uvOffset = binaryOffset;
  binaryOffset += uvs.byteLength;
  binary.set(new Uint8Array(indices.buffer), binaryOffset);
  const indexOffset = binaryOffset;
  binaryOffset += indices.byteLength;
  binary.set(png, binaryOffset);
  const imageOffset = binaryOffset;

  const attributes = { POSITION: 0 };
  if (!missingUv) attributes.TEXCOORD_0 = 1;
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: positionOffset, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: uvOffset, byteLength: uvs.byteLength },
      { buffer: 0, byteOffset: indexOffset, byteLength: indices.byteLength },
      { buffer: 0, byteOffset: imageOffset, byteLength: png.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 2, componentType: compactIndices ? 5123 : 5125, count: 3, type: 'SCALAR' },
    ],
    images: [{ bufferView: 3, mimeType: imageMimeType }],
    textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    meshes: [{ primitives: [{ attributes, indices: 2, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const jsonBytes = pad4(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const binaryBytes = pad4(binary);
  const total = 12 + 8 + jsonBytes.length + 8 + binaryBytes.length;
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, version, true);
  view.setUint32(8, total, true);
  let offset = 12;
  view.setUint32(offset, jsonBytes.length, true);
  view.setUint32(offset + 4, 0x4e4f534a, true);
  offset += 8;
  output.set(jsonBytes, offset);
  offset += jsonBytes.length;
  view.setUint32(offset, binaryBytes.length, true);
  view.setUint32(offset + 4, 0x004e4942, true);
  output.set(binaryBytes, offset + 8);
  return output.buffer;
}


test('parses the repository GLB profile', () => {
  const parsed = parseGlb(createFixture());
  assert.deepEqual([...parsed.positions], [-1, -1, 0, 1, -1, 0, 0, 1, 0]);
  assert.deepEqual([...parsed.uvs], [0, 1, 1, 1, 0.5, 0]);
  assert.deepEqual([...parsed.indices], [0, 1, 2]);
  assert.deepEqual(parsed.bounds, { min: [-1, -1, 0], max: [1, 1, 0] });
  assert.equal(parsed.imageBlob.type, 'image/png');
  assert.equal(parsed.imageBlob.size, 8);
  assert.equal(parsed.nodeMatrix, null);
});


test('rejects bad GLB magic and version', () => {
  const badMagic = createFixture();
  new DataView(badMagic).setUint32(0, 0, true);
  assert.throws(() => parseGlb(badMagic), /magic/);
  assert.throws(() => parseGlb(createFixture({ version: 1 })), /version 2/);
});


test('rejects a profile without texture coordinates', () => {
  assert.throws(() => parseGlb(createFixture({ missingUv: true })), /TEXCOORD_0/);
});


test('preserves compact indices to reduce mobile CPU and GPU memory', () => {
  const parsed = parseGlb(createFixture({ compactIndices: true }));
  assert.ok(parsed.indices instanceof Uint16Array);
  assert.deepEqual([...parsed.indices], [0, 1, 2]);
});


test('a JPEG mobile texture is accepted and a foreign image type is rejected', () => {
  // The mobile publish profile ships JPEG because the texture, not the mesh,
  // dominates what a constrained browser downloads and holds. Desktop exports
  // remain lossless PNG, so both must parse.
  const jpeg = parseGlb(createFixture({ imageMimeType: 'image/jpeg' }));
  assert.equal(jpeg.imageBlob.type, 'image/jpeg');

  const png = parseGlb(createFixture());
  assert.equal(png.imageBlob.type, 'image/png');

  assert.throws(
    () => parseGlb(createFixture({ imageMimeType: 'image/webp' })),
    /PNG or JPEG/,
  );
});
