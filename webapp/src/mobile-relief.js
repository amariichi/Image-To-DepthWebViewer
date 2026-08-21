import { transformBounds } from './head-coupled-projection.js';
import { mat4 } from './rendering.js';

// Depth outliers are rejected from BOTH ends. The far quantile keeps a few sky
// or reconstruction-error samples from spending the whole relief budget. The
// near quantile matters just as much once depth is mapped by disparity: a
// single stray foreground sample would otherwise anchor 1/near and compress
// everything else against the back plane.
export const DEFAULT_NEAR_QUANTILE = 0.02;
export const DEFAULT_FAR_QUANTILE = 0.98;

// 1 maps depth by disparity (1 / distance), 0 maps it linearly in distance.
// Disparity is the default because it matches how human depth perception and
// the original pinhole reconstruction both behave: equal steps of 1 / distance
// are equal steps of perceived depth. A coastal portrait with a 1:5000 depth
// ratio gives its near subject about 13% of the relief budget under disparity
// and about 0.003% under linear mapping.
export const DEFAULT_DISPARITY_BLEND = 1;

// A coarse grid holding the nearest sample of each image cell. It is what makes
// the "nearest visible sample" query cheap enough to run every frame: a few
// thousand points instead of a quarter of a million.
export const FRONT_SAMPLE_COLUMNS = 64;
export const FRONT_SAMPLE_ROWS = 48;

// How far outside the viewport a sample still counts as visible. Without a
// margin, geometry just off the edge could be pulled in front of the glass and
// then swing into view as the head moves, where it would show reversed
// parallax.
export const VISIBLE_FRONT_MARGIN = 1.15;

// Each cell stores its nearest relief point (x, y, z) plus the near and far
// source depths it covers. The positions answer "what is the nearest thing
// still on screen"; the source depths answer "what depth range is on screen",
// which is what lets the relief be rebuilt to spend its whole budget on
// whatever the viewer has zoomed into.
export const FRONT_SAMPLE_STRIDE = 5;

function finitePositive(value, label) {
  if (!Number.isFinite(value) || !(value > 0)) {
    throw new Error(`${label} must be positive and finite.`);
  }
  return value;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function computeBounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis];
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}

export function fitImageRect(sourceAspect, screenWidth, screenHeight, occupancy = 0.92) {
  finitePositive(sourceAspect, 'sourceAspect');
  finitePositive(screenWidth, 'screenWidth');
  finitePositive(screenHeight, 'screenHeight');
  if (!Number.isFinite(occupancy) || !(occupancy > 0 && occupancy <= 1)) {
    throw new Error('occupancy must be greater than zero and at most one.');
  }
  const screenAspect = screenWidth / screenHeight;
  if (sourceAspect >= screenAspect) {
    const width = screenWidth * occupancy;
    return { width, height: width / sourceAspect };
  }
  const height = screenHeight * occupancy;
  return { width: height * sourceAspect, height };
}

// The perpendicular distance from the capture camera, not the distance along
// the ray.
//
// The published mesh is `rayDirection * depth`, so a point's straight-line
// distance from the camera grows as `1 / cos(theta)` toward the edges of the
// frame even for a perfectly flat wall: 16 percent at the corners of a 32
// degree capture, 27 percent at 50 degrees, 46 percent at 65 degrees. Feeding
// that into the relief bows the whole image backwards at the edges, which reads
// as the picture being wrapped onto the inside of a sphere and grows in
// proportion to the depth span. Because `rayDirection.z` is `-cos(theta)`, the
// z component already carries the perpendicular depth with that factor removed.
export function perpendicularDepth(positions, vertex) {
  return Math.max(-positions[vertex * 3 + 2], 1e-6);
}

export function computeReliefDepthRange(positions, {
  nearQuantile = DEFAULT_NEAR_QUANTILE,
  farQuantile = DEFAULT_FAR_QUANTILE,
} = {}) {
  if (!Number.isFinite(nearQuantile) || !Number.isFinite(farQuantile)
      || nearQuantile < 0 || farQuantile > 1 || nearQuantile >= farQuantile) {
    throw new Error('Relief depth quantiles must satisfy 0 <= near < far <= 1.');
  }
  const depths = [];
  for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
    const depth = perpendicularDepth(positions, vertex);
    if (!Number.isFinite(depth)) {
      throw new Error('Mobile relief source positions must be finite.');
    }
    depths.push(depth);
  }
  depths.sort((a, b) => a - b);
  const lastIndex = depths.length - 1;
  const nearIndex = Math.round(lastIndex * nearQuantile);
  const farIndex = Math.round(lastIndex * farQuantile);
  // A radial depth of zero would make the disparity mapping divide by zero, so
  // the near reference is always kept strictly positive.
  const near = Math.max(depths[nearIndex], 1e-6);
  const far = Math.max(depths[farIndex], near * (1 + 1e-6));
  return { near, far };
}

export function normalizeReliefDepth(depth, { near, far }, disparityBlend = DEFAULT_DISPARITY_BLEND) {
  finitePositive(near, 'near');
  finitePositive(far, 'far');
  if (!(far > near)) {
    throw new Error('Relief depth range requires far greater than near.');
  }
  const blend = clamp(Number.isFinite(disparityBlend) ? disparityBlend : DEFAULT_DISPARITY_BLEND, 0, 1);
  // Samples outside the quantile range are flattened onto the near or far
  // plane rather than dropped, so the mesh stays a closed sheet.
  const clamped = clamp(Number.isFinite(depth) ? depth : near, near, far);
  const linear = (clamped - near) / (far - near);
  const nearDisparity = 1 / near;
  const disparitySpan = nearDisparity - 1 / far;
  const disparity = disparitySpan > 0
    ? (nearDisparity - 1 / clamped) / disparitySpan
    : linear;
  return clamp(linear * (1 - blend) + disparity * blend, 0, 1);
}

export function createMobileReliefScene({
  scene,
  sourceAspect,
  screenWidth,
  screenHeight,
  baselineEyeZ,
  depthSpan = 1,
  frontZ = 0,
  occupancy = 0.92,
  disparityBlend = DEFAULT_DISPARITY_BLEND,
  nearQuantile = DEFAULT_NEAR_QUANTILE,
  farQuantile = DEFAULT_FAR_QUANTILE,
  // When the viewer has zoomed into part of the scene, the relief is rebuilt
  // over just that depth range so the whole budget is spent on what is visible.
  depthRange = null,
}) {
  const positions = scene?.positions;
  const uvs = scene?.uvs;
  if (!(positions instanceof Float32Array) || positions.length < 3 || positions.length % 3 !== 0) {
    throw new Error('Mobile relief requires Float32 POSITION data.');
  }
  if (!(uvs instanceof Float32Array) || uvs.length / 2 !== positions.length / 3) {
    throw new Error('Mobile relief requires one UV for every position.');
  }
  finitePositive(baselineEyeZ, 'baselineEyeZ');
  finitePositive(depthSpan, 'depthSpan');
  const safeFrontZ = Math.min(Number.isFinite(frontZ) ? frontZ : 0, 0);
  const imageRect = fitImageRect(sourceAspect, screenWidth, screenHeight, occupancy);
  const depthRangeIsFitted = Boolean(
    depthRange && depthRange.near > 0 && depthRange.far > depthRange.near,
  );
  const sourceDepth = depthRangeIsFitted
    ? { near: depthRange.near, far: depthRange.far }
    : computeReliefDepthRange(positions, { nearQuantile, farQuantile });
  const reliefPositions = new Float32Array(positions.length);
  // Nearest sample per image cell, accumulated in the same pass that builds the
  // relief so it costs no extra traversal.
  const cellCount = FRONT_SAMPLE_COLUMNS * FRONT_SAMPLE_ROWS;
  const frontSamples = new Float32Array(cellCount * FRONT_SAMPLE_STRIDE);
  const frontFilled = new Uint8Array(cellCount);

  for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
    const positionOffset = vertex * 3;
    const uvOffset = vertex * 2;
    const depth = perpendicularDepth(positions, vertex);
    const normalizedDepth = normalizeReliefDepth(depth, sourceDepth, disparityBlend);
    const z = safeFrontZ - normalizedDepth * depthSpan;
    const screenX = (uvs[uvOffset] - 0.5) * imageRect.width;
    const screenY = (0.5 - uvs[uvOffset + 1]) * imageRect.height;
    // Every vertex is placed on the ray from the calibrated baseline eye through
    // its own image-plane anchor. Projecting from that eye therefore reproduces
    // the source image exactly, whatever depth span or mapping is chosen.
    const rayScale = (baselineEyeZ - z) / baselineEyeZ;
    const worldX = screenX * rayScale;
    const worldY = screenY * rayScale;
    reliefPositions[positionOffset] = worldX;
    reliefPositions[positionOffset + 1] = worldY;
    reliefPositions[positionOffset + 2] = z;

    const column = clamp(
      Math.floor(uvs[uvOffset] * FRONT_SAMPLE_COLUMNS),
      0,
      FRONT_SAMPLE_COLUMNS - 1,
    );
    const row = clamp(
      Math.floor(uvs[uvOffset + 1] * FRONT_SAMPLE_ROWS),
      0,
      FRONT_SAMPLE_ROWS - 1,
    );
    const cell = row * FRONT_SAMPLE_COLUMNS + column;
    const base = cell * FRONT_SAMPLE_STRIDE;
    if (!frontFilled[cell]) {
      frontFilled[cell] = 1;
      frontSamples[base] = worldX;
      frontSamples[base + 1] = worldY;
      frontSamples[base + 2] = z;
      frontSamples[base + 3] = depth;
      frontSamples[base + 4] = depth;
    } else {
      if (z > frontSamples[base + 2]) {
        frontSamples[base] = worldX;
        frontSamples[base + 1] = worldY;
        frontSamples[base + 2] = z;
      }
      if (depth < frontSamples[base + 3]) frontSamples[base + 3] = depth;
      if (depth > frontSamples[base + 4]) frontSamples[base + 4] = depth;
    }
  }

  const usedCells = [];
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (!frontFilled[cell]) continue;
    const base = cell * FRONT_SAMPLE_STRIDE;
    for (let field = 0; field < FRONT_SAMPLE_STRIDE; field += 1) {
      usedCells.push(frontSamples[base + field]);
    }
  }

  return {
    ...scene,
    positions: reliefPositions,
    nodeMatrix: null,
    frontSamples: new Float32Array(usedCells),
    bounds: computeBounds(reliefPositions),
    frontZ: safeFrontZ,
    depthSpan,
    depthRangeIsFitted,
    disparityBlend: clamp(disparityBlend, 0, 1),
    imageRect,
    sourceDepth,
  };
}

// How deep the relief would be if the scene were simply scaled uniformly, with
// no depth remapping at all -- the way the desktop and Looking Glass paths
// present the same mesh. A perspective projection already compresses distance
// by 1 / d on its own, so uniform scaling is a legitimate presentation; the
// catch is that a scene with a 1:5000 depth ratio then extends thousands of
// world units behind the glass, which is a window onto a landscape rather than
// a miniature sitting just behind the screen.
export function estimateUniformScaleDepthSpan({
  sourceDepth,
  imageRectHeight,
  captureFovDeg,
}) {
  if (!sourceDepth || !(sourceDepth.near > 0) || !(sourceDepth.far > sourceDepth.near)) return null;
  if (!Number.isFinite(imageRectHeight) || !(imageRectHeight > 0)) return null;
  if (!Number.isFinite(captureFovDeg) || !(captureFovDeg > 0) || captureFovDeg >= 180) return null;
  const realHeightAtNear = 2 * sourceDepth.near * Math.tan((captureFovDeg * Math.PI) / 360);
  if (!(realHeightAtNear > 0)) return null;
  const scale = imageRectHeight / realHeightAtNear;
  return scale * (sourceDepth.far - sourceDepth.near);
}

// Pinch magnifies the miniature, and a miniature magnifies uniformly.
//
// Scaling the image plane alone would flatten the model into an anamorphic card
// exactly when the viewer zooms in to look closer, and scaling depth by anything
// other than the same factor breaks the construction: each vertex sits on the
// ray from the calibrated eye through its image anchor, with its lateral
// expansion baked for its own depth, so changing that depth afterwards leaves
// the two inconsistent and the initial view stops reproducing the source image.
// Uniform scaling has neither problem, being identical to rebuilding the relief
// at a larger span and a correspondingly larger anchor.
//
// There is no separate depth limit. One existed and did nothing but harm: its
// only possible action was to introduce that inconsistency, and it engaged so
// early that the relief depth slider stopped deepening anything past about 1.15.
// The bounds that matter are already elsewhere -- touch scale spans 0.45 to 3,
// and the relief span is bounded where it is authored.
export function createReliefInteractionMatrix({ interaction, frontZ = 0 }) {
  const panX = Number(interaction?.panX) || 0;
  const panY = Number(interaction?.panY) || 0;
  const yaw = Number(interaction?.yaw) || 0;
  const pitch = Number(interaction?.pitch) || 0;
  const scale = Number(interaction?.scale) || 1;
  if (!Number.isFinite(frontZ) || !Number.isFinite(scale) || !(scale > 0)) {
    throw new Error('Relief interaction requires a finite pivot and positive scale.');
  }
  let matrix = mat4.identity();
  matrix = mat4.translate(matrix, [panX, panY, frontZ]);
  matrix = mat4.rotateY(matrix, yaw);
  matrix = mat4.rotateX(matrix, pitch);
  matrix = mat4.scale(matrix, scale);
  matrix = mat4.translate(matrix, [0, 0, -frontZ]);
  return matrix;
}

// Pulls whatever is currently on screen forward until its nearest sample sits on
// the glass.
//
// Motion parallax that is common to everything in view carries no shape
// information; only the differences between points do. When the viewer pinches
// into a region that sits deep inside the relief, almost all of its motion is
// common: at an eye distance of 4.6 units a region spanning 3.7 to 4.0 units
// behind the glass slides by 44.6 percent of the head movement while differing
// internally by only 1.9 percent, which reads as a flat card sliding. Moving
// that region up to the glass removes the common part entirely and raises the
// difference to 6.1 percent, because the parallax curve is steepest at the
// glass.
//
// The projection used here must be the calibrated one, not the live eye, or the
// model would swim about as the viewer's head moved.
export function anchorVisibleFrontToScreen({
  frontSamples,
  modelMatrix,
  viewProjectionMatrix,
  screenZ = 0,
  margin = VISIBLE_FRONT_MARGIN,
}) {
  if (!(frontSamples instanceof Float32Array) || frontSamples.length < FRONT_SAMPLE_STRIDE) {
    return null;
  }
  if (!viewProjectionMatrix || viewProjectionMatrix.length !== 16) return null;
  let visibleFrontZ = -Infinity;
  let visibleCount = 0;
  for (let index = 0; index < frontSamples.length; index += FRONT_SAMPLE_STRIDE) {
    const point = mat4.transformPoint(modelMatrix, [
      frontSamples[index],
      frontSamples[index + 1],
      frontSamples[index + 2],
    ]);
    const clipW = viewProjectionMatrix[3] * point[0]
      + viewProjectionMatrix[7] * point[1]
      + viewProjectionMatrix[11] * point[2]
      + viewProjectionMatrix[15];
    if (!(clipW > 1e-6)) continue;
    const ndcX = (viewProjectionMatrix[0] * point[0] + viewProjectionMatrix[4] * point[1]
      + viewProjectionMatrix[8] * point[2] + viewProjectionMatrix[12]) / clipW;
    const ndcY = (viewProjectionMatrix[1] * point[0] + viewProjectionMatrix[5] * point[1]
      + viewProjectionMatrix[9] * point[2] + viewProjectionMatrix[13]) / clipW;
    if (Math.abs(ndcX) > margin || Math.abs(ndcY) > margin) continue;
    visibleCount += 1;
    if (point[2] > visibleFrontZ) visibleFrontZ = point[2];
  }
  if (!visibleCount || !Number.isFinite(visibleFrontZ)) return null;
  const correctionZ = screenZ - visibleFrontZ;
  const safeMatrix = correctionZ === 0
    ? new Float32Array(modelMatrix)
    : mat4.multiply(mat4.translate(mat4.identity(), [0, 0, correctionZ]), modelMatrix);
  return { modelMatrix: safeMatrix, correctionZ, visibleFrontZ, visibleCount };
}

// The source depth range covered by whatever is currently on screen.
//
// Zooming into a distant part of a scene is the case this exists for. In a room
// with a person at 1 m and balloons on a wall at 4 m, the balloons' own 10 cm of
// depth is 0.85 percent of the scene's depth budget, so they stay flat however
// the relief is anchored. Rebuilding the relief over just their depth range
// gives them the whole budget instead.
export function findVisibleDepthRange({
  frontSamples,
  modelMatrix,
  viewProjectionMatrix,
  margin = VISIBLE_FRONT_MARGIN,
}) {
  if (!(frontSamples instanceof Float32Array) || frontSamples.length < FRONT_SAMPLE_STRIDE) {
    return null;
  }
  if (!viewProjectionMatrix || viewProjectionMatrix.length !== 16) return null;
  let near = Infinity;
  let far = -Infinity;
  let visibleCount = 0;
  for (let index = 0; index < frontSamples.length; index += FRONT_SAMPLE_STRIDE) {
    const point = mat4.transformPoint(modelMatrix, [
      frontSamples[index],
      frontSamples[index + 1],
      frontSamples[index + 2],
    ]);
    const clipW = viewProjectionMatrix[3] * point[0]
      + viewProjectionMatrix[7] * point[1]
      + viewProjectionMatrix[11] * point[2]
      + viewProjectionMatrix[15];
    if (!(clipW > 1e-6)) continue;
    const ndcX = (viewProjectionMatrix[0] * point[0] + viewProjectionMatrix[4] * point[1]
      + viewProjectionMatrix[8] * point[2] + viewProjectionMatrix[12]) / clipW;
    const ndcY = (viewProjectionMatrix[1] * point[0] + viewProjectionMatrix[5] * point[1]
      + viewProjectionMatrix[9] * point[2] + viewProjectionMatrix[13]) / clipW;
    if (Math.abs(ndcX) > margin || Math.abs(ndcY) > margin) continue;
    visibleCount += 1;
    near = Math.min(near, frontSamples[index + 3]);
    far = Math.max(far, frontSamples[index + 4]);
  }
  if (!visibleCount || !(near > 0) || !(far > near)) return null;
  return { near, far, visibleCount };
}

export function constrainReliefBehindScreen({
  bounds,
  modelMatrix,
  screenZ = 0,
  gap = 0,
}) {
  if (!Number.isFinite(screenZ) || !Number.isFinite(gap) || gap < 0) {
    throw new Error('Screen constraint requires finite screenZ and a non-negative gap.');
  }
  let safeMatrix = new Float32Array(modelMatrix);
  let transformedBounds = transformBounds(bounds, safeMatrix);
  const maxAllowedZ = screenZ - gap;
  let correctionZ = 0;
  if (transformedBounds.max[2] > maxAllowedZ) {
    correctionZ = maxAllowedZ - transformedBounds.max[2];
    safeMatrix = mat4.multiply(
      mat4.translate(mat4.identity(), [0, 0, correctionZ]),
      safeMatrix,
    );
    transformedBounds = transformBounds(bounds, safeMatrix);
  }
  return { modelMatrix: safeMatrix, transformedBounds, correctionZ };
}
