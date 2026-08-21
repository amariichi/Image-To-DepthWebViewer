import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TRACKING_MIRROR_STORAGE_KEY,
  classifyViewport,
  DEFAULT_RENDER_THRESHOLDS,
  createRateMeter,
  createRenderGate,
  probeMotionCapabilities,
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


test('the motion capability probe reports what a device can actually offer', () => Promise.all([
  (async () => {
    // A device with visual-inertial tracking: position holds over time, so a
    // model can be left standing in the room and walked around.
    const capable = await probeMotionCapabilities({
      xr: { isSessionSupported: async (mode) => mode === 'immersive-ar' },
      orientationEvent: function DeviceOrientationEvent() {},
      motionEvent: function DeviceMotionEvent() {},
    });
    assert.equal(capable.immersiveAr, true);
    assert.equal(capable.needsMotionPermission, false);
  })(),
  (async () => {
    // iOS: orientation and motion exist but are gated behind a user gesture,
    // and there is no immersive-ar at all.
    const gated = function DeviceOrientationEvent() {};
    gated.requestPermission = async () => 'granted';
    const ios = await probeMotionCapabilities({
      xr: undefined,
      orientationEvent: gated,
      motionEvent: function DeviceMotionEvent() {},
    });
    assert.equal(ios.immersiveAr, false);
    assert.equal(ios.deviceOrientation, true);
    assert.equal(ios.needsMotionPermission, true);
  })(),
  (async () => {
    // A probe that throws must report no support rather than break the page.
    const hostile = await probeMotionCapabilities({
      xr: { isSessionSupported: async () => { throw new Error('denied'); } },
      orientationEvent: undefined,
      motionEvent: undefined,
    });
    assert.deepEqual(hostile, {
      immersiveAr: false,
      deviceOrientation: false,
      deviceMotion: false,
      needsMotionPermission: false,
    });
  })(),
]));


const baseInputs = {
  sceneId: 1,
  width: 402,
  height: 780,
  eyeX: 0, eyeY: 0, eyeZ: 4.6,
  roll: 0, yaw: 0, pitch: 0,
  panX: 0, panY: 0, scale: 1,
};


test('the first frame always draws, and an unchanged one never does', () => {
  const gate = createRenderGate();
  assert.equal(gate.shouldRender(baseInputs), true);
  gate.commit(baseInputs);

  // The eye pose only changes twenty times a second while an animation loop
  // runs at sixty: the frames in between are identical and must be skipped.
  assert.equal(gate.shouldRender({ ...baseInputs }), false);

  gate.reset();
  assert.equal(gate.shouldRender(baseInputs), true);
});


test('a movement too small to shift a pixel is skipped, a visible one is not', () => {
  const gate = createRenderGate();
  gate.commit(baseInputs);

  const belowThreshold = DEFAULT_RENDER_THRESHOLDS.eye / 2;
  assert.equal(gate.shouldRender({ ...baseInputs, eyeX: belowThreshold }), false);
  assert.equal(gate.shouldRender({ ...baseInputs, eyeX: DEFAULT_RENDER_THRESHOLDS.eye }), true);

  // Every input that moves the picture is watched.
  for (const [key, step] of [
    ['eyeY', DEFAULT_RENDER_THRESHOLDS.eye],
    ['eyeZ', DEFAULT_RENDER_THRESHOLDS.eye],
    ['roll', DEFAULT_RENDER_THRESHOLDS.roll],
    ['yaw', DEFAULT_RENDER_THRESHOLDS.angle],
    ['pitch', DEFAULT_RENDER_THRESHOLDS.angle],
    ['panX', DEFAULT_RENDER_THRESHOLDS.pan],
    ['panY', DEFAULT_RENDER_THRESHOLDS.pan],
  ]) {
    assert.equal(gate.shouldRender({ ...baseInputs, [key]: step }), true, `${key} was ignored`);
  }
  assert.equal(gate.shouldRender({ ...baseInputs, scale: 1 + DEFAULT_RENDER_THRESHOLDS.scale }), true);
});


test('a slow drift accumulates rather than being lost between checks', () => {
  // Comparing against the last drawn frame, not the last checked one, is what
  // stops a gradual head movement from being suppressed indefinitely.
  const gate = createRenderGate();
  gate.commit(baseInputs);
  const step = DEFAULT_RENDER_THRESHOLDS.eye / 4;
  let eyeX = 0;
  let drew = 0;
  for (let frame = 0; frame < 12; frame += 1) {
    eyeX += step;
    if (gate.shouldRender({ ...baseInputs, eyeX })) {
      drew += 1;
      gate.commit({ ...baseInputs, eyeX });
    }
  }
  assert.ok(drew >= 2, `a steady drift must keep drawing, drew ${drew}`);
  assert.ok(drew <= 4, `a sub-pixel drift must not draw every frame, drew ${drew}`);
});


test('replacing the scene or resizing always draws', () => {
  const gate = createRenderGate();
  gate.commit(baseInputs);
  assert.equal(gate.shouldRender({ ...baseInputs, sceneId: 2 }), true);
  assert.equal(gate.shouldRender({ ...baseInputs, width: 403 }), true);
  assert.equal(gate.shouldRender({ ...baseInputs, height: 781 }), true);
});


test('roll is held to a looser limit than yaw and pitch, because it moves less', () => {
  // Levelling rotates within the screen plane, moving a point by the image
  // radius times the angle and halved again by the levelling gain. Yaw and
  // pitch swing the deepest geometry instead, which is more than twenty times
  // as far for the same angle. Sharing one limit made ordinary hand tremor
  // exceed it on nearly every motion event, so the viewer redrew at the
  // sensor's rate rather than at the rate the picture changed.
  assert.ok(
    DEFAULT_RENDER_THRESHOLDS.roll > DEFAULT_RENDER_THRESHOLDS.angle * 10,
    'roll must be substantially looser than yaw and pitch',
  );

  const gate = createRenderGate();
  gate.commit(baseInputs);
  // A tremor-sized roll must not draw, while the same angle in yaw must.
  const tremor = DEFAULT_RENDER_THRESHOLDS.angle * 4;
  assert.equal(gate.shouldRender({ ...baseInputs, roll: tremor }), false);
  assert.equal(gate.shouldRender({ ...baseInputs, yaw: tremor }), true);

  // A roll big enough to shift a pixel still draws.
  assert.equal(gate.shouldRender({ ...baseInputs, roll: DEFAULT_RENDER_THRESHOLDS.roll }), true);
});
