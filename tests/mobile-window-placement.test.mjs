import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_TRUE_WINDOW_MODEL_SCALE,
  MIN_TRUE_WINDOW_MODEL_SCALE,
  captureTangentFromFov,
  clampCameraRayDepthFloor,
  computeSourceExactWindowPlacement,
  computeSourceOverviewFraming,
  computeTrueWindowPlacement,
  estimateCameraAxisDepthQuantile,
  focalLength35mmEquivalentFromVerticalFov,
  mapTrackedEyeAroundReference,
  mapTrackedEyeToCaptureApex,
  modelScaleForCaptureApex,
  preservePhysicalEye,
  trueWindowEyeResponse,
  trueWindowEyeResponseForRelief,
  trueWindowLateralEyeResponse,
} from '../webapp/src/mobile-window-placement.js';


test('capture FOV becomes the tangent of its vertical half-angle', () => {
  assert.ok(Math.abs(captureTangentFromFov(90) - 1) < 1e-12);
  assert.throws(() => captureTangentFromFov(0), /positive/);
  assert.throws(() => captureTangentFromFov(180), /below 180/);
});


test('photo eye mapping follows StereoSplatViewer with one XYZ scale and an approach bound', () => {
  const mapped = mapTrackedEyeToCaptureApex({
    eye: { x: 0.5, y: -0.25, z: 4 },
    nominalZ: 5,
    captureApex: 2,
  });
  assert.deepEqual(mapped, { x: 0.2, y: -0.1, z: 1.6 });
  const close = mapTrackedEyeToCaptureApex({
    eye: { x: 0, y: 0, z: 0.1 }, nominalZ: 5, captureApex: 2,
  });
  assert.equal(close.z, 1.2);
});


test('True Window keeps the exact neutral eye while damping XYZ displacement uniformly', () => {
  const response = trueWindowEyeResponse({ captureFovDeg: 60, referenceEyeZ: 5 });
  assert.ok(Math.abs(response - (1 / Math.tan(Math.PI / 6)) / 5) < 1e-12);
  const mapped = mapTrackedEyeAroundReference({
    eye: { x: 0.4, y: -0.2, z: 4 }, referenceZ: 5, response,
  });
  assert.ok(Math.abs(mapped.x / 0.4 - response) < 1e-12);
  assert.ok(Math.abs(mapped.y / -0.2 - response) < 1e-12);
  assert.ok(Math.abs((mapped.z - 5) / (4 - 5) - response) < 1e-12);
  assert.deepEqual(mapTrackedEyeAroundReference({
    eye: { x: 0, y: 0, z: 5 }, referenceZ: 5, response,
  }), { x: 0, y: 0, z: 5 });
});

test('True Window can restore lateral looking without changing its paired Y/Z response', () => {
  const mapped = mapTrackedEyeAroundReference({
    eye: { x: 0.4, y: -0.2, z: 4 },
    referenceZ: 5,
    response: 0.25,
    lateralResponse: 0.75,
  });
  assert.ok(Math.abs(mapped.x / 0.4 - 0.75) < 1e-12);
  assert.ok(Math.abs(mapped.y / -0.2 - 0.25) < 1e-12);
  assert.ok(Math.abs((mapped.z - 5) / (4 - 5) - 0.25) < 1e-12);
});

test('True Window adds a bounded orientation-aware gain only to lateral eye response', () => {
  const options = { captureFovDeg: 60, referenceEyeZ: 5 };
  const base = trueWindowEyeResponse(options);
  const portrait = trueWindowLateralEyeResponse(options);
  const landscape = trueWindowLateralEyeResponse({ ...options, orientation: 'landscape' });
  assert.ok(Math.abs(portrait / base - 2.4) < 1e-12);
  assert.ok(Math.abs(landscape / base - 2.88) < 1e-12);
  assert.ok(Math.abs(landscape / portrait - 1.2) < 1e-12);
  assert.equal(trueWindowLateralEyeResponse({ ...options, gain: 10 }), 1.5);
  assert.throws(
    () => mapTrackedEyeAroundReference({
      eye: { x: 0, y: 0, z: 5 },
      referenceZ: 5,
      response: 0.5,
      lateralResponse: 1.8001,
    }),
    /lateral eye response must be finite, positive, and no greater than 1.8/,
  );
  assert.throws(
    () => mapTrackedEyeAroundReference({
      eye: { x: 0, y: 0, z: 5 },
      referenceZ: 5,
      response: 1.0001,
      lateralResponse: 1.5,
    }),
    /eye response must be finite, positive, and no greater than one/,
  );
  assert.throws(
    () => trueWindowLateralEyeResponse({ ...options, gain: 0 }),
    /lateral response gain must be positive/,
  );
  assert.throws(
    () => trueWindowLateralEyeResponse({ ...options, orientation: 'square' }),
    /orientation must be portrait or landscape/,
  );
});

test('True Window eye response matches the shallow photo-relief parallax lever', () => {
  const options = {
    captureFovDeg: 60,
    referenceEyeZ: 5,
    trueWindowDepth: 20,
    trueWindowFramingScale: 0.5,
    sourceAspect: 1.5,
    screenWidth: 1,
    screenHeight: 2,
    reliefDepthSpan: 1,
    occupancy: 0.9,
  };
  const response = trueWindowEyeResponseForRelief(options);
  const imageHeight = (options.screenWidth * options.occupancy) / options.sourceAspect;
  const photoApex = (imageHeight / 2) / Math.tan(Math.PI / 6);
  const photoDepth = options.reliefDepthSpan * imageHeight;
  const expected = (photoApex / options.referenceEyeZ)
    * (photoDepth / (photoApex + photoDepth))
    / (options.trueWindowDepth / (options.referenceEyeZ + options.trueWindowDepth))
    / options.trueWindowFramingScale;
  assert.ok(Math.abs(response - expected) < 1e-12);
  assert.ok(response < trueWindowEyeResponse(options));

  assert.equal(trueWindowEyeResponseForRelief({
    ...options,
    trueWindowDepth: 0.1,
  }), trueWindowEyeResponse(options));
});


test('rectilinear vertical FOV and aspect recover 35 mm-equivalent focal length', () => {
  const sourceAspect = 3 / 2;
  const expectedFocalLength = 15;
  const fullFrameDiagonal = Math.hypot(36, 24);
  const diagonalTangent = fullFrameDiagonal / (2 * expectedFocalLength);
  const verticalTangent = diagonalTangent / Math.hypot(sourceAspect, 1);
  const captureFovDeg = (Math.atan(verticalTangent) * 360) / Math.PI;
  const actual = focalLength35mmEquivalentFromVerticalFov({
    captureFovDeg,
    sourceAspect,
  });
  assert.ok(Math.abs(actual - expectedFocalLength) < 1e-12);
  assert.throws(
    () => focalLength35mmEquivalentFromVerticalFov({ captureFovDeg, sourceAspect: 0 }),
    /sourceAspect must be positive/,
  );
});


test('Source overview framing fits the full capture without changing its geometry', () => {
  const referenceEyeZ = 5;
  const captureFovDeg = 60;
  const sourceAspect = 2;
  const screenAspect = 0.5;
  const occupancy = 0.92;
  const framing = computeSourceOverviewFraming({
    captureFovDeg,
    sourceAspect,
    screenAspect,
    referenceEyeZ,
    occupancy,
  });
  const sourceHalfHeight = referenceEyeZ * Math.tan(Math.PI / 6);
  const sourceHalfWidth = sourceHalfHeight * sourceAspect;

  assert.ok(Math.abs(
    sourceHalfWidth * framing / screenAspect - occupancy,
  ) < 1e-12, 'the limiting horizontal edge should land at the requested occupancy');
  assert.ok(sourceHalfHeight * framing < occupancy, 'the other axis must remain inside');
});


test('Source overview auto-fit never magnifies beyond the literal glass', () => {
  assert.equal(computeSourceOverviewFraming({
    captureFovDeg: 15,
    sourceAspect: 1,
    screenAspect: 1,
    referenceEyeZ: 1,
  }), 1);
  assert.throws(() => computeSourceOverviewFraming({
    captureFovDeg: 60,
    sourceAspect: 1,
    screenAspect: 1,
    referenceEyeZ: 5,
    occupancy: 2,
  }), /occupancy/);
});


test('Source exact maps the capture apex and near anchor with one XYZ scale', () => {
  const placement = computeSourceExactWindowPlacement({
    captureFovDeg: 70,
    sourceAspect: 16 / 9,
    anchorDistance: 1.8,
    referenceEyeZ: 4.75,
  });
  const transformedAnchorZ = placement.translation[2] - placement.scale * 1.8;
  assert.ok(Math.abs(transformedAnchorZ) < 1e-12);
  assert.ok(Math.abs(placement.sourceCaptureApex - 4.75) < 1e-12);
  assert.equal(new Set([placement.scale, placement.scale, placement.scale]).size, 1);
  assert.equal(placement.windowHalfHeight, 1);

  const sourceDelta = [0.4, 0.2, -0.8];
  const worldDelta = sourceDelta.map((value) => value * placement.scale);
  assert.ok(Math.abs(worldDelta[0] / worldDelta[1] - 2) < 1e-12, 'X:Y must not change');
  assert.ok(Math.abs(worldDelta[0] / worldDelta[2] + 0.5) < 1e-12, 'X:Z must not change');
});


test('Source exact makes all depths on one capture ray meet at the same glass point', () => {
  const eyeZ = 4.75;
  const placement = computeSourceExactWindowPlacement({
    captureFovDeg: 70,
    sourceAspect: 4 / 3,
    anchorDistance: 2,
    referenceEyeZ: eyeZ,
  });
  const projectToGlass = ([x, z]) => {
    const worldX = placement.scale * x;
    const worldZ = placement.scale * z + placement.translation[2];
    const rayStep = -eyeZ / (worldZ - eyeZ);
    return rayStep * worldX;
  };
  const near = projectToGlass([0.4, -2]);
  const far = projectToGlass([1.2, -6]);
  assert.ok(Math.abs(near - far) < 1e-12);
  assert.ok(Math.abs(near - eyeZ * 0.2) < 1e-12);
});


test('Source exact setback is rigid and leaves its metric scale unchanged', () => {
  const base = {
    captureFovDeg: 60,
    sourceAspect: 4 / 3,
    anchorDistance: 2,
    referenceEyeZ: 5,
  };
  const normal = computeSourceExactWindowPlacement(base);
  const pushed = computeSourceExactWindowPlacement({ ...base, pushBack: 0.25 });
  assert.equal(pushed.scale, normal.scale);
  assert.ok(Math.abs(pushed.translation[2] - normal.translation[2] + 0.25) < 1e-12);
  assert.ok(Math.abs(pushed.anchorDepth + 0.25) < 1e-12);
  assert.ok(Math.abs(pushed.sourceCaptureApex - (5 - 0.25)) < 1e-12);
});


test('True Window uses one scale for XYZ and keeps the physical aperture fixed', () => {
  for (const modelScale of [0.3, 1, 2.5, 4]) {
    const placement = computeTrueWindowPlacement({
      captureFovDeg: 60,
      anchorDistance: 2,
      modelScale,
    });
    assert.equal(placement.windowHalfHeight, 1);
    assert.equal(placement.anchorDepth, 0);
    const transformedBasis = [placement.scale, placement.scale, placement.scale];
    assert.equal(new Set(transformedBasis).size, 1);
    assert.ok(Math.abs(
      placement.translation[2] - placement.scale * 2,
    ) < 1e-12, 'the selected camera-axis depth must land on the glass');
  }
});


test('model scale moves the capture apex and miniature together', () => {
  const small = computeTrueWindowPlacement({
    captureFovDeg: 50,
    anchorDistance: 3,
    modelScale: 0.5,
  });
  const large = computeTrueWindowPlacement({
    captureFovDeg: 50,
    anchorDistance: 3,
    modelScale: 2,
  });
  assert.ok(Math.abs(large.scaledApex / small.scaledApex - 4) < 1e-12);
  assert.ok(Math.abs(large.scale / small.scale - 4) < 1e-12);
  assert.equal(large.windowHalfHeight, small.windowHalfHeight);
});


test('neutral model scale puts the transformed capture apex at the physical eye', () => {
  const eyeZ = 4.75;
  const captureFovDeg = 42;
  const modelScale = modelScaleForCaptureApex({ captureFovDeg, eyeZ });
  const placement = computeTrueWindowPlacement({
    captureFovDeg,
    anchorDistance: 2.4,
    modelScale,
  });
  assert.ok(Math.abs(placement.scaledApex - eyeZ) < 1e-12);
  assert.throws(
    () => modelScaleForCaptureApex({ captureFovDeg, eyeZ: 0 }),
    /eyeZ must be positive/,
  );
});


test('pushback is one rigid z translation and the model scale is bounded', () => {
  const atGlass = computeTrueWindowPlacement({
    captureFovDeg: 45,
    anchorDistance: 2,
    modelScale: 1,
  });
  const pushed = computeTrueWindowPlacement({
    captureFovDeg: 45,
    anchorDistance: 2,
    modelScale: 1,
    pushBack: 0.75,
  });
  assert.equal(pushed.scale, atGlass.scale);
  assert.ok(Math.abs(pushed.translation[2] - (atGlass.translation[2] - 0.75)) < 1e-12);
  assert.equal(pushed.anchorDepth, -0.75);
  assert.equal(computeTrueWindowPlacement({
    captureFovDeg: 45, anchorDistance: 2, modelScale: 1e-3,
  }).modelScale, MIN_TRUE_WINDOW_MODEL_SCALE);
  assert.equal(computeTrueWindowPlacement({
    captureFovDeg: 45, anchorDistance: 2, modelScale: 1e3,
  }).modelScale, MAX_TRUE_WINDOW_MODEL_SCALE);
});


test('the low camera-axis quantile rejects a lone near outlier', () => {
  const positions = [];
  positions.push(0, 0, -0.001);
  for (let index = 0; index < 1100; index += 1) positions.push(index, 0, -2);
  positions.push(0, 0, -20);
  const depth = estimateCameraAxisDepthQuantile(new Float32Array(positions));
  assert.equal(depth, 2);
  assert.equal(
    estimateCameraAxisDepthQuantile(new Float32Array([100, 0, -2, 0, 0, -2]), {
      quantile: 0.5,
    }),
    2,
    'lateral distance must not affect camera-axis depth',
  );
});


test('shallow True Window vertices flatten on the anchor without leaving their camera rays', () => {
  const source = new Float32Array([
    0.05, -0.025, -0.25,
    0.4, 0.2, -2,
    -0.9, 0.3, -3,
  ]);
  const original = new Float32Array(source);
  const result = clampCameraRayDepthFloor(source, 2);
  assert.equal(result.clampedCount, 1);
  assert.deepEqual(source, original, 'the shared source geometry must remain immutable');
  assert.ok(Math.abs(result.positions[0] / -result.positions[2] - source[0] / -source[2]) < 1e-7);
  assert.ok(Math.abs(result.positions[1] / -result.positions[2] - source[1] / -source[2]) < 1e-7);
  assert.equal(result.positions[2], -2);
  for (const [actual, expected] of result.bounds.min.map((value, index) => [
    value,
    [-0.9, -0.2, -3][index],
  ])) assert.ok(Math.abs(actual - expected) < 1e-6);
  for (const [actual, expected] of result.bounds.max.map((value, index) => [
    value,
    [0.4, 0.3, -2][index],
  ])) assert.ok(Math.abs(actual - expected) < 1e-6);
});


test('physical eye coordinates survive a world-unit size change', () => {
  assert.deepEqual(
    preservePhysicalEye({ x: 1, y: -2, z: 5 }, 70, 35),
    { x: 2, y: -4, z: 10 },
  );
  assert.throws(
    () => preservePhysicalEye({ x: 0, y: 0, z: Number.NaN }, 70, 35),
    /finite XYZ/,
  );
});


test('the lateral ceiling does not eat the landscape compensation', () => {
  // The configuration above is a very wide capture held far away, where
  // neither orientation reaches the ceiling. Every lens this project
  // recommends is narrower than that, and at arm's length a single shared
  // ceiling applied after the orientation gain pinned both orientations to
  // exactly 1.5 -- deleting the 1.20 ratio hardware had settled on.
  const referenceEyeZ = 4.7;
  // Vertical fov of a 35 mm-equivalent lens on a 3:2 frame.
  const captureFovDeg = (mm) => (2 * Math.atan(12 / mm) * 180) / Math.PI;
  for (const mm of [35, 50, 85]) {
    const options = { captureFovDeg: captureFovDeg(mm), referenceEyeZ };
    const portrait = trueWindowLateralEyeResponse(options);
    const landscape = trueWindowLateralEyeResponse({ ...options, orientation: 'landscape' });
    assert.ok(
      Math.abs(landscape / portrait - 1.2) < 1e-12,
      `${mm} mm gave a landscape/portrait ratio of ${landscape / portrait}`,
    );
    // Portrait keeps the ceiling it was tuned against; only landscape rises.
    assert.ok(portrait <= 1.5 + 1e-12);
    assert.ok(landscape <= 1.8 + 1e-12);
  }
});
