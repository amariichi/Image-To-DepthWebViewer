import { findBestMeshSize, generatePerspectiveMesh } from './geometry.js';
import { MAX_MOBILE_PUBLISH_VERTICES } from './mobile-publish-mesh.js';

export const SOURCE_ORIGINS = Object.freeze({
  PUBLISHED_GLB: 'published-glb',
  LOCAL_RGBDE: 'local-rgbde',
});

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function validFov(value) {
  return Number.isFinite(value) && value > 0 && value < 180 ? value : null;
}

function computeBounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[offset + axis];
      if (!Number.isFinite(value)) {
        throw new Error('Mobile source POSITION data must be finite.');
      }
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}

function validateGeometry({ positions, uvs, indices }) {
  if (!(positions instanceof Float32Array) || positions.length < 3
      || positions.length % 3 !== 0) {
    throw new Error('Mobile source requires Float32 POSITION data.');
  }
  if (!(uvs instanceof Float32Array) || uvs.length !== (positions.length / 3) * 2) {
    throw new Error('Mobile source requires one Float32 UV for every position.');
  }
  if (!(indices instanceof Uint8Array) && !(indices instanceof Uint16Array)
      && !(indices instanceof Uint32Array)) {
    throw new Error('Mobile source indices must be an unsigned typed array.');
  }
  if (indices.length < 3 || indices.length % 3 !== 0) {
    throw new Error('Mobile source requires triangle indices.');
  }
  const vertexCount = positions.length / 3;
  for (const index of indices) {
    if (index >= vertexCount) throw new Error('Mobile source index is outside POSITION data.');
  }
}

function normalizeSource({
  positions,
  uvs,
  indices,
  sourceWidth,
  sourceHeight,
  captureFovDeg,
  sourceName,
  origin,
  texture,
}) {
  validateGeometry({ positions, uvs, indices });
  positiveInteger(sourceWidth, 'sourceWidth');
  positiveInteger(sourceHeight, 'sourceHeight');
  if (!Object.values(SOURCE_ORIGINS).includes(origin)) {
    throw new Error('Mobile source origin is invalid.');
  }
  if (!texture) throw new Error('Mobile source requires a texture.');
  const scene = {
    // Typed arrays cannot be made deeply immutable without copying them into an
    // unusable shape. Ownership passes to this object and presentation code is
    // required to derive new arrays rather than mutate these raw buffers.
    positions,
    uvs,
    indices,
    bounds: computeBounds(positions),
    sourceWidth,
    sourceHeight,
    captureFovDeg: validFov(captureFovDeg),
    sourceName: typeof sourceName === 'string' && sourceName.trim()
      ? sourceName.trim()
      : origin === SOURCE_ORIGINS.PUBLISHED_GLB ? 'published-scene.glb' : 'pasted-image',
    origin,
  };
  Object.freeze(scene.bounds.min);
  Object.freeze(scene.bounds.max);
  Object.freeze(scene.bounds);
  return Object.freeze(scene);
}

function imageSize(texture) {
  const width = Number(texture?.naturalWidth || texture?.videoWidth || texture?.width);
  const height = Number(texture?.naturalHeight || texture?.videoHeight || texture?.height);
  return {
    width: positiveInteger(width, 'texture.width'),
    height: positiveInteger(height, 'texture.height'),
  };
}

export function createSourceSceneFromGlb(parsedGlb, manifest = {}, texture) {
  const size = imageSize(texture);
  return normalizeSource({
    positions: parsedGlb?.positions,
    uvs: parsedGlb?.uvs,
    indices: parsedGlb?.indices,
    sourceWidth: size.width,
    sourceHeight: size.height,
    captureFovDeg: manifest?.captureFovDeg,
    sourceName: manifest?.sourceName,
    origin: SOURCE_ORIGINS.PUBLISHED_GLB,
    texture,
  });
}

function chooseMeshSize(width, height, maxVertices) {
  positiveInteger(maxVertices, 'maxVertices');
  if (maxVertices < 4) throw new Error('Mobile RGBDE mesh budget must allow four vertices.');
  // findBestMeshSize targets cells, while the generated grid has one extra row
  // and column. Reserve that boundary and then enforce the exact vertex budget.
  const boundaryReserve = Math.ceil(2 * Math.sqrt(maxVertices)) + 1;
  const cellTarget = Math.max(1, maxVertices - boundaryReserve);
  const meshDiff = Math.min(2_000, Math.max(0, cellTarget - 1));
  let { meshX, meshY } = findBestMeshSize(width, height, cellTarget, meshDiff);
  if (!(meshX > 0) || !(meshY > 0)) {
    const aspect = width / height;
    meshX = Math.max(1, Math.floor(Math.sqrt(cellTarget * aspect)));
    meshY = Math.max(1, Math.floor(cellTarget / meshX));
  }
  // A denser grid would only duplicate source rays and depth samples.
  meshX = Math.min(meshX, Math.max(1, width - 1));
  meshY = Math.min(meshY, Math.max(1, height - 1));
  while ((meshX + 1) * (meshY + 1) > maxVertices) {
    if (meshX >= meshY && meshX > 1) meshX -= 1;
    else if (meshY > 1) meshY -= 1;
    else break;
  }
  return { meshX, meshY };
}

function compactIndices(indices, vertexCount) {
  if (vertexCount <= 255) return new Uint8Array(indices);
  if (vertexCount <= 65_535) return new Uint16Array(indices);
  return indices;
}

export function createSourceSceneFromRgbde(decoded, {
  maxVertices = MAX_MOBILE_PUBLISH_VERTICES,
  fovDeg = null,
  sourceName = 'pasted-image',
  texture = decoded?.textureImage,
} = {}) {
  const width = positiveInteger(decoded?.width, 'decoded.width');
  const height = positiveInteger(decoded?.height, 'decoded.height');
  if (!(decoded?.depth instanceof Float32Array) || decoded.depth.length !== width * height) {
    throw new Error('Decoded RGBDE depth does not match its dimensions.');
  }
  const captureFovDeg = validFov(fovDeg) ?? validFov(decoded?.metadata?.verticalFovDeg);
  if (captureFovDeg === null) {
    return Object.freeze({
      kind: 'needs-fov',
      needsFov: true,
      width,
      height,
      decoded,
      sourceName,
    });
  }
  const depthMin = Number(decoded?.depthStats?.min);
  const depthMax = Number(decoded?.depthStats?.max);
  if (!Number.isFinite(depthMin) || !(depthMin > 0)
      || !Number.isFinite(depthMax) || !(depthMax >= depthMin)) {
    throw new Error('Decoded RGBDE depth statistics are invalid.');
  }
  const { meshX, meshY } = chooseMeshSize(width, height, maxVertices);
  const mesh = generatePerspectiveMesh({
    depth: decoded.depth,
    width,
    height,
    meshX,
    meshY,
    depthMin,
    depthMax,
    fovDegrees: captureFovDeg,
  });
  const vertexCount = mesh.positions.length / 3;
  return normalizeSource({
    positions: mesh.positions,
    uvs: mesh.uvs,
    indices: compactIndices(mesh.indices, vertexCount),
    sourceWidth: width,
    sourceHeight: height,
    captureFovDeg,
    sourceName,
    origin: SOURCE_ORIGINS.LOCAL_RGBDE,
    texture,
  });
}

// Worker-side RGBDE construction returns already-built geometry so the main
// thread never repeats depth preprocessing or unprojection. This constructor
// applies the same source contract without needing the worker's released depth
// buffer.
export function createSourceSceneFromBuiltRgbde(built, {
  texture,
  sourceName = 'pasted-image',
} = {}) {
  return normalizeSource({
    positions: built?.positions,
    uvs: built?.uvs,
    indices: built?.indices,
    sourceWidth: positiveInteger(built?.width, 'built.width'),
    sourceHeight: positiveInteger(built?.height, 'built.height'),
    captureFovDeg: built?.captureFovDeg,
    sourceName,
    origin: SOURCE_ORIGINS.LOCAL_RGBDE,
    texture,
  });
}
