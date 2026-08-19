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

// The deepest relief allowed relative to the viewer's eye distance. Pinch may
// magnify the miniature, but once its thickness reaches this fraction of the
// viewing distance the perspective foreshortening inside a single depth layer
// becomes the "crescent" artifact reported on real devices.
export const MAX_RELIEF_DEPTH_RATIO = 0.25;

const MIN_INTERACTION_Z_SCALE = 0.25;

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

export function computeReliefDepthRange(positions, {
  nearQuantile = DEFAULT_NEAR_QUANTILE,
  farQuantile = DEFAULT_FAR_QUANTILE,
} = {}) {
  if (!Number.isFinite(nearQuantile) || !Number.isFinite(farQuantile)
      || nearQuantile < 0 || farQuantile > 1 || nearQuantile >= farQuantile) {
    throw new Error('Relief depth quantiles must satisfy 0 <= near < far <= 1.');
  }
  const depths = [];
  for (let index = 0; index < positions.length; index += 3) {
    const depth = Math.hypot(positions[index], positions[index + 1], positions[index + 2]);
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
  const sourceDepth = computeReliefDepthRange(positions, { nearQuantile, farQuantile });
  const reliefPositions = new Float32Array(positions.length);

  for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
    const positionOffset = vertex * 3;
    const uvOffset = vertex * 2;
    const depth = Math.hypot(
      positions[positionOffset],
      positions[positionOffset + 1],
      positions[positionOffset + 2],
    );
    const normalizedDepth = normalizeReliefDepth(depth, sourceDepth, disparityBlend);
    const z = safeFrontZ - normalizedDepth * depthSpan;
    const screenX = (uvs[uvOffset] - 0.5) * imageRect.width;
    const screenY = (0.5 - uvs[uvOffset + 1]) * imageRect.height;
    // Every vertex is placed on the ray from the calibrated baseline eye through
    // its own image-plane anchor. Projecting from that eye therefore reproduces
    // the source image exactly, whatever depth span or mapping is chosen.
    const rayScale = (baselineEyeZ - z) / baselineEyeZ;
    reliefPositions[positionOffset] = screenX * rayScale;
    reliefPositions[positionOffset + 1] = screenY * rayScale;
    reliefPositions[positionOffset + 2] = z;
  }

  return {
    ...scene,
    positions: reliefPositions,
    nodeMatrix: null,
    bounds: computeBounds(reliefPositions),
    frontZ: safeFrontZ,
    depthSpan,
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

export function reliefInteractionDepthScale({
  scale,
  depthSpan,
  eyeZ,
  maxDepthRatio = MAX_RELIEF_DEPTH_RATIO,
}) {
  finitePositive(depthSpan, 'depthSpan');
  finitePositive(eyeZ, 'eyeZ');
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const safeRatio = Number.isFinite(maxDepthRatio) && maxDepthRatio > 0
    ? maxDepthRatio
    : MAX_RELIEF_DEPTH_RATIO;
  // Pinch magnifies a miniature, so depth must grow with it or the model turns
  // into an anamorphic flat card. It stops growing once the relief would be
  // deeper than `maxDepthRatio` of the viewing distance.
  const allowed = (safeRatio * eyeZ) / depthSpan;
  return Math.max(Math.min(safeScale, allowed), MIN_INTERACTION_Z_SCALE);
}

export function createReliefInteractionMatrix({
  interaction,
  frontZ = 0,
  depthSpan = 1,
  eyeZ = 4.5,
  maxDepthRatio = MAX_RELIEF_DEPTH_RATIO,
}) {
  const panX = Number(interaction?.panX) || 0;
  const panY = Number(interaction?.panY) || 0;
  const yaw = Number(interaction?.yaw) || 0;
  const pitch = Number(interaction?.pitch) || 0;
  const scale = Number(interaction?.scale) || 1;
  if (!Number.isFinite(frontZ) || !Number.isFinite(scale) || !(scale > 0)) {
    throw new Error('Relief interaction requires a finite pivot and positive scale.');
  }
  const zScale = reliefInteractionDepthScale({ scale, depthSpan, eyeZ, maxDepthRatio });
  let matrix = mat4.identity();
  matrix = mat4.translate(matrix, [panX, panY, frontZ]);
  matrix = mat4.rotateY(matrix, yaw);
  matrix = mat4.rotateX(matrix, pitch);
  matrix = mat4.scaleAxes(matrix, [scale, scale, zScale]);
  matrix = mat4.translate(matrix, [0, 0, -frontZ]);
  return matrix;
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
