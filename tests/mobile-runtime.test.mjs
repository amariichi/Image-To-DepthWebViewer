import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TRACKING_MIRROR_STORAGE_KEY,
  classifyViewport,
  createRateMeter,
  inferFrontCameraMirrorX,
  inferFrontCameraXyGain,
  loadFrontCameraMirrorX,
  saveFrontCameraMirrorX,
} from '../webapp/src/mobile-runtime.js';


test('classifies phone and tablet viewport orientations', () => {
  assert.equal(classifyViewport(390, 844), 'portrait');
  assert.equal(classifyViewport(844, 390), 'landscape');
  assert.equal(classifyViewport(744, 1133), 'portrait');
  assert.equal(classifyViewport(1133, 744), 'landscape');
  assert.throws(() => classifyViewport(0, 800), /positive/);
});


test('rate meter reports recent cadence and drops stale samples', () => {
  const meter = createRateMeter({ windowMs: 1000 });
  meter.mark(0);
  meter.mark(500);
  assert.equal(meter.rate(500), 2);
  meter.mark(1000);
  assert.equal(meter.rate(1000), 2);
  assert.equal(meter.rate(2500), 0);
  meter.reset();
  assert.equal(meter.rate(), 0);
});


test('iOS Chrome and Safari start with the same corrected handedness', () => {
  assert.equal(inferFrontCameraMirrorX('Mozilla/5.0 Version/18.0 Mobile Safari/604.1'), true);
  assert.equal(inferFrontCameraMirrorX('Mozilla/5.0 CriOS/140.0 Mobile/15E148 Safari/604.1'), true);
});


test('Safari uses half-strength XY tracking while iOS Chrome keeps its weaker observed gain', () => {
  assert.equal(inferFrontCameraXyGain('Mozilla/5.0 Version/18.0 Mobile Safari/604.1'), 0.325);
  assert.equal(inferFrontCameraXyGain('Mozilla/5.0 CriOS/140.0 Mobile/15E148 Safari/604.1'), 0.65);
});


test('a saved handedness override wins over browser inference', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(loadFrontCameraMirrorX(storage, 'CriOS'), true);
  saveFrontCameraMirrorX(storage, false);
  assert.equal(values.get(TRACKING_MIRROR_STORAGE_KEY), 'false');
  assert.equal(loadFrontCameraMirrorX(storage, 'CriOS'), false);
});
