import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_RELIEF_DEPTH_RATIO,
  computeReliefDepthRange,
  constrainReliefBehindScreen,
  FRONT_SAMPLE_STRIDE,
  anchorVisibleFrontToScreen,
  createReliefInteractionMatrix,
  findVisibleDepthRange,
  createMobileReliefScene,
  estimateUniformScaleDepthSpan,
  normalizeReliefDepth,
  reliefInteractionDepthScale,
} from '../webapp/src/mobile-relief.js';
import {
  computeEyeViewMatrix,
  computeOffAxisProjection,
} from '../webapp/src/head-coupled-projection.js';
import { mat4 } from '../webapp/src/rendering.js';


function projectPoint(point, eye = { x: 0, y: 0, z: 2.5 }) {
  const { projectionMatrix } = computeOffAxisProjection({
    eye,
    screenHalfWidth: 1,
    screenHalfHeight: 1,
    near: 0.05,
    far: 20,
  });
  const matrix = mat4.multiply(projectionMatrix, computeEyeViewMatrix(eye));
  const [x, y, z] = point;
  const clipX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
  const clipY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
  const clipW = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  return [clipX / clipW, clipY / clipW];
}


const sourceScene = {
  // Deliberately extreme raw depth: the far corner must not make the near image tiny.
  positions: new Float32Array([
    0, 0, -1,
    0, 0, -100,
    0, 0, -2,
    0, 0, -3,
  ]),
  uvs: new Float32Array([
    0, 0,
    1, 0,
    0, 1,
    1, 1,
  ]),
  indices: new Uint32Array([0, 2, 1, 1, 2, 3]),
};


test('relief anchors the nearest sample to glass and bounds all depth behind it', () => {
  const relief = createMobileReliefScene({
    scene: sourceScene,
    sourceAspect: 1,
    screenWidth: 2,
    screenHeight: 2,
    baselineEyeZ: 2.5,
    depthSpan: 0.25,
    frontZ: 0.05,
    occupancy: 0.9,
  });
  assert.equal(relief.frontZ, 0, 'legacy positive offsets must be clamped to the glass');
  assert.ok(Math.abs(relief.bounds.max[2]) < 1e-6);
  assert.ok(Math.abs(relief.bounds.min[2] + 0.25) < 1e-6);
  assert.ok([...relief.positions].every(Number.isFinite));
});


test('baseline view preserves image-plane size even when raw far depth is extreme', () => {
  const relief = createMobileReliefScene({
    scene: sourceScene,
    sourceAspect: 1,
    screenWidth: 2,
    screenHeight: 2,
    baselineEyeZ: 2.5,
    depthSpan: 0.25,
    occupancy: 0.9,
  });
  const topLeft = projectPoint([...relief.positions.slice(0, 3)]);
  const topRight = projectPoint([...relief.positions.slice(3, 6)]);
  assert.ok(Math.abs(topLeft[0] + 0.9) < 1e-6);
  assert.ok(Math.abs(topLeft[1] - 0.9) < 1e-6);
  assert.ok(Math.abs(topRight[0] - 0.9) < 1e-6);
  assert.ok(Math.abs(topRight[1] - 0.9) < 1e-6);
  assert.ok(relief.bounds.max[0] - relief.bounds.min[0] < 2.1);
});


test('relief fit preserves source aspect inside a portrait screen', () => {
  const relief = createMobileReliefScene({
    scene: sourceScene,
    sourceAspect: 2,
    screenWidth: 1,
    screenHeight: 2,
    baselineEyeZ: 2.5,
    depthSpan: 0.25,
    occupancy: 0.8,
  });
  assert.ok(Math.abs(relief.imageRect.width - 0.8) < 1e-6);
  assert.ok(Math.abs(relief.imageRect.height - 0.4) < 1e-6);
});


test('manual transforms are translated back when they cross the display glass', () => {
  const movedForward = mat4.translate(mat4.identity(), [0, 0, 0.2]);
  const safe = constrainReliefBehindScreen({
    bounds: { min: [-1, -1, -0.25], max: [1, 1, 0] },
    modelMatrix: movedForward,
  });
  assert.ok(Math.abs(safe.correctionZ + 0.2) < 1e-6);
  assert.ok(safe.transformedBounds.max[2] <= 1e-6);
});


test('pinch scales a miniature uniformly while depth stays within reach of the eye', () => {
  // A modest pinch is a true uniform magnification of the miniature. Freezing Z
  // here would turn the model into an anamorphic flat card exactly when the
  // viewer zooms in to inspect it.
  const modest = createReliefInteractionMatrix({
    frontZ: 0,
    depthSpan: 0.2,
    eyeZ: 4.5,
    interaction: { panX: 0, panY: 0, yaw: 0, pitch: 0, scale: 2 },
  });
  const modestPoint = mat4.transformPoint(modest, [0.5, -0.25, -0.2]);
  assert.ok(Math.abs(modestPoint[0] - 1) < 1e-6);
  assert.ok(Math.abs(modestPoint[1] + 0.5) < 1e-6);
  assert.ok(Math.abs(modestPoint[2] + 0.4) < 1e-6, 'depth grows with a modest pinch');

  // Past the comfort bound depth stops growing. Unbounded depth growth relative
  // to a fixed viewing distance is what produced the reported crescent-shaped
  // foreground distortion on real devices.
  const extreme = createReliefInteractionMatrix({
    frontZ: 0,
    depthSpan: 1,
    eyeZ: 4.5,
    interaction: { panX: 0, panY: 0, yaw: 0, pitch: 0, scale: 3 },
  });
  const extremePoint = mat4.transformPoint(extreme, [0.5, -0.25, -1]);
  assert.ok(Math.abs(extremePoint[0] - 1.5) < 1e-6, 'image plane still magnifies fully');
  assert.ok(Math.abs(extremePoint[2] + 1.125) < 1e-6, 'depth stops at a quarter of eye distance');
});


test('relief depth scale never exceeds the comfort ratio of the viewing distance', () => {
  const eyeZ = 4.5;
  for (const depthSpan of [0.2, 0.5, 1, 1.8]) {
    for (const scale of [0.5, 1, 2, 3]) {
      const zScale = reliefInteractionDepthScale({ scale, depthSpan, eyeZ });
      assert.ok(zScale <= scale + 1e-9, 'depth never grows faster than the image plane');
      const thickness = depthSpan * zScale;
      assert.ok(
        thickness <= MAX_RELIEF_DEPTH_RATIO * eyeZ + 1e-9 || zScale <= 0.25 + 1e-9,
        `thickness ${thickness} exceeded the comfort bound`,
      );
    }
  }
});


test('disparity mapping gives a near subject a usable share of an extreme depth range', () => {
  // A coastal portrait: the subject is two metres away and the horizon is ten
  // kilometres away. Mapping depth linearly in distance spends essentially the
  // whole relief budget on the sky and leaves the person perfectly flat.
  const range = { near: 2, far: 10_000 };
  const subjectBack = 2.3;
  const linear = normalizeReliefDepth(subjectBack, range, 0);
  const disparity = normalizeReliefDepth(subjectBack, range, 1);
  assert.ok(linear < 0.0001, `linear mapping gave the subject ${linear} of the budget`);
  assert.ok(disparity > 0.1, `disparity mapping gave the subject only ${disparity}`);

  // Both mappings still agree on the ends of the range.
  assert.equal(normalizeReliefDepth(2, range, 1), 0);
  assert.equal(normalizeReliefDepth(10_000, range, 1), 1);

  // A macro or microscope subject has almost no depth ratio, and there the two
  // mappings must behave the same so no separate mode is ever needed.
  const macro = { near: 1, far: 1.1 };
  const macroLinear = normalizeReliefDepth(1.05, macro, 0);
  const macroDisparity = normalizeReliefDepth(1.05, macro, 1);
  assert.ok(Math.abs(macroLinear - macroDisparity) < 0.03);
});


test('depth quantiles reject stray samples at both the near and far ends', () => {
  // One stray foreground sample and one stray sky sample among a compact body
  // of depths. The near reference matters as much as the far one once depth is
  // mapped by disparity, because the mapping is anchored on 1 / near.
  const samples = [0.01, ...Array.from({ length: 98 }, (_, index) => 10 + index * 0.1), 9000];
  const positions = new Float32Array(samples.length * 3);
  samples.forEach((depth, index) => {
    positions[index * 3 + 2] = -depth;
  });
  const range = computeReliefDepthRange(positions);
  assert.ok(range.near > 1, `stray foreground sample leaked into near (${range.near})`);
  assert.ok(range.far < 100, `stray sky sample leaked into far (${range.far})`);
});


test('samples beyond the quantile range flatten onto the near and far planes', () => {
  const range = { near: 2, far: 20 };
  assert.equal(normalizeReliefDepth(0.5, range, 1), 0);
  assert.equal(normalizeReliefDepth(5000, range, 1), 1);
});


test('a closer cyclopean eye leaves glass size fixed and only slightly shrinks far relief', () => {
  const baselineEye = { x: 0, y: 0, z: 2.5 };
  const closerEye = { x: 0, y: 0, z: 2.375 };
  const screenX = 0.5;
  const farZ = -0.125;
  const farX = screenX * (baselineEye.z - farZ) / baselineEye.z;
  const baselineFront = projectPoint([screenX, 0, 0], baselineEye)[0];
  const closerFront = projectPoint([screenX, 0, 0], closerEye)[0];
  const baselineFar = projectPoint([farX, 0, farZ], baselineEye)[0];
  const closerFar = projectPoint([farX, 0, farZ], closerEye)[0];
  assert.ok(Math.abs(baselineFront - screenX) < 1e-6);
  assert.ok(Math.abs(closerFront - screenX) < 1e-6);
  assert.ok(Math.abs(baselineFar - screenX) < 1e-6);
  assert.ok(closerFar < baselineFar);
  assert.ok(baselineFar - closerFar < 0.005);
});


test('the uniform-scale span reports how much a scene is being compressed', () => {
  // A coastal portrait: subject at 2 m, horizon at 10 km, captured at a 50
  // degree vertical field of view and shown about 1.47 world units tall.
  // Scaling that scene uniformly, with no depth remapping at all, is what the
  // desktop and Looking Glass paths do, and it would put the horizon thousands
  // of world units behind the glass rather than one.
  const span = estimateUniformScaleDepthSpan({
    sourceDepth: { near: 2, far: 10_000 },
    imageRectHeight: 1.47,
    captureFovDeg: 50,
  });
  assert.ok(span > 5000, `expected a very deep uniform-scale span, got ${span}`);

  // A macro subject is already close to a miniature, so the two agree.
  const macro = estimateUniformScaleDepthSpan({
    sourceDepth: { near: 0.1, far: 0.11 },
    imageRectHeight: 1.47,
    captureFovDeg: 50,
  });
  assert.ok(macro > 0 && macro < 2, `expected a shallow uniform-scale span, got ${macro}`);

  assert.equal(estimateUniformScaleDepthSpan({ sourceDepth: null, imageRectHeight: 1, captureFovDeg: 50 }), null);
  assert.equal(estimateUniformScaleDepthSpan({
    sourceDepth: { near: 2, far: 10 }, imageRectHeight: 1, captureFovDeg: null,
  }), null);
});


function viewProjection(eye = { x: 0, y: 0, z: 4.6 }) {
  const { projectionMatrix } = computeOffAxisProjection({
    eye,
    screenHalfWidth: 1,
    screenHalfHeight: 1,
    near: 0.05,
    far: 40,
  });
  return mat4.multiply(projectionMatrix, computeEyeViewMatrix(eye));
}


test('anchoring pulls the nearest sample still on screen up to the glass', () => {
  // Two cells: one deep inside the relief and on screen, one nearer but far off
  // to the side. Only the on-screen one may set the anchor.
  // Fields per cell: x, y, nearest z, near source depth, far source depth.
  const frontSamples = new Float32Array([
    0, 0, -3.7, 3.9, 4.0,
    20, 0, -0.1, 1.0, 1.1,
  ]);
  const anchored = anchorVisibleFrontToScreen({
    frontSamples,
    modelMatrix: mat4.identity(),
    viewProjectionMatrix: viewProjection(),
  });
  assert.equal(anchored.visibleCount, 1, 'the off-screen sample must not anchor the model');
  assert.ok(Math.abs(anchored.visibleFrontZ + 3.7) < 1e-6);
  assert.ok(Math.abs(anchored.correctionZ - 3.7) < 1e-6);
  const moved = mat4.transformPoint(anchored.modelMatrix, [0, 0, -3.7]);
  assert.ok(Math.abs(moved[2]) < 1e-6, 'the visible front must land exactly on the glass');
});


test('anchoring removes common-mode slide and raises the parallax that shows shape', () => {
  // Motion parallax common to everything in view carries no shape information.
  // A region sitting 3.7 to 4.0 units behind the glass slides almost half a head
  // movement while differing internally by under two percent, which reads as a
  // flat card sliding rather than as depth.
  const eyeZ = 4.6;
  const parallax = (depth) => depth / (eyeZ + depth);

  const before = { near: parallax(3.7), far: parallax(4.0) };
  const after = { near: parallax(0), far: parallax(0.3) };

  assert.ok(before.near > 0.4, 'the deep region starts with a large common slide');
  assert.ok(Math.abs(after.near) < 1e-9, 'anchoring removes the common slide entirely');
  const differentialBefore = before.far - before.near;
  const differentialAfter = after.far - after.near;
  assert.ok(
    differentialAfter > differentialBefore * 2.5,
    `expected the shape-carrying parallax to grow, got ${differentialBefore} -> ${differentialAfter}`,
  );
});


test('a fully visible relief is already anchored, so nothing moves', () => {
  // At no zoom the whole image is on screen and the nearest sample is already on
  // the glass, so the anchor must be a no-op rather than a regression.
  const frontSamples = new Float32Array([
    0, 0, 0, 1, 1.2,
    0.2, 0.1, -0.5, 1.2, 2,
  ]);
  const anchored = anchorVisibleFrontToScreen({
    frontSamples,
    modelMatrix: mat4.identity(),
    viewProjectionMatrix: viewProjection(),
  });
  assert.equal(anchored.correctionZ, 0);
  assert.equal(anchored.visibleCount, 2);
});


test('anchoring reports nothing when it has no samples to work from', () => {
  assert.equal(anchorVisibleFrontToScreen({
    frontSamples: new Float32Array([0, 0, -1, 1, 2]),
    modelMatrix: mat4.identity(),
    viewProjectionMatrix: null,
  }), null);
  assert.equal(anchorVisibleFrontToScreen({
    frontSamples: null,
    modelMatrix: mat4.identity(),
    viewProjectionMatrix: viewProjection(),
  }), null);
  // Everything off screen: the caller must fall back to the global constraint.
  assert.equal(anchorVisibleFrontToScreen({
    frontSamples: new Float32Array([50, 50, -1, 1, 2]),
    modelMatrix: mat4.identity(),
    viewProjectionMatrix: viewProjection(),
  }), null);
});


test('the relief carries a front sample grid covering the whole image', () => {
  const relief = createMobileReliefScene({
    scene: sourceScene,
    sourceAspect: 1,
    screenWidth: 2,
    screenHeight: 2,
    baselineEyeZ: 4.6,
    depthSpan: 1,
  });
  assert.ok(relief.frontSamples instanceof Float32Array);
  assert.equal(relief.frontSamples.length % FRONT_SAMPLE_STRIDE, 0);
  assert.ok(relief.frontSamples.length >= FRONT_SAMPLE_STRIDE);
  let nearest = -Infinity;
  for (let index = 0; index < relief.frontSamples.length; index += FRONT_SAMPLE_STRIDE) {
    // Every stored point is a real relief point, never in front of the glass.
    assert.ok(relief.frontSamples[index + 2] <= 1e-6);
    assert.ok(relief.frontSamples[index + 2] >= -1 - 1e-6);
    // Each cell also records the source depth range it covers.
    assert.ok(relief.frontSamples[index + 3] > 0);
    assert.ok(relief.frontSamples[index + 4] >= relief.frontSamples[index + 3]);
    nearest = Math.max(nearest, relief.frontSamples[index + 2]);
  }
  // The nearest stored sample must equal the relief's own front plane.
  assert.ok(Math.abs(nearest - relief.bounds.max[2]) < 1e-6);
});


test('refitting depth to a zoomed-in region gives it the whole relief budget', () => {
  // A room with a person at 1 m and balloons on a wall at 4 m. Across the whole
  // scene the balloons' own 10 cm of depth is under one percent of the budget,
  // so they stay flat no matter where the relief is anchored.
  const wholeScene = { near: 1, far: 4 };
  const balloonsShare = normalizeReliefDepth(4.0, wholeScene, 1)
    - normalizeReliefDepth(3.9, wholeScene, 1);
  assert.ok(balloonsShare < 0.01, `balloons received ${balloonsShare} of the budget`);

  // Rebuilt over just the visible range, they receive all of it.
  const zoomed = { near: 3.9, far: 4.0 };
  const refittedShare = normalizeReliefDepth(4.0, zoomed, 1)
    - normalizeReliefDepth(3.9, zoomed, 1);
  assert.ok(Math.abs(refittedShare - 1) < 1e-9);
});


test('the visible depth range follows what is actually on screen', () => {
  const frontSamples = new Float32Array([
    0, 0, -0.99, 3.9, 4.0,       // balloons, on screen
    0.1, 0.1, -0.98, 3.85, 3.95, // more balloons, on screen
    30, 0, 0, 1.0, 1.2,          // the person, far off to the side
  ]);
  const visible = findVisibleDepthRange({
    frontSamples,
    modelMatrix: mat4.identity(),
    viewProjectionMatrix: viewProjection(),
  });
  assert.equal(visible.visibleCount, 2);
  assert.ok(Math.abs(visible.near - 3.85) < 1e-6);
  assert.ok(Math.abs(visible.far - 4.0) < 1e-6);

  // Nothing on screen means the caller must keep the range it already has.
  assert.equal(findVisibleDepthRange({
    frontSamples: new Float32Array([50, 50, -1, 1, 2]),
    modelMatrix: mat4.identity(),
    viewProjectionMatrix: viewProjection(),
  }), null);
});


test('an explicit depth range overrides the quantile fit and is reported', () => {
  const base = {
    scene: sourceScene,
    sourceAspect: 1,
    screenWidth: 2,
    screenHeight: 2,
    baselineEyeZ: 4.6,
    depthSpan: 1,
  };
  const automatic = createMobileReliefScene(base);
  assert.equal(automatic.depthRangeIsFitted, false);

  const fitted = createMobileReliefScene({ ...base, depthRange: { near: 2.5, far: 3 } });
  assert.equal(fitted.depthRangeIsFitted, true);
  assert.equal(fitted.sourceDepth.near, 2.5);
  assert.equal(fitted.sourceDepth.far, 3);

  // A nonsensical range must fall back to the automatic fit rather than throw.
  const rejected = createMobileReliefScene({ ...base, depthRange: { near: 5, far: 1 } });
  assert.equal(rejected.depthRangeIsFitted, false);
});
