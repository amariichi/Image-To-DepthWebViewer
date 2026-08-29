import assert from 'node:assert/strict';
import test from 'node:test';

import { mat4 } from '../webapp/src/rendering.js';
import {
  DEFAULT_LEVELLING_GAIN,
  MAX_LEVELLING_RAD,
  TRUE_WINDOW_LEVELLING_GAIN,
  TRUE_WINDOW_PITCH_GAIN,
  TRUE_WINDOW_PITCH_MAX_RAD,
  computeLevelling,
  computeYawDecoupledLevelling,
  counterRotateEye,
  quaternionToMatrix,
  eyeInYawReferenceFrame,
  referencedEyeForDevicePose,
  rotateVectorByQuaternion,
  sceneYawForDevice,
  sceneRotationForDevicePose,
  sceneRotationForMode,
  screenYawForGravityAttitude,
  toQuaternion,
  trueWindowPitchRotation,
  upInDeviceFrame,
} from '../webapp/src/mobile-levelling.js';

const G = 9.81;
const rad = (degrees) => (degrees * Math.PI) / 180;
const deg = (radians) => (radians * 180) / Math.PI;
const rolled = (degrees) => ({
  x: -G * Math.sin(rad(degrees)),
  y: G * Math.cos(rad(degrees)),
  z: 0,
});
const tippedBack = (degrees) => ({
  x: 0,
  y: G * Math.cos(rad(degrees)),
  z: G * Math.sin(rad(degrees)),
});
const posed = (rollDegrees, tipDegrees) => ({
  x: -G * Math.sin(rad(rollDegrees)) * Math.cos(rad(tipDegrees)),
  y: G * Math.cos(rad(rollDegrees)) * Math.cos(rad(tipDegrees)),
  z: G * Math.sin(rad(tipDegrees)),
});
const aroundAxis = (vector, axis, degrees) => {
  const angle = rad(degrees);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const magnitude = Math.hypot(axis.x, axis.y, axis.z);
  const x = axis.x / magnitude;
  const y = axis.y / magnitude;
  const z = axis.z / magnitude;
  const dot = x * vector.x + y * vector.y + z * vector.z;
  return {
    x: vector.x * cosine + (y * vector.z - z * vector.y) * sine
      + x * dot * (1 - cosine),
    y: vector.y * cosine + (z * vector.x - x * vector.z) * sine
      + y * dot * (1 - cosine),
    z: vector.z * cosine + (x * vector.y - y * vector.x) * sine
      + z * dot * (1 - cosine),
  };
};
const aroundScreenY = (vector, degrees) => aroundAxis(vector, { x: 0, y: 1, z: 0 }, degrees);

test('Hold level is reference-relative for upright, tipped and rolled postures', () => {
  for (const posture of [tippedBack(0), tippedBack(30), tippedBack(55), rolled(20)]) {
    assert.equal(computeLevelling(posture, { reference: upInDeviceFrame(posture) }), null);
  }
  const reference = upInDeviceFrame(tippedBack(45));
  assert.ok(Math.abs(deg(computeLevelling(tippedBack(49), { reference }).tip) - 2) < 1e-6);
});

test('roll and tip retain separate signs, gains and finite-scene limits', () => {
  const upright = upInDeviceFrame(tippedBack(0));
  const roll = computeLevelling(rolled(20), { reference: upright });
  const back = computeLevelling(tippedBack(30), { reference: upright });
  assert.ok(Math.abs(deg(roll.roll) - 10) < 1e-6);
  assert.equal(Math.sign(back.tip), 1);
  assert.equal(DEFAULT_LEVELLING_GAIN, 0.5);
  assert.ok(Math.abs(computeLevelling(rolled(80), { reference: upright }).roll)
    <= MAX_LEVELLING_RAD);
  assert.equal(computeLevelling(rolled(20), { reference: upright, gain: 0 }), null);
});

test('True Window uses full pitch and roll while retaining the 18 degree cap', () => {
  const upright = upInDeviceFrame(tippedBack(0));
  const ordinary = computeLevelling(tippedBack(12), {
    reference: upright,
    gain: TRUE_WINDOW_LEVELLING_GAIN,
  });
  const capped = computeLevelling(tippedBack(40), {
    reference: upright,
    gain: TRUE_WINDOW_LEVELLING_GAIN,
  });
  assert.ok(Math.abs(deg(ordinary.tip) - 12) < 1e-6);
  assert.ok(Math.abs(deg(capped.tip) - 18) < 1e-6);
});

test('runtime damps True Window pitch and roll independently', () => {
  const levelling = computeLevelling(posed(16, 12), {
    reference: upInDeviceFrame(tippedBack(0)),
    rollGain: DEFAULT_LEVELLING_GAIN,
    tipGain: TRUE_WINDOW_PITCH_GAIN,
    tipMaxAngle: TRUE_WINDOW_PITCH_MAX_RAD,
  });
  assert.ok(Math.abs(deg(levelling.roll) - 8) < 1e-6);
  assert.ok(Math.abs(deg(levelling.tip) - 6) < 1e-6);

  const capped = computeLevelling(tippedBack(40), {
    reference: upInDeviceFrame(tippedBack(0)),
    tipGain: TRUE_WINDOW_PITCH_GAIN,
    tipMaxAngle: TRUE_WINDOW_PITCH_MAX_RAD,
  });
  assert.ok(Math.abs(deg(capped.tip) - 9) < 1e-6);
});

test('Hold removes only gravity tilt explained by a screen-Y turn', () => {
  const referenceGravity = tippedBack(35);
  const reference = upInDeviceFrame(referenceGravity);
  const screenYaw = rad(20);
  const yawedGravity = aroundScreenY(referenceGravity, -20);
  const raw = computeLevelling(yawedGravity, { reference });
  assert.ok(Math.abs(raw.roll) > rad(4), 'gravity alone mistakes screen-Y motion for roll');
  assert.equal(computeYawDecoupledLevelling(yawedGravity, {
    reference,
    screenYaw,
  }), null, 'heading-explained screen-Y motion must remain horizontal');
  assert.equal(computeYawDecoupledLevelling(yawedGravity, {
    reference,
    screenYaw: -screenYaw,
  }), null, 'screen-heading sign differences must not restore the diagonal tilt');

  const genuinelyRolled = posed(12, 35);
  const rolledAndYawed = aroundScreenY(genuinelyRolled, -20);
  const expected = computeLevelling(genuinelyRolled, { reference });
  const recovered = computeYawDecoupledLevelling(rolledAndYawed, {
    reference,
    screenYaw,
  });
  assert.ok(Math.abs(recovered.roll - expected.roll) < 1e-9);
  assert.ok(Math.abs(recovered.tip - expected.tip) < 1e-9);

  assert.equal(computeYawDecoupledLevelling(referenceGravity, {
    reference,
    screenYaw,
  }), null, 'heading drift with unchanged gravity must not create tilt');
});

test('landscape derives screen up from the reference instead of assuming device Y', () => {
  const tip = rad(35);
  const unrolledReference = {
    x: G * Math.cos(tip),
    y: 0,
    z: G * Math.sin(tip),
  };
  // A small initial hand roll is part of the accepted reference posture. It
  // must not rotate the inferred screen-up axis away from landscape device X.
  const referenceGravity = aroundAxis(unrolledReference, { x: 0, y: 0, z: 1 }, 12);
  const reference = upInDeviceFrame(referenceGravity);
  const screenYaw = rad(20);
  const yawedGravity = aroundAxis(referenceGravity, { x: 1, y: 0, z: 0 }, -20);
  const raw = computeLevelling(yawedGravity, { reference });
  assert.ok(
    Math.max(Math.abs(raw.roll), Math.abs(raw.tip)) > rad(4),
    'fixed device-axis levelling mistakes the landscape screen-up turn for tilt',
  );
  assert.equal(computeYawDecoupledLevelling(yawedGravity, {
    reference,
    screenYaw,
  }), null, 'the reference-derived landscape screen-up axis must keep the turn horizontal');
  assert.equal(computeYawDecoupledLevelling(yawedGravity, {
    reference,
    screenYaw: -screenYaw,
  }), null, 'landscape heading sign differences must remain harmless');
});

test('gravity heading decoupling follows the attitude lifetime of each mode', () => {
  const yaw = rad(17);
  assert.equal(screenYawForGravityAttitude(yaw, {
    trueWindow: true,
    holdLevel: false,
  }), yaw, 'True Window keeps pitch with Hold off and must still separate screen-up turns');
  assert.equal(screenYawForGravityAttitude(yaw, {
    trueWindow: false,
    holdLevel: true,
  }), yaw, 'photo Hold uses heading only to keep its roll horizontal');
  assert.equal(screenYawForGravityAttitude(yaw, {
    trueWindow: false,
    holdLevel: false,
  }), 0, 'photo Hold off remains the accepted camera-only path');
});

test('invalid or acceleration-only gravity produces no attitude', () => {
  assert.equal(upInDeviceFrame({ x: 0.1, y: 0.2, z: 0.1 }), null);
  assert.equal(computeLevelling({ x: Number.NaN, y: G, z: 0 }), null);
  assert.equal(computeLevelling(null), null);
});

test('the composed quaternion and matrix rotate vectors identically', () => {
  const attitude = toQuaternion({ roll: rad(13), tip: rad(-9) });
  assert.ok(Math.abs(Math.hypot(attitude.x, attitude.y, attitude.z, attitude.w) - 1) < 1e-12);
  const vector = { x: 0.25, y: 1, z: -0.4 };
  const byQuaternion = rotateVectorByQuaternion(vector, attitude);
  const byMatrix = mat4.transformPoint(quaternionToMatrix(attitude), [vector.x, vector.y, vector.z]);
  assert.ok(Math.abs(byQuaternion.x - byMatrix[0]) < 1e-6);
  assert.ok(Math.abs(byQuaternion.y - byMatrix[1]) < 1e-6);
  assert.ok(Math.abs(byQuaternion.z - byMatrix[2]) < 1e-6);
});

test('True Window flips tip only and photo mode keeps roll only', () => {
  const levelling = { roll: rad(11), tip: rad(8) };
  const attitude = toQuaternion(levelling);
  const trueWindow = sceneRotationForMode(attitude, { trueWindow: true });
  const expectedTrue = toQuaternion({ roll: levelling.roll, tip: -levelling.tip });
  const photo = sceneRotationForMode(attitude, { trueWindow: false });
  const expectedPhoto = toQuaternion({ roll: levelling.roll, tip: 0 });
  for (const key of ['x', 'y', 'z', 'w']) {
    assert.ok(Math.abs(trueWindow[key] - expectedTrue[key]) < 1e-12);
    assert.ok(Math.abs(photo[key] - expectedPhoto[key]) < 1e-12);
  }
});

test('True Window scene up follows measured roll in both directions', () => {
  const upright = upInDeviceFrame(tippedBack(0));
  for (const degrees of [-15, -10, 10, 15]) {
    const reading = rolled(degrees);
    const attitude = toQuaternion(computeLevelling(reading, {
      reference: upright,
      gain: TRUE_WINDOW_LEVELLING_GAIN,
    }));
    const scene = sceneRotationForMode(attitude, { trueWindow: true });
    const modelUp = rotateVectorByQuaternion({ x: 0, y: 1, z: 0 }, scene);
    const measuredUp = upInDeviceFrame(reading);
    assert.ok(Math.abs(modelUp.x - measuredUp.x) < 1e-9);
    assert.ok(Math.abs(modelUp.y - measuredUp.y) < 1e-9);
  }
});

test('counter-rotation removes phone attitude but preserves real translation', () => {
  const upright = upInDeviceFrame(tippedBack(0));
  const attitude = toQuaternion(computeLevelling({ x: -G * 0.25, y: G * 0.9, z: G * 0.35 }, {
    reference: upright,
    gain: TRUE_WINDOW_LEVELLING_GAIN,
  }));
  const baseline = { x: 0, y: 0, z: 6 };
  const moved = { x: 0.4, y: -0.25, z: 5.7 };
  const fusedBaseline = counterRotateEye(rotateVectorByQuaternion(baseline, attitude), attitude);
  const fusedMoved = counterRotateEye(rotateVectorByQuaternion(moved, attitude), attitude);
  assert.ok(Math.abs((fusedMoved.x - fusedBaseline.x) - 0.4) < 1e-10);
  assert.ok(Math.abs((fusedMoved.y - fusedBaseline.y) + 0.25) < 1e-10);
  assert.ok(Math.abs((fusedMoved.z - fusedBaseline.z) + 0.3) < 1e-10);
  assert.deepEqual(counterRotateEye(moved, null), moved);
});

test('Hold never rotates the hybrid camera eye into an orbit', () => {
  const eye = { x: 0.42, y: -0.27, z: 5.8 };
  const rollOnly = toQuaternion({ roll: rad(14), tip: 0 });
  assert.deepEqual(referencedEyeForDevicePose(eye, {
    attitude: rollOnly,
    trueWindow: true,
    holdLevel: true,
  }), eye);

  const combined = toQuaternion({ roll: rad(14), tip: rad(9) });
  const fused = referencedEyeForDevicePose(eye, {
    attitude: combined,
    trueWindow: true,
    holdLevel: true,
  });
  const supersededFullCounterRotation = counterRotateEye(eye, combined);
  assert.deepEqual(fused, eye);
  assert.ok(Math.hypot(
    fused.x - supersededFullCounterRotation.x,
    fused.y - supersededFullCounterRotation.y,
    fused.z - supersededFullCounterRotation.z,
  ) > 0.1);
});

test('sensor heading never becomes a model turntable rotation', () => {
  for (const trueWindow of [false, true]) {
    assert.equal(sceneRotationForDevicePose(null, {
      yaw: rad(30),
      trueWindow,
      holdLevel: false,
    }), null);
  }
  const eye = { x: 0.45, y: -0.1, z: 5.8 };
  assert.deepEqual(referencedEyeForDevicePose(eye, {
    yaw: rad(-30),
    trueWindow: true,
    holdLevel: false,
  }), eye);
});

test('True Window pitch survives Hold off while Hold still owns roll', () => {
  const attitude = toQuaternion({ roll: rad(8), tip: rad(11) });
  // Roll leaves the forward axis unchanged, so use screen-up to prove that
  // Hold level contributes its gravity rotation while Hold off remains flat.
  const screenUp = { x: 0, y: 1, z: 0 };
  const photoWithHold = sceneRotationForDevicePose(attitude, {
    trueWindow: false,
    holdLevel: true,
  });
  const photoWithoutHold = sceneRotationForDevicePose(attitude, {
    trueWindow: false,
    holdLevel: false,
  });
  assert.equal(photoWithoutHold, null);
  assert.notDeepEqual(
    rotateVectorByQuaternion(screenUp, photoWithHold),
    rotateVectorByQuaternion(screenUp, photoWithoutHold),
  );
  const trueWindowWithoutHold = sceneRotationForDevicePose(attitude, {
    trueWindow: true,
    holdLevel: false,
  });
  const expectedPitch = toQuaternion({ roll: 0, tip: rad(-11) });
  for (const key of ['x', 'y', 'z', 'w']) {
    assert.ok(Math.abs(trueWindowWithoutHold[key] - expectedPitch[key]) < 1e-12);
  }
  assert.equal(trueWindowWithoutHold.z, 0);
  assert.deepEqual(trueWindowPitchRotation(null), null);
});


test('a turned phone puts a stationary observer off the glass normal', () => {
  // The eye is reported in camera coordinates, so a phone turned by `yaw` sees
  // an observer who has not moved as though they had slid sideways. What the
  // window needs is where that observer is relative to the glass, which is
  // about z*sin(yaw) to one side.
  const eye = { x: 0, y: 0, z: 5 };
  for (const degrees of [-20, -8, 8, 20]) {
    const yaw = rad(degrees);
    const moved = referencedEyeForDevicePose(eye, { relativeYaw: yaw });
    assert.ok(Math.abs(moved.x - eye.z * Math.sin(yaw)) < 1e-9);
    assert.ok(Math.abs(moved.y) < 1e-9);
    // The distance to the glass is unchanged: the observer went round it, not
    // towards it.
    assert.ok(Math.abs(Math.hypot(moved.x, moved.z) - eye.z) < 1e-9);
  }
});

test('the scene turns against the phone, so the room stays still', () => {
  for (const degrees of [-30, -5, 5, 30]) {
    const yaw = rad(degrees);
    // A point fixed in the room, expressed in the turned phone frame, then
    // carried back by moving the eye into the same reference: the two turns
    // cancel, which is what "the world stayed where it was" means.
    const fixed = { x: 0.4, y: -0.2, z: 3 };
    const inPhoneFrame = rotateVectorByQuaternion(fixed, sceneYawForDevice(yaw));
    const backAgain = eyeInYawReferenceFrame(inPhoneFrame, yaw);
    assert.ok(Math.hypot(
      backAgain.x - fixed.x,
      backAgain.y - fixed.y,
      backAgain.z - fixed.z,
    ) < 1e-9);
  }
});

test('real head translation survives the heading frame change', () => {
  // Two eyes a known distance apart at the same yaw stay that distance apart:
  // the turn is removed from both, the movement between them is not.
  const yaw = rad(15);
  const still = referencedEyeForDevicePose({ x: 0, y: 0, z: 5 }, { relativeYaw: yaw });
  const moved = referencedEyeForDevicePose({ x: 0.3, y: 0.1, z: 5 }, { relativeYaw: yaw });
  assert.ok(Math.abs(Math.hypot(
    moved.x - still.x,
    moved.y - still.y,
    moved.z - still.z,
  ) - Math.hypot(0.3, 0.1)) < 1e-9);
});

test('an absent or unusable heading leaves the eye exactly where it was', () => {
  const eye = { x: 0.42, y: -0.27, z: 5.8 };
  assert.deepEqual(referencedEyeForDevicePose(eye), eye);
  assert.deepEqual(referencedEyeForDevicePose(eye, { relativeYaw: 0 }), eye);
  for (const yaw of [Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
    assert.deepEqual(eyeInYawReferenceFrame(eye, yaw), eye);
  }
});


test('a yaw correction that reverses an axis leaves the reading alone', () => {
  // Sweep the postures a hand actually produces. Before this, a correction
  // coming back with the opposite sign was read as "the turn explains all of
  // it" and the axis was snapped to zero, so a real tilt disappeared.
  const upright = upInDeviceFrame({ x: 0, y: G, z: 0 });
  const posture = (rollDeg, tipDeg) => {
    const r = rad(rollDeg);
    const t = rad(tipDeg);
    return {
      x: -G * Math.sin(r) * Math.cos(t),
      y: G * Math.cos(r) * Math.cos(t),
      z: G * Math.sin(t),
    };
  };
  for (const rollDeg of [-12, -4, 4, 12]) {
    for (const tipDeg of [-10, -3, 3, 10]) {
      for (const yawDeg of [2, 6, 12, 25, 40]) {
        const gravity = posture(rollDeg, tipDeg);
        const raw = computeLevelling(gravity, { reference: upright, gain: 1 });
        const out = computeYawDecoupledLevelling(gravity, {
          screenYaw: rad(yawDeg),
          reference: upright,
          gain: 1,
        });
        for (const axis of ['roll', 'tip']) {
          if (Math.abs(raw[axis]) < 1e-6) continue;
          assert.ok(
            Math.abs(out?.[axis] ?? 0) > 1e-9,
            `roll ${rollDeg} tip ${tipDeg} yaw ${yawDeg} erased ${axis}`,
          );
          // Still one-way: heading may only subtract the tilt it explains.
          assert.ok(Math.abs(out[axis]) <= Math.abs(raw[axis]) + 1e-12);
        }
      }
    }
  }
});
