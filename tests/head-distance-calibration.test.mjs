import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HEAD_DISTANCE_SCALE_STORAGE_KEY,
  MAX_DISTANCE_SCALE,
  MIN_DISTANCE_SCALE,
  clampDistanceScale,
  distanceScaleFrom,
  loadDistanceScale,
  saveDistanceScale,
} from '../webapp/src/head-distance-calibration.js';

function fakeStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    has: (key) => values.has(key),
  };
}

test('distance calibration produces a bounded multiplicative correction', () => {
  assert.equal(distanceScaleFrom(300, 150), 0.5);
  assert.equal(distanceScaleFrom(150, 300), 2);
  assert.equal(distanceScaleFrom(1000, 1), MIN_DISTANCE_SCALE);
  assert.equal(distanceScaleFrom(1, 1000), MAX_DISTANCE_SCALE);
  assert.equal(distanceScaleFrom(0, 350), 1);
  assert.equal(clampDistanceScale(Number.NaN), 1);
});

test('distance calibration round-trips and survives unavailable storage', () => {
  const storage = fakeStorage();
  saveDistanceScale(storage, 0.5);
  assert.equal(loadDistanceScale(storage), 0.5);
  saveDistanceScale(storage, 1);
  assert.equal(storage.has(HEAD_DISTANCE_SCALE_STORAGE_KEY), false);

  const hostile = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
    removeItem: () => { throw new Error('denied'); },
  };
  assert.equal(loadDistanceScale(hostile), 1);
  assert.doesNotThrow(() => saveDistanceScale(hostile, 2));
});
