import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeEyeViewMatrix,
  computeMobileModelPlacement,
  computeOffAxisProjection,
  computeVirtualScreen,
  keepModelBehindEye,
  sanitizeEye,
  transformBounds,
} from '../webapp/src/head-coupled-projection.js';
import { mat4 } from '../webapp/src/rendering.js';


const centeredOptions = {
  eye: { x: 0, y: 0, z: 2.5 },
  screenHalfWidth: 1.5,
  screenHalfHeight: 1,
  near: 0.05,
  far: 20,
};


test('centered eye produces a symmetric frustum', () => {
  const result = computeOffAxisProjection(centeredOptions);
  assert.equal(result.frustum.left, -result.frustum.right);
  assert.equal(result.frustum.bottom, -result.frustum.top);
  assert.equal(result.projectionMatrix[8], 0);
  assert.equal(result.projectionMatrix[9], 0);
});


test('positive eye X shifts the frustum without rotating the model', () => {
  const centered = computeOffAxisProjection(centeredOptions);
  const shifted = computeOffAxisProjection({
    ...centeredOptions,
    eye: { x: 0.4, y: 0, z: 2.5 },
  });
  assert.ok(shifted.frustum.left < centered.frustum.left);
  assert.ok(shifted.frustum.right < centered.frustum.right);
  assert.ok(shifted.projectionMatrix[8] < 0);
});


function projectPointX(point, eye) {
  const { projectionMatrix } = computeOffAxisProjection({
    ...centeredOptions,
    eye,
  });
  const viewProjection = mat4.multiply(projectionMatrix, computeEyeViewMatrix(eye));
  const [x, y, z] = point;
  const clipX = viewProjection[0] * x + viewProjection[4] * y
    + viewProjection[8] * z + viewProjection[12];
  const clipW = viewProjection[3] * x + viewProjection[7] * y
    + viewProjection[11] * z + viewProjection[15];
  return clipX / clipW;
}


test('the display plane separates natural behind-glass parallax from reversed pop-out parallax', () => {
  const shiftedEye = { x: 0.3, y: 0, z: 2.5 };
  const behind = projectPointX([0, 0, -0.5], shiftedEye);
  const onGlass = projectPointX([0, 0, 0], shiftedEye);
  const inFront = projectPointX([0, 0, 0.5], shiftedEye);
  assert.ok(behind > 0, 'behind-glass geometry should move with a rightward eye');
  assert.ok(Math.abs(onGlass) < 1e-6, 'geometry on the glass should remain stationary');
  assert.ok(inFront < 0, 'pop-out geometry reverses the apparent motion direction');
});


test('a closer eye sees a larger angular screen extent', () => {
  const baseline = computeOffAxisProjection(centeredOptions);
  const closer = computeOffAxisProjection({
    ...centeredOptions,
    eye: { x: 0, y: 0, z: 1.25 },
  });
  assert.ok(Math.abs(closer.frustum.left) > Math.abs(baseline.frustum.left));
  assert.ok(closer.frustum.top > baseline.frustum.top);
});


test('invalid eye Z is rejected and small positive Z is clamped', () => {
  assert.throws(
    () => computeOffAxisProjection({ ...centeredOptions, eye: { x: 0, y: 0, z: 0 } }),
    /eye\.z must be positive/,
  );
  assert.equal(sanitizeEye({ x: 0, y: 0, z: 0.01 }).z, 0.2);
});


test('eye view matrix is only the inverse eye translation', () => {
  const view = computeEyeViewMatrix({ x: 0.4, y: -0.2, z: 2.5 });
  assert.ok(Math.abs(view[12] + 0.4) < 1e-6);
  assert.ok(Math.abs(view[13] - 0.2) < 1e-6);
  assert.equal(view[14], -2.5);
  assert.equal(view[15], 1);
  assert.deepEqual([...view.slice(0, 12)], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
});


test('virtual screen keeps height 2 and derives width from viewport aspect', () => {
  assert.deepEqual(computeVirtualScreen(1.5), {
    width: 3,
    height: 2,
    halfWidth: 1.5,
    halfHeight: 1,
  });
});


const modelBounds = {
  min: [-2, -1, -4],
  max: [2, 1, -1],
};


test('mobile placement uses a uniform fit and puts nearest Z at frontOffset', () => {
  const placement = computeMobileModelPlacement({
    bounds: modelBounds,
    screenWidth: 4,
    screenHeight: 2,
    baselineEyeZ: 2.5,
    frontOffset: 0.05,
    occupancy: 0.5,
  });
  assert.equal(placement.scale, 0.5);
  assert.equal(placement.modelMatrix[0], placement.modelMatrix[5]);
  assert.equal(placement.modelMatrix[5], placement.modelMatrix[10]);
  assert.ok(Math.abs(placement.transformedBounds.max[2] - 0.05) < 1e-6);
  assert.deepEqual(placement.transformedBounds.min.slice(0, 2), [-1, -0.5]);
  assert.deepEqual(placement.transformedBounds.max.slice(0, 2), [1, 0.5]);
});


test('default mobile placement anchors the nearest surface to the display glass', () => {
  const placement = computeMobileModelPlacement({
    bounds: modelBounds,
    screenWidth: 4,
    screenHeight: 2,
    baselineEyeZ: 2.5,
    occupancy: 0.5,
  });
  assert.equal(placement.frontOffset, 0);
  assert.ok(Math.abs(placement.transformedBounds.max[2]) < 1e-6);
});


test('zero frontOffset stays on the display and a positive offset pops toward viewer', () => {
  const common = {
    bounds: modelBounds,
    screenWidth: 4,
    screenHeight: 2,
    baselineEyeZ: 2.5,
    occupancy: 0.5,
  };
  const atScreen = computeMobileModelPlacement({ ...common, frontOffset: 0 });
  const popped = computeMobileModelPlacement({ ...common, frontOffset: 0.08 });
  assert.ok(Math.abs(atScreen.transformedBounds.max[2]) < 1e-6);
  assert.ok(popped.transformedBounds.max[2] > atScreen.transformedBounds.max[2]);
});


test('frontOffset is clamped for the minimum supported eye distance', () => {
  const placement = computeMobileModelPlacement({
    bounds: modelBounds,
    screenWidth: 4,
    screenHeight: 2,
    baselineEyeZ: 2.5,
    frontOffset: 1,
    occupancy: 0.5,
    near: 0.05,
    minSupportedEyeZ: 0.8,
  });
  assert.ok(Math.abs(placement.frontOffset - 0.7) < 1e-6);
});


test('transformed bounds cover all rotated corners', () => {
  const rotated = new Float32Array([
    0, 1, 0, 0,
    -1, 0, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
  assert.deepEqual(transformBounds({ min: [-2, -1, 0], max: [2, 1, 0] }, rotated), {
    min: [-1, -2, 0],
    max: [1, 2, 0],
  });
});


test('clip safety rigidly moves an unsafe model behind the eye near plane', () => {
  const unsafeMatrix = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 2.49, 1,
  ]);
  const safe = keepModelBehindEye({
    bounds: { min: [-1, -1, 0], max: [1, 1, 0] },
    modelMatrix: unsafeMatrix,
    eye: { x: 0, y: 0, z: 2.5 },
    near: 0.05,
    gap: 0.02,
  });
  assert.ok(safe.correctionZ < 0);
  assert.ok(safe.transformedBounds.max[2] <= 2.43 + 1e-6);
  assert.equal(safe.modelMatrix[0], 1);
  assert.equal(safe.modelMatrix[5], 1);
  assert.equal(safe.modelMatrix[10], 1);
});
