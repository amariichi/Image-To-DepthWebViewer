import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_TILT_GAIN,
  MAX_TILT_CORRECTION_RAD,
  clampTiltCorrection,
  computeScreenRoll,
  createRollFilter,
  createTiltTracker,
  requestTiltPermission,
  wrapAngle,
} from '../webapp/src/device-tilt.js';

const G = 9.81;
const deg = (radians) => (radians * 180) / Math.PI;


test('screen roll is read from the gravity vector, not from Euler angles', () => {
  // Held upright: gravity points down the screen, so there is no roll.
  assert.equal(computeScreenRoll({ x: 0, y: -G, z: 0 }), 0);

  // Rolled until gravity lies along the screen's right edge.
  assert.ok(Math.abs(deg(computeScreenRoll({ x: G, y: 0, z: 0 })) - 90) < 1e-6);
  assert.ok(Math.abs(deg(computeScreenRoll({ x: -G, y: 0, z: 0 })) + 90) < 1e-6);

  // A modest, realistic roll.
  const roll = computeScreenRoll({ x: G * Math.sin(Math.PI / 9), y: -G * Math.cos(Math.PI / 9), z: 0 });
  assert.ok(Math.abs(deg(roll) - 20) < 1e-6);
});


test('a device pointing straight up or down reports no usable roll', () => {
  // Lying flat on a table, gravity is almost entirely along the screen normal,
  // so its direction within the screen plane is meaningless rather than noisy.
  assert.equal(computeScreenRoll({ x: 0.1, y: -0.2, z: -G }), null);
  assert.equal(computeScreenRoll({ x: Number.NaN, y: -G, z: 0 }), null);
  assert.equal(computeScreenRoll(null), null);
});


test('the page rotating relative to the hardware is taken out', () => {
  // Landscape: the page has turned 90 degrees under a device that has not
  // physically rolled relative to gravity, so the roll must read as zero.
  const gravity = { x: G, y: 0, z: 0 };
  assert.ok(Math.abs(deg(computeScreenRoll(gravity, 0)) - 90) < 1e-6);
  assert.ok(Math.abs(computeScreenRoll(gravity, 90)) < 1e-6);
  assert.ok(Math.abs(deg(computeScreenRoll(gravity, -90)) - 180) < 1e-6);
});


test('the correction is scaled and bounded because the picture has edges', () => {
  // Counter-rotating fully would swing the picture's corners into view, so the
  // cue is given partially and capped.
  assert.ok(Math.abs(clampTiltCorrection(0.4) - 0.4 * DEFAULT_TILT_GAIN) < 1e-9);
  assert.equal(clampTiltCorrection(Math.PI / 2), MAX_TILT_CORRECTION_RAD);
  assert.equal(clampTiltCorrection(-Math.PI / 2), -MAX_TILT_CORRECTION_RAD);
  assert.equal(clampTiltCorrection(Number.NaN), 0);

  // Handedness is left correctable, as it is for the front camera.
  assert.ok(clampTiltCorrection(0.3, { invert: true }) < 0);
  assert.equal(clampTiltCorrection(0.3, { gain: 0 }), 0);
});


test('the roll filter follows the shortest way round rather than unwinding', () => {
  const filter = createRollFilter({ timeConstantMs: 100 });
  assert.equal(filter.get(), null);
  filter.update(Math.PI - 0.05, 0);

  // Crossing the wrap boundary is a small move, not a near-full turn.
  const crossed = filter.update(-Math.PI + 0.05, 1000);
  assert.ok(Math.abs(wrapAngle(crossed - (-Math.PI + 0.05))) < 0.02);

  // Smoothing really is applied rather than the newest value being taken.
  const fresh = createRollFilter({ timeConstantMs: 1000 });
  fresh.update(0, 0);
  const damped = fresh.update(1, 100);
  assert.ok(damped > 0 && damped < 0.2, `expected a damped step, got ${damped}`);

  fresh.reset();
  assert.equal(fresh.get(), null);
});


test('the tracker starts only with permission and stops listening cleanly', async () => {
  const listeners = new Map();
  const target = {
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
  };
  const rolls = [];
  const tracker = createTiltTracker({
    target,
    screen: { orientation: { angle: 0 } },
    now: () => 0,
    onRoll: (roll) => rolls.push(roll),
  });

  assert.equal(await tracker.start(), 'granted');
  assert.equal(tracker.running, true);
  listeners.get('devicemotion')({ accelerationIncludingGravity: { x: G, y: 0, z: 0 } });
  assert.ok(Math.abs(deg(rolls.at(-1)) - 90) < 1e-6);
  assert.ok(Math.abs(deg(tracker.getRawRoll()) - 90) < 1e-6);

  // A reading with no usable in-plane component must be ignored, not reported.
  const before = rolls.length;
  listeners.get('devicemotion')({ accelerationIncludingGravity: { x: 0, y: 0, z: -G } });
  assert.equal(rolls.length, before);

  tracker.stop();
  assert.equal(tracker.running, false);
  assert.equal(listeners.has('devicemotion'), false);
  assert.equal(tracker.getRoll(), null);
});


test('a refused motion permission leaves the tracker stopped', async () => {
  const tracker = createTiltTracker({
    target: { addEventListener: () => {}, removeEventListener: () => {} },
    screen: { orientation: { angle: 0 } },
  });
  const original = globalThis.DeviceMotionEvent;
  globalThis.DeviceMotionEvent = { requestPermission: async () => 'denied' };
  try {
    assert.equal(await tracker.start(), 'denied');
    assert.equal(tracker.running, false);
  } finally {
    globalThis.DeviceMotionEvent = original;
  }
});


test('platforms without a permission gate report granted', async () => {
  assert.equal(await requestTiltPermission({ motionEvent: undefined }), 'granted');
  assert.equal(await requestTiltPermission({
    motionEvent: { requestPermission: async () => { throw new Error('blocked'); } },
  }), 'denied');
});
