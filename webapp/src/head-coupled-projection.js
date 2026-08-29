import { mat4 } from './rendering.js';

function finiteNumber(value, label) {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be finite.`);
  }
  return value;
}

export function computeVirtualScreen(aspect, screenHeight = 2) {
  finiteNumber(aspect, 'aspect');
  finiteNumber(screenHeight, 'screenHeight');
  if (!(aspect > 0) || !(screenHeight > 0)) {
    throw new Error('Virtual screen aspect and height must be positive.');
  }
  return {
    width: screenHeight * aspect,
    height: screenHeight,
    halfWidth: (screenHeight * aspect) / 2,
    halfHeight: screenHeight / 2,
  };
}

// True Window is literal at framingScale=1. Below one, the projection looks
// through a proportionally larger virtual pane so a user can inspect the full
// source frame on a small or differently shaped phone. This changes only the
// frustum; the physical eye, natural reference camera, metric model matrix and
// triangle boundaries do not move. It is therefore an explicit overview aid,
// not a claim that the virtual pane is still the physical glass.
export function frameVirtualScreen(screen, framingScale = 1) {
  const halfWidth = finiteNumber(screen?.halfWidth, 'screen.halfWidth');
  const halfHeight = finiteNumber(screen?.halfHeight, 'screen.halfHeight');
  finiteNumber(framingScale, 'framingScale');
  if (!(halfWidth > 0) || !(halfHeight > 0) || !(framingScale > 0)) {
    throw new Error('Framed virtual screen dimensions and scale must be positive.');
  }
  return {
    width: (halfWidth * 2) / framingScale,
    height: (halfHeight * 2) / framingScale,
    halfWidth: halfWidth / framingScale,
    halfHeight: halfHeight / framingScale,
    physicalHalfWidth: halfWidth,
    physicalHalfHeight: halfHeight,
    framingScale,
  };
}

// Eye distance is now a measured quantity in world units, where one unit is
// half the physical screen height. Holding a phone at arm's length is already
// past 10 units, so the ceiling has to clear the range the metric tracker can
// legitimately report rather than silently clamping it.
export const MAX_SUPPORTED_EYE_Z = 16;

export function sanitizeEye(eye, { minEyeZ = 0.2, maxEyeZ = MAX_SUPPORTED_EYE_Z } = {}) {
  const x = finiteNumber(eye?.x, 'eye.x');
  const y = finiteNumber(eye?.y, 'eye.y');
  const z = finiteNumber(eye?.z, 'eye.z');
  if (!(z > 0)) {
    throw new Error('eye.z must be positive and in front of the virtual screen.');
  }
  return {
    x,
    y,
    z: Math.min(Math.max(z, minEyeZ), maxEyeZ),
  };
}

export function computeOffAxisProjection({
  eye,
  screenHalfWidth,
  screenHalfHeight,
  near,
  far,
  minEyeZ = 0.2,
}) {
  const safeEye = sanitizeEye(eye, { minEyeZ });
  finiteNumber(screenHalfWidth, 'screenHalfWidth');
  finiteNumber(screenHalfHeight, 'screenHalfHeight');
  finiteNumber(near, 'near');
  finiteNumber(far, 'far');
  if (!(screenHalfWidth > 0) || !(screenHalfHeight > 0)) {
    throw new Error('Virtual screen half extents must be positive.');
  }
  if (!(near > 0) || !(far > near)) {
    throw new Error('Projection requires 0 < near < far.');
  }

  const left = (-screenHalfWidth - safeEye.x) * near / safeEye.z;
  const right = (screenHalfWidth - safeEye.x) * near / safeEye.z;
  const bottom = (-screenHalfHeight - safeEye.y) * near / safeEye.z;
  const top = (screenHalfHeight - safeEye.y) * near / safeEye.z;
  if (!(right > left) || !(top > bottom)) {
    throw new Error('Eye position produced a degenerate off-axis frustum.');
  }
  return {
    eye: safeEye,
    frustum: { left, right, bottom, top, near, far },
    projectionMatrix: mat4.frustum(left, right, bottom, top, near, far),
  };
}

export function computeEyeViewMatrix(eye) {
  const safeEye = sanitizeEye(eye);
  return mat4.translate(mat4.identity(), [-safeEye.x, -safeEye.y, -safeEye.z]);
}

function validateBounds(bounds) {
  if (!bounds || !Array.isArray(bounds.min) || !Array.isArray(bounds.max)
      || bounds.min.length !== 3 || bounds.max.length !== 3) {
    throw new Error('Model bounds must contain three-value min and max arrays.');
  }
  const min = bounds.min.map((value, axis) => finiteNumber(value, `bounds.min[${axis}]`));
  const max = bounds.max.map((value, axis) => finiteNumber(value, `bounds.max[${axis}]`));
  if (max.some((value, axis) => value < min[axis])) {
    throw new Error('Model bounds max must not be below min.');
  }
  return { min, max };
}

export function transformBounds(bounds, matrix) {
  const safeBounds = validateBounds(bounds);
  if (!matrix || matrix.length !== 16) {
    throw new Error('A 4x4 model matrix is required to transform bounds.');
  }
  const transformedMin = [Infinity, Infinity, Infinity];
  const transformedMax = [-Infinity, -Infinity, -Infinity];
  for (const x of [safeBounds.min[0], safeBounds.max[0]]) {
    for (const y of [safeBounds.min[1], safeBounds.max[1]]) {
      for (const z of [safeBounds.min[2], safeBounds.max[2]]) {
        const point = mat4.transformPoint(matrix, [x, y, z]);
        for (let axis = 0; axis < 3; axis += 1) {
          transformedMin[axis] = Math.min(transformedMin[axis], point[axis]);
          transformedMax[axis] = Math.max(transformedMax[axis], point[axis]);
        }
      }
    }
  }
  return { min: transformedMin, max: transformedMax };
}

export function computeMobileModelPlacement({
  bounds,
  screenWidth,
  screenHeight,
  baselineEyeZ,
  frontOffset = 0,
  occupancy = 0.92,
  near = 0.05,
  minSupportedEyeZ = 0.8,
}) {
  const safeBounds = validateBounds(bounds);
  finiteNumber(screenWidth, 'screenWidth');
  finiteNumber(screenHeight, 'screenHeight');
  finiteNumber(baselineEyeZ, 'baselineEyeZ');
  finiteNumber(frontOffset, 'frontOffset');
  finiteNumber(occupancy, 'occupancy');
  finiteNumber(near, 'near');
  finiteNumber(minSupportedEyeZ, 'minSupportedEyeZ');
  if (!(screenWidth > 0) || !(screenHeight > 0) || !(baselineEyeZ > 0)
      || !(occupancy > 0 && occupancy <= 1) || !(near > 0)
      || !(minSupportedEyeZ > near)) {
    throw new Error('Mobile placement dimensions, eye distance, occupancy, and near plane are invalid.');
  }

  const width = Math.max(safeBounds.max[0] - safeBounds.min[0], 1e-6);
  const height = Math.max(safeBounds.max[1] - safeBounds.min[1], 1e-6);
  const scale = occupancy * Math.min(screenWidth / width, screenHeight / height);
  const centerX = (safeBounds.min[0] + safeBounds.max[0]) / 2;
  const centerY = (safeBounds.min[1] + safeBounds.max[1]) / 2;
  const maxSafeFront = minSupportedEyeZ - near * 2;
  const effectiveFrontOffset = Math.min(frontOffset, maxSafeFront);
  const translation = [
    -centerX * scale,
    -centerY * scale,
    effectiveFrontOffset - safeBounds.max[2] * scale,
  ];
  let modelMatrix = mat4.identity();
  modelMatrix = mat4.translate(modelMatrix, translation);
  modelMatrix = mat4.scale(modelMatrix, scale);
  const transformedBounds = transformBounds(safeBounds, modelMatrix);
  const far = Math.max(10, baselineEyeZ - transformedBounds.min[2] + 2);
  return {
    modelMatrix,
    scale,
    translation,
    frontOffset: effectiveFrontOffset,
    transformedBounds,
    far,
  };
}

export function keepModelBehindEye({
  bounds,
  modelMatrix,
  eye,
  near,
  gap = 0.02,
}) {
  const safeEye = sanitizeEye(eye);
  finiteNumber(near, 'near');
  finiteNumber(gap, 'gap');
  if (!(near > 0) || gap < 0) {
    throw new Error('Clip safety requires a positive near plane and non-negative gap.');
  }
  let safeMatrix = new Float32Array(modelMatrix);
  let transformedBounds = transformBounds(bounds, safeMatrix);
  const maxAllowedZ = safeEye.z - near - gap;
  let correctionZ = 0;
  if (transformedBounds.max[2] > maxAllowedZ) {
    correctionZ = maxAllowedZ - transformedBounds.max[2];
    const correction = mat4.translate(mat4.identity(), [0, 0, correctionZ]);
    safeMatrix = mat4.multiply(correction, safeMatrix);
    transformedBounds = transformBounds(bounds, safeMatrix);
  }
  return {
    modelMatrix: safeMatrix,
    transformedBounds,
    correctionZ,
    far: Math.max(10, safeEye.z - transformedBounds.min[2] + 2),
  };
}
