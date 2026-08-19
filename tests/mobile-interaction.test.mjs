import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_INSPECTION_ANGLE,
  MAX_TOUCH_SCALE,
  MIN_TOUCH_SCALE,
  applyDrag,
  applyPinchPan,
  createInteractionState,
  createTouchInteraction,
} from '../webapp/src/mobile-interaction.js';


test('one-finger drag maps to yaw/pitch with a ±30 degree clamp', () => {
  const start = createInteractionState();
  const moved = applyDrag(start, 100, -50);
  assert.ok(moved.yaw > 0);
  assert.ok(moved.pitch < 0);

  const clamped = applyDrag(start, 10000, -10000);
  assert.equal(clamped.yaw, MAX_INSPECTION_ANGLE);
  assert.equal(clamped.pitch, -MAX_INSPECTION_ANGLE);
  assert.equal(clamped.scale, 1);
});


test('two-finger gesture applies uniform scale and centroid pan', () => {
  const changed = applyPinchPan(createInteractionState(), {
    startDistance: 100,
    currentDistance: 150,
    deltaCenterX: 60,
    deltaCenterY: -30,
    viewportHeight: 600,
  });
  assert.equal(changed.scale, 1.5);
  assert.equal(changed.panX, 0.2);
  assert.equal(changed.panY, 0.1);
  assert.equal(changed.yaw, 0);
  assert.equal(changed.pitch, 0);
});


test('pinch scale clamps and invalid zero distance remains stable', () => {
  const maximum = applyPinchPan(createInteractionState(), {
    startDistance: 1,
    currentDistance: 100,
    deltaCenterX: 0,
    deltaCenterY: 0,
    viewportHeight: 1,
  });
  assert.equal(maximum.scale, MAX_TOUCH_SCALE);

  const minimum = applyPinchPan(createInteractionState(), {
    startDistance: 100,
    currentDistance: 1,
    deltaCenterX: 0,
    deltaCenterY: 0,
    viewportHeight: 1,
  });
  assert.equal(minimum.scale, MIN_TOUCH_SCALE);

  const unchanged = applyPinchPan(createInteractionState({ scale: 1.2 }), {
    startDistance: 0,
    currentDistance: 50,
    deltaCenterX: 0,
    deltaCenterY: 0,
    viewportHeight: 0,
  });
  assert.equal(unchanged.scale, 1.2);
});


test('orientation-style cancellation drops stale pointers and accepts a fresh gesture', () => {
  const target = new EventTarget();
  target.clientHeight = 800;
  target.setPointerCapture = () => {};
  const interaction = createTouchInteraction(target);
  const pointer = (type, pointerId, clientX, clientY) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId, clientX, clientY });
    target.dispatchEvent(event);
  };

  pointer('pointerdown', 1, 100, 100);
  interaction.cancelGesture();
  pointer('pointermove', 1, 400, 400);
  assert.deepEqual(interaction.getState(), createInteractionState());

  pointer('pointerdown', 2, 100, 100);
  pointer('pointermove', 2, 180, 100);
  assert.ok(interaction.getState().yaw > 0);
  interaction.destroy();
});
