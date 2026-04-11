const MIN_DEPTH_CLAMP = 0.15;
const OFFSET = 0.3;

function buildParams(mesh, options = {}) {
  return {
    minDepth: Math.max(mesh.baseDepthMin ?? MIN_DEPTH_CLAMP, MIN_DEPTH_CLAMP),
    farLimit: Number.isFinite(options.farClip) ? options.farClip : Number.POSITIVE_INFINITY,
    magnification: Number.isFinite(options.magnification) ? options.magnification : 1,
    mode: options.mode === 'log' ? 'log' : 'linear',
    logPower: Number.isFinite(options.logPower) ? Math.max(options.logPower, 0.1) : 1,
  };
}

export function evaluateShapedDepth(baseDepth, mesh, options = {}) {
  const params = buildParams(mesh, options);
  return evaluateShapedDepthWithParams(baseDepth, params);
}

function evaluateShapedDepthWithParams(baseDepth, params) {
  const relative = Math.max(baseDepth - params.minDepth + OFFSET, 0.001);
  let shaped = baseDepth;
  if (params.mode === 'log') {
    shaped = params.minDepth + Math.log(1 + Math.pow(relative, params.logPower));
  }
  const scaled = params.minDepth + params.magnification * (shaped - params.minDepth);
  return Math.min(Math.max(scaled, params.minDepth + 0.001), params.farLimit);
}

export function writeDeformedPositions(mesh, options = {}, out = new Float32Array(mesh.positions.length)) {
  const params = buildParams(mesh, options);
  const { rayDirections, baseDepths } = mesh;

  for (let i = 0; i < baseDepths.length; i += 1) {
    const depth = evaluateShapedDepthWithParams(baseDepths[i], params);
    const offset = i * 3;
    out[offset] = rayDirections[offset] * depth;
    out[offset + 1] = rayDirections[offset + 1] * depth;
    out[offset + 2] = rayDirections[offset + 2] * depth;
  }

  return out;
}

export function createDeformedPositions(mesh, options = {}) {
  return writeDeformedPositions(mesh, options);
}

export function computeDeformedBounds(mesh, options = {}) {
  const params = buildParams(mesh, options);
  const { rayDirections, baseDepths } = mesh;

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < baseDepths.length; i += 1) {
    const depth = evaluateShapedDepthWithParams(baseDepths[i], params);
    const offset = i * 3;
    const x = rayDirections[offset] * depth;
    const y = rayDirections[offset + 1] * depth;
    const z = rayDirections[offset + 2] * depth;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  const sizeX = maxX - minX;
  const sizeY = maxY - minY;
  const sizeZ = maxZ - minZ;
  return {
    minX,
    maxX,
    minY,
    maxY,
    minZ,
    maxZ,
    sizeX,
    sizeY,
    sizeZ,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    centerZ: (minZ + maxZ) / 2,
    maxSpan: Math.max(sizeX, sizeY, sizeZ),
    radius: Math.max(sizeX, sizeY) * 0.5,
  };
}
