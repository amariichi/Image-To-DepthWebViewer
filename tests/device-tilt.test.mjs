import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_ORIENTATION_SETTLE_MS,
  DEFAULT_TILT_GAIN,
  MAX_TILT_CORRECTION_RAD,
  clampTiltCorrection,
  computeScreenHeading,
  computeScreenRoll,
  createGravityFilter,
  createRollFilter,
  createTiltTracker,
  removeOrientationOffset,
  requestOrientationPermission,
  requestTiltPermission,
  wrapAngle,
} from '../webapp/src/device-tilt.js';

const G = 9.81;
const deg = (radians) => (radians * 180) / Math.PI;


test('the reported vector points away from gravity, not along it', () => {
  // An accelerometer at rest measures the reaction holding the device up, so a
  // device stood upright in portrait reads about +9.81 on y. Reading it as
  // though it pointed downwards put portrait at 180 degrees and landscape at
  // -90, pinning the correction at its cap in opposite directions: the view
  // tilted left in portrait and right in landscape, never level.
  assert.equal(computeScreenRoll({ x: 0, y: G, z: 0 }), 0);

  // A modest, realistic roll.
  const roll = computeScreenRoll({ x: -G * Math.sin(Math.PI / 9), y: G * Math.cos(Math.PI / 9), z: 0 });
  assert.ok(Math.abs(deg(roll) - 20) < 1e-6, `expected 20 degrees, got ${deg(roll)}`);
  const other = computeScreenRoll({ x: G * Math.sin(Math.PI / 9), y: G * Math.cos(Math.PI / 9), z: 0 });
  assert.ok(Math.abs(deg(other) + 20) < 1e-6);
});


test('a device pointing straight up or down reports no usable roll', () => {
  // Lying flat on a table, the vector is almost entirely along the screen
  // normal, so its direction within the screen plane is meaningless rather than
  // merely noisy.
  assert.equal(computeScreenRoll({ x: 0.1, y: -0.2, z: G }), null);
  assert.equal(computeScreenRoll({ x: Number.NaN, y: G, z: 0 }), null);
  assert.equal(computeScreenRoll(null), null);
});


test('holding the device in any orientation reads as level', () => {
  // The offset from orientation is always a multiple of a quarter turn, so it
  // is removed by rounding rather than by consulting screen.orientation.angle.
  // Three attempts to derive that angle's convention failed on hardware, in
  // opposite directions on different devices.
  const held = (degrees) => ({
    x: -G * Math.sin((degrees * Math.PI) / 180),
    y: G * Math.cos((degrees * Math.PI) / 180),
    z: 0,
  });
  for (const orientation of [0, 90, 180, 270, -90]) {
    const roll = computeScreenRoll(held(orientation));
    assert.ok(Math.abs(deg(roll)) < 1e-6, `orientation ${orientation} read as ${deg(roll)}`);
  }

  // A real roll on top of any orientation survives.
  for (const orientation of [0, 90, 180, 270]) {
    const roll = computeScreenRoll(held(orientation + 12));
    assert.ok(Math.abs(deg(roll) - 12) < 1e-6, `orientation ${orientation} + 12 read as ${deg(roll)}`);
  }
});


test('the quarter-turn offset is removed without swallowing a real roll', () => {
  const q = Math.PI / 2;
  assert.ok(Math.abs(removeOrientationOffset(0.3) - 0.3) < 1e-9);
  assert.ok(Math.abs(removeOrientationOffset(q + 0.3) - 0.3) < 1e-9);
  assert.ok(Math.abs(removeOrientationOffset(-q + 0.3) - 0.3) < 1e-9);
  assert.ok(Math.abs(removeOrientationOffset(Math.PI - 0.3) + 0.3) < 1e-9);

  // The residual can never exceed half a quarter turn, which is well past the
  // 18 degree cap, so nothing usable is lost.
  for (let a = -Math.PI; a <= Math.PI; a += 0.05) {
    assert.ok(Math.abs(removeOrientationOffset(a)) <= q / 2 + 1e-9);
  }
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


test('screen heading follows the glass normal and is unavailable face-up', () => {
  assert.ok(Math.abs(deg(computeScreenHeading({ alpha: 25, beta: 90, gamma: 0 })) - 25) < 1e-9);
  const alpha = 15;
  const beta = 55;
  const gamma = 18;
  const a = alpha * Math.PI / 180;
  const b = beta * Math.PI / 180;
  const g = gamma * Math.PI / 180;
  const normalX = Math.cos(a) * Math.sin(g) + Math.sin(a) * Math.sin(b) * Math.cos(g);
  const normalY = Math.sin(a) * Math.sin(g) - Math.cos(a) * Math.sin(b) * Math.cos(g);
  assert.ok(Math.abs(computeScreenHeading({ alpha, beta, gamma })
    - Math.atan2(normalX, -normalY)) < 1e-12);
  assert.equal(computeScreenHeading({ alpha: 0, beta: 0, gamma: 0 }), null);
});


test('the gravity filter damps all three axes and ignores malformed events', () => {
  const filter = createGravityFilter({ timeConstantMs: 1000 });
  assert.deepEqual(filter.update({ x: 0, y: G, z: 0 }, 0), { x: 0, y: G, z: 0 });
  const damped = filter.update({ x: G, y: 0, z: G }, 100);
  assert.ok(damped.x > 0 && damped.x < G * 0.2);
  assert.ok(damped.y > G * 0.8 && damped.y < G);
  assert.ok(damped.z > 0 && damped.z < G * 0.2);
  assert.deepEqual(filter.update({ x: Number.NaN, y: G, z: 0 }, 200), damped);
});


test('the tracker suppresses tiny gravity jitter but accumulates slow motion', async () => {
  const listeners = new Map();
  const target = {
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
  };
  const held = (degrees) => ({
    x: -G * Math.sin((degrees * Math.PI) / 180),
    y: G * Math.cos((degrees * Math.PI) / 180),
    z: 0,
  });
  let timestamp = 0;
  const published = [];
  const tracker = createTiltTracker({
    target,
    now: () => timestamp,
    gravityTimeConstantMs: 1,
    gravityDeadbandRad: (0.5 * Math.PI) / 180,
    onRoll: (_roll, reading) => published.push(reading),
  });
  await tracker.start();
  listeners.get('devicemotion')({ accelerationIncludingGravity: held(0) });
  timestamp = 500;
  listeners.get('devicemotion')({ accelerationIncludingGravity: held(0.1) });
  assert.equal(published.length, 1);
  timestamp = 1000;
  listeners.get('devicemotion')({ accelerationIncludingGravity: held(1) });
  assert.equal(published.length, 2);
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

  // The raw inputs are kept so a device can be read rather than reasoned about.
  assert.deepEqual(tracker.getReading(), { x: G, y: 0, z: 0, screenAngle: 0 });
  // 90 degrees of orientation is removed, leaving no roll.
  assert.ok(Math.abs(deg(tracker.getRawRoll())) < 1e-6);

  // A reading with no usable in-plane component must be ignored, not reported.
  const before = rolls.length;
  listeners.get('devicemotion')({ accelerationIncludingGravity: { x: 0, y: 0, z: G } });
  assert.equal(rolls.length, before);

  tracker.stop();
  assert.equal(tracker.running, false);
  assert.equal(listeners.has('devicemotion'), false);
  assert.equal(listeners.has('deviceorientation'), false);
  assert.equal(tracker.getRoll(), null);
  assert.equal(tracker.getHeading(), null);
});


test('orientation recenter keeps listeners active and takes fresh sensor samples', async () => {
  const listeners = new Map();
  const target = {
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
  };
  let motionPermissionRequests = 0;
  let orientationPermissionRequests = 0;
  let timestamp = 0;
  const gravityReadings = [];
  const headings = [];
  const tracker = createTiltTracker({
    target,
    now: () => timestamp,
    gravityTimeConstantMs: 1000,
    motionEvent: {
      requestPermission: async () => {
        motionPermissionRequests += 1;
        return 'granted';
      },
    },
    orientationEvent: {
      requestPermission: async () => {
        orientationPermissionRequests += 1;
        return 'granted';
      },
    },
    onRoll: (_roll, reading) => gravityReadings.push(reading),
    onHeading: (heading) => headings.push(heading),
  });
  assert.equal(await tracker.start(), 'granted');
  listeners.get('devicemotion')({
    accelerationIncludingGravity: { x: 0, y: G, z: 0 },
  });
  listeners.get('deviceorientation')({ alpha: 10, beta: 90, gamma: 0 });

  tracker.recenter({ settleMs: DEFAULT_ORIENTATION_SETTLE_MS });
  assert.equal(tracker.running, true);
  assert.equal(listeners.has('devicemotion'), true);
  assert.equal(listeners.has('deviceorientation'), true);
  assert.equal(motionPermissionRequests, 1);
  assert.equal(orientationPermissionRequests, 1);
  assert.equal(tracker.getReading(), null);
  assert.equal(tracker.getSmoothedReading(), null);
  assert.equal(tracker.getRoll(), null);
  assert.equal(tracker.getHeading(), null);

  // Samples produced while the hand/display is still completing the quarter
  // turn must not become the new reference.
  timestamp = DEFAULT_ORIENTATION_SETTLE_MS - 1;
  listeners.get('devicemotion')({
    accelerationIncludingGravity: { x: -G * 0.8, y: G * 0.2, z: 0 },
  });
  listeners.get('deviceorientation')({ alpha: 80, beta: 90, gamma: 0 });
  assert.equal(tracker.getSmoothedReading(), null);
  assert.equal(tracker.getHeading(), null);

  // The first landscape samples must be taken directly, not blended with the
  // old portrait vector/heading that lived in a different screen frame.
  timestamp = DEFAULT_ORIENTATION_SETTLE_MS;
  listeners.get('devicemotion')({
    accelerationIncludingGravity: { x: -G, y: 0, z: 0 },
  });
  listeners.get('deviceorientation')({ alpha: 100, beta: 90, gamma: 0 });
  assert.deepEqual(gravityReadings.at(-1), { x: -G, y: 0, z: 0, screenAngle: 0 });
  assert.ok(Math.abs(deg(headings.at(-1)) - 100) < 1e-9);
  tracker.stop();
});


test('heading is smoothed across wrapping and optional permission can be denied', async () => {
  const listeners = new Map();
  const target = {
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
  };
  let timestamp = 0;
  const headings = [];
  const tracker = createTiltTracker({
    target,
    now: () => timestamp,
    headingTimeConstantMs: 1000,
    headingDeadbandRad: 0,
    onHeading: (heading) => headings.push(heading),
  });
  await tracker.start();
  listeners.get('deviceorientation')({ alpha: 359, beta: 90, gamma: 0 });
  timestamp = 100;
  listeners.get('deviceorientation')({ alpha: 1, beta: 90, gamma: 0 });
  assert.equal(headings.length, 2);
  assert.ok(Math.abs(deg(wrapAngle(headings[1] - headings[0]))) < 1);
  tracker.stop();

  const gravityOnly = createTiltTracker({
    target,
    motionEvent: { requestPermission: async () => 'granted' },
    orientationEvent: { requestPermission: async () => 'denied' },
  });
  assert.equal(await gravityOnly.start(), 'granted');
  assert.equal(listeners.has('devicemotion'), true);
  assert.equal(listeners.has('deviceorientation'), false);
  gravityOnly.stop();
});


test('orientation-only yaw remains active when motion permission is refused', async () => {
  const listeners = new Map();
  const headings = [];
  const tracker = createTiltTracker({
    target: {
      addEventListener: (type, handler) => listeners.set(type, handler),
      removeEventListener: (type) => listeners.delete(type),
    },
    screen: { orientation: { angle: 0 } },
    motionEvent: { requestPermission: async () => 'denied' },
    orientationEvent: { requestPermission: async () => 'granted' },
    onHeading: (heading) => headings.push(heading),
  });
  assert.equal(await tracker.start(), 'denied');
  assert.equal(tracker.running, true);
  assert.equal(listeners.has('devicemotion'), false);
  assert.equal(listeners.has('deviceorientation'), true);
  listeners.get('deviceorientation')({ alpha: 20, beta: 90, gamma: 0 });
  assert.equal(headings.length, 1);
  tracker.stop();
  assert.equal(listeners.has('deviceorientation'), false);
});


test('refusing both sensor permissions leaves the tracker stopped', async () => {
  const tracker = createTiltTracker({
    target: { addEventListener: () => {}, removeEventListener: () => {} },
    motionEvent: { requestPermission: async () => 'denied' },
    orientationEvent: { requestPermission: async () => 'denied' },
  });
  assert.equal(await tracker.start(), 'denied');
  assert.equal(tracker.running, false);
});


test('platforms without a permission gate report granted', async () => {
  assert.equal(await requestTiltPermission({ motionEvent: undefined }), 'granted');
  assert.equal(await requestTiltPermission({
    motionEvent: { requestPermission: async () => { throw new Error('blocked'); } },
  }), 'denied');
  assert.equal(await requestOrientationPermission({ orientationEvent: undefined }), 'granted');
  assert.equal(await requestOrientationPermission({
    orientationEvent: { requestPermission: async () => { throw new Error('blocked'); } },
  }), 'denied');
});
