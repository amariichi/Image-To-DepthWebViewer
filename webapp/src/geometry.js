import { preprocessDepth } from './depth-processing.js';
import { writeDeformedPositions } from './mesh-evaluator.js';
import { computeDepthStats, decodeRgbdeComponentsFromBlob } from './rgbde-decoder.js';

export { computeDepthStats } from './rgbde-decoder.js';

const TARGET_MESH = 250000;
const MESH_DIFF = 2000;
const MIN_DEPTH_CLAMP = 0.15;
const CENTER_Z_MIN = -4.0;
const CENTER_Z_MAX = -0.25;
const MIN_FOV_Y = (30 * Math.PI) / 180;
const MAX_FOV_Y = (110 * Math.PI) / 180;

export const DEFAULT_CENTER_Z = CENTER_Z_MIN;

let decodeWorkerState = null;
let decodeWorkerRequestId = 0;

export async function decodeRgbdeComponents(file) {
  const blob = file instanceof Blob ? file : new Blob([file]);
  const decoded = await decodeRgbdeComponentsFromBlob(blob);

  return {
    ...decoded,
    textureImage: new ImageData(decoded.leftPixels, decoded.width, decoded.height),
  };
}

export async function decodeRgbdeFile(file, options = {}) {
  const { useWorker = true, includeMetrics = false } = options;
  const decoded = useWorker ? await decodeRgbdeFileWithWorker(file) : await decodeRgbdeFileSync(file);
  if (!includeMetrics) {
    delete decoded.metrics;
  }
  return decoded;
}

async function decodeRgbdeFileSync(file) {
  const decoded = await decodeRgbdeComponents(file);
  const smoothedDepth = preprocessDepth(decoded.depth, decoded.leftPixels, decoded.width, decoded.height);
  const stats = computeDepthStats(smoothedDepth);

  return {
    ...decoded,
    depth: smoothedDepth,
    depthStats: stats,
  };
}

async function decodeRgbdeFileWithWorker(file) {
  if (typeof Worker === 'undefined') {
    return decodeRgbdeFileSync(file);
  }

  try {
    const workerState = getDecodeWorkerState();
    const requestId = ++decodeWorkerRequestId;
    const blob = file instanceof Blob ? file : new Blob([file]);

    return await new Promise((resolve, reject) => {
      workerState.pending.set(requestId, { resolve, reject });
      workerState.worker.postMessage({ id: requestId, blob });
    });
  } catch (error) {
    console.warn('Falling back to main-thread RGBDE decode.', error);
    return decodeRgbdeFileSync(file);
  }
}

function getDecodeWorkerState() {
  if (decodeWorkerState) {
    return decodeWorkerState;
  }

  const worker = new Worker(new URL('./rgbde-worker.js', import.meta.url), { type: 'module' });
  const pending = new Map();
  worker.addEventListener('message', (event) => {
    const { id, ok, error, width, height, leftPixelsBuffer, depthBuffer, depthStats, metadata, metrics } = event.data || {};
    const entry = pending.get(id);
    if (!entry) {
      return;
    }
    pending.delete(id);

    if (!ok) {
      entry.reject(new Error(error || 'RGBDE worker failed.'));
      return;
    }

    const leftPixels = new Uint8ClampedArray(leftPixelsBuffer);
    const depth = new Float32Array(depthBuffer);
    entry.resolve({
      width,
      height,
      leftPixels,
      depth,
      depthStats,
      metadata,
      textureImage: new ImageData(leftPixels, width, height),
      metrics,
    });
  });
  worker.addEventListener('error', (event) => {
    for (const entry of pending.values()) {
      entry.reject(event.error || new Error('RGBDE worker failed to load.'));
    }
    pending.clear();
    decodeWorkerState = null;
  });

  decodeWorkerState = { worker, pending };
  return decodeWorkerState;
}

export function findBestMeshSize(width, height, target = TARGET_MESH, meshDiff = MESH_DIFF) {
  const aspectRatio = width / height;
  const minMesh = Math.max(1, target - meshDiff);
  const maxMesh = target + meshDiff;
  let bestError = Number.POSITIVE_INFINITY;
  let bestX = 0;
  let bestY = 0;

  for (let t = minMesh; t <= maxMesh; t++) {
    const approxX = Math.round(Math.sqrt(t * aspectRatio));
    if (approxX <= 0) continue;
    const approxY = Math.round(t / approxX);
    const product = approxX * approxY;
    if (product < minMesh || product > maxMesh) continue;
    const ratioError = Math.abs(approxX / approxY - aspectRatio);
    if (ratioError < bestError) {
      bestError = ratioError;
      bestX = approxX;
      bestY = approxY;
    }
  }
  return { meshX: bestX, meshY: bestY };
}

export function generatePerspectiveMesh({
  depth,
  width,
  height,
  meshX,
  meshY,
  depthMin,
  depthMax,
  centerZ = DEFAULT_CENTER_Z,
  fovDegrees,
}) {
  const vertCount = (meshX + 1) * (meshY + 1);
  const positions = new Float32Array(vertCount * 3);
  const rayDirections = new Float32Array(vertCount * 3);
  const baseDepths = new Float32Array(vertCount);
  const uvs = new Float32Array(vertCount * 2);

  const indices = new Uint32Array(meshX * meshY * 6);
  let baseMinZ = Number.POSITIVE_INFINITY;
  let baseMaxZ = Number.NEGATIVE_INFINITY;

  const widthMinusOne = Math.max(1, width - 1);
  const heightMinusOne = Math.max(1, height - 1);

  let fovY;
  if (typeof fovDegrees === 'number' && Number.isFinite(fovDegrees)) {
    const clampedDeg = Math.min(Math.max(fovDegrees, 15), 120);
    fovY = (clampedDeg * Math.PI) / 180;
  } else {
    fovY = computeVerticalFov(centerZ);
  }
  const aspect = width / height;
  const fovX = 2 * Math.atan(Math.tan(fovY / 2) * aspect);
  const tanHalfX = Math.tan(fovX / 2);
  const tanHalfY = Math.tan(fovY / 2);

  let index = 0;
  for (let lat = 0; lat <= meshY; lat++) {
    const meshV = lat / meshY;
    const pixelY = meshV * heightMinusOne;
    for (let lon = 0; lon <= meshX; lon++) {
      const u = lon / meshX;
      const pixelX = u * widthMinusOne;
      const screenX = (u - 0.5) * 2 * tanHalfX;
      const screenY = (0.5 - meshV) * 2 * tanHalfY;
      // Not a unit vector. Depth Pro reports depth along the optical axis --
      // `depth = 1 / (canonical_inverse_depth * W / f_px)` is the pinhole
      // relation between disparity and z -- so a sample belongs at
      // `(screenX * d, screenY * d, -d)`. Multiplying a unit ray by it instead
      // treats the figure as a distance along the ray and places everything
      // off-axis too close, by cos of its angle from the axis: about 4 percent
      // at the top of a 32 degree capture and 21 at the corner of a 65 degree
      // one. Across a face that is several centimetres of depth gradient where
      // there should be none, which reads as the head being tilted.
      const dirX = screenX;
      const dirY = screenY;
      const dirZ = 1;
      const depthValue = sampleDepth(depth, width, height, pixelX, pixelY, depthMin);
      const px = dirX * depthValue;
      const py = dirY * depthValue;
      const pz = -dirZ * depthValue;

      positions[index * 3] = px;
      positions[index * 3 + 1] = py;
      positions[index * 3 + 2] = pz;

      if (pz < baseMinZ) baseMinZ = pz;
      if (pz > baseMaxZ) baseMaxZ = pz;

      rayDirections[index * 3] = dirX;
      rayDirections[index * 3 + 1] = dirY;
      rayDirections[index * 3 + 2] = -dirZ;

      baseDepths[index] = depthValue;

      uvs[index * 2] = pixelX / widthMinusOne;
      uvs[index * 2 + 1] = meshV;
      index++;
    }
  }

  let tri = 0;
  for (let lat = 0; lat < meshY; lat++) {
    for (let lon = 0; lon < meshX; lon++) {
      const current = lat * (meshX + 1) + lon;
      const next = current + meshX + 1;
      indices[tri++] = current;
      indices[tri++] = next;
      indices[tri++] = current + 1;
      indices[tri++] = current + 1;
      indices[tri++] = next;
      indices[tri++] = next + 1;
    }
  }

  return {
    positions,
    rayDirections,
    baseDepths,
    uvs,
    indices,
    vertexCount: vertCount,
    indexCount: indices.length,
    baseDepthMin: Math.max(depthMin, MIN_DEPTH_CLAMP),
    baseDepthMax: depthMax,
    meshX,
    meshY,
    baseMinZ,
    baseMaxZ,
  };
}

export function updateVertexPositions(mesh, options) {
  writeDeformedPositions(mesh, options, mesh.positions);
}

function sampleDepth(depth, width, height, x, y, fallback) {
  const ix = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const iy = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const fx = Math.max(0, Math.min(width - 1, Math.ceil(x)));
  const fy = Math.max(0, Math.min(height - 1, Math.ceil(y)));
  const tx = x - ix;
  const ty = y - iy;

  const d00 = depth[iy * width + ix];
  const d10 = depth[iy * width + fx];
  const d01 = depth[fy * width + ix];
  const d11 = depth[fy * width + fx];

  const top = d00 + (d10 - d00) * tx;
  const bottom = d01 + (d11 - d01) * tx;
  const value = top + (bottom - top) * ty;
  if (value > 0) {
    return value;
  }
  return Math.max(d00, fallback);
}

function computeVerticalFov(centerOffset) {
  const clamped = Math.min(Math.max(centerOffset, CENTER_Z_MIN), CENTER_Z_MAX);
  const t = (clamped - CENTER_Z_MIN) / (CENTER_Z_MAX - CENTER_Z_MIN);
  return MIN_FOV_Y + (MAX_FOV_Y - MIN_FOV_Y) * t;
}
