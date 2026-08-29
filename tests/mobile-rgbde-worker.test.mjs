import assert from 'node:assert/strict';
import test from 'node:test';

import { processMobileRgbdeMessage } from '../webapp/src/mobile-rgbde-worker.js';


function decodedMessage({ fovDeg } = {}) {
  const width = 4;
  const height = 3;
  return {
    kind: 'build-decoded',
    id: 1,
    width,
    height,
    leftPixelsBuffer: new Uint8ClampedArray(width * height * 4).buffer,
    depthBuffer: new Float32Array(width * height).fill(2).buffer,
    depthStats: { min: 2, max: 2 },
    metadata: null,
    fovDeg,
    maxVertices: 12,
  };
}


test('worker pauses on missing FOV and transfers decoded buffers back', async () => {
  const input = decodedMessage();
  const { message, transfer } = await processMobileRgbdeMessage(input);
  assert.equal(message.kind, 'needs-fov');
  assert.equal(message.id, 1);
  assert.equal(message.width, 4);
  assert.equal(message.height, 3);
  assert.equal(message.leftPixelsBuffer, input.leftPixelsBuffer);
  assert.equal(message.depthBuffer, input.depthBuffer);
  assert.deepEqual(transfer, [input.leftPixelsBuffer, input.depthBuffer]);
});


test('worker resumes from transferred decoded buffers and returns mesh transfer shape', async () => {
  const phases = [];
  const { message, transfer } = await processMobileRgbdeMessage(
    decodedMessage({ fovDeg: 60 }),
    { onPhase: (phase) => phases.push(phase) },
  );
  assert.equal(message.kind, 'success');
  assert.equal(message.captureFovDeg, 60);
  assert.ok(message.positions instanceof Float32Array);
  assert.ok(message.uvs instanceof Float32Array);
  assert.ok(message.indices instanceof Uint8Array);
  assert.ok(message.positions.length / 3 <= 12);
  assert.equal(message.textureBuffer.byteLength, 4 * 3 * 4);
  assert.deepEqual(transfer, [
    message.positions.buffer,
    message.uvs.buffer,
    message.indices.buffer,
    message.textureBuffer,
  ]);
  assert.ok(message.metrics.meshMs >= 0);
  assert.deepEqual(phases, ['Building mesh']);
});


test('worker never oversamples beyond the decoded source grid', async () => {
  const input = decodedMessage({ fovDeg: 60 });
  input.maxVertices = 1000;
  const { message } = await processMobileRgbdeMessage(input);
  assert.equal(message.metrics.vertexCount, input.width * input.height);
  assert.ok(message.indices instanceof Uint8Array);
});


test('worker rejects malformed decoded transfers with an actionable error', async () => {
  const input = decodedMessage({ fovDeg: 50 });
  input.depthBuffer = new Float32Array(2).buffer;
  await assert.rejects(() => processMobileRgbdeMessage(input), /do not match/);
});
