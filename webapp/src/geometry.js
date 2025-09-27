const TARGET_MESH = 250000;
const MESH_DIFF = 2000;
const MIN_DEPTH_CLAMP = 0.15;
const OFFSET = 0.3;
const CENTER_Z_MIN = -4.0;
const CENTER_Z_MAX = -0.25;
const MIN_FOV_Y = (30 * Math.PI) / 180;
const MAX_FOV_Y = (110 * Math.PI) / 180;
const DEPTH_SPIKE_THRESHOLD = 0.45;
const DEPTH_STABLE_TOLERANCE = 0.12;
const COLOR_EDGE_THRESHOLD = 0.1;
const SMOOTH_BLEND = 0.3;
const BILATERAL_DEPTH_SIGMA = 0.35;
const BILATERAL_COLOR_SIGMA = 0.08;

const SPATIAL_KERNEL = [
  0.075, 0.124, 0.075,
  0.124, 0.204, 0.124,
  0.075, 0.124, 0.075,
];

export const DEFAULT_CENTER_Z = CENTER_Z_MIN;

export async function decodeRgbdeFile(file) {
  const blob = file instanceof Blob ? file : new Blob([file]);
  const { width: fullWidth, height, data } = await parsePng(blob);
  if (fullWidth % 2 !== 0) {
    throw new Error('RGBDE PNG must have even width (RGB + depth halves).');
  }

  const width = fullWidth / 2;
  const leftPixels = new Uint8ClampedArray(width * height * 4);
  const depthValues = new Float32Array(width * height);

  let depthMin = Number.POSITIVE_INFINITY;
  let depthMax = 0;

  for (let y = 0; y < height; y++) {
    const srcRow = y * fullWidth * 4;
    const leftRow = y * width * 4;
    const rightRow = srcRow + width * 4;
    for (let x = 0; x < width; x++) {
      const srcIndex = srcRow + x * 4;
      const dstIndex = leftRow + x * 4;
      leftPixels[dstIndex] = data[srcIndex];
      leftPixels[dstIndex + 1] = data[srcIndex + 1];
      leftPixels[dstIndex + 2] = data[srcIndex + 2];
      leftPixels[dstIndex + 3] = 255;
    }
    for (let x = 0; x < width; x++) {
      const depthIndex = rightRow + x * 4;
      const r = data[depthIndex];
      const g = data[depthIndex + 1];
      const b = data[depthIndex + 2];
      const a = data[depthIndex + 3];
      if (x < 2 && y < 2) {
        console.info('Raw depth bytes', { x, y, r, g, b, a });
      }
      const encoded = (((a << 24) >>> 0) + (b << 16) + (g << 8) + r) >>> 0;
      const depth = encoded / 10000;
      depthValues[y * width + x] = depth;
      if (depth > 0) {
        depthMin = Math.min(depthMin, depth);
        depthMax = Math.max(depthMax, depth);
      }
    }
  }

  if (!Number.isFinite(depthMin)) {
    depthMin = MIN_DEPTH_CLAMP;
  }

  const smoothedDepth = preprocessDepth(depthValues, leftPixels, width, height);
  const stats = computeDepthStats(smoothedDepth);
  console.info('Depth stats', { min: stats.min, max: stats.max });

  return {
    width,
    height,
    leftPixels,
    depth: smoothedDepth,
    depthStats: stats,
    textureImage: new ImageData(leftPixels, width, height),
  };
}

function preprocessDepth(depth, colors, width, height) {
  if (!depth || !colors) {
    return depth;
  }
  const spikeReduced = reduceDepthSpikes(depth, colors, width, height);
  return applyEdgeAwareSmooth(spikeReduced, colors, width, height);
}

function reduceDepthSpikes(depth, colors, width, height) {
  const result = new Float32Array(depth);
  const window = new Float32Array(9);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const center = depth[idx];
      if (center <= 0) {
        continue;
      }
      let w = 0;
      for (let ky = -1; ky <= 1; ky++) {
        const ny = clampIndex(y + ky, height);
        for (let kx = -1; kx <= 1; kx++) {
          const nx = clampIndex(x + kx, width);
          window[w++] = depth[ny * width + nx];
        }
      }
      const sorted = Array.from(window).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (!Number.isFinite(median)) {
        continue;
      }
      if (Math.abs(center - median) <= DEPTH_SPIKE_THRESHOLD) {
        continue;
      }
      let stableCount = 0;
      let colorDiffAccum = 0;
      let neighborCount = 0;
      const baseOffset = idx * 4;
      const cr = colors[baseOffset];
      const cg = colors[baseOffset + 1];
      const cb = colors[baseOffset + 2];
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          if (kx === 0 && ky === 0) continue;
          const ny = clampIndex(y + ky, height);
          const nx = clampIndex(x + kx, width);
          const neighbor = depth[ny * width + nx];
          if (Math.abs(neighbor - median) < DEPTH_STABLE_TOLERANCE) {
            stableCount++;
          }
          const no = (ny * width + nx) * 4;
          colorDiffAccum += colorDistance(cr, cg, cb, colors[no], colors[no + 1], colors[no + 2]);
          neighborCount++;
        }
      }
      const avgColorDiff = neighborCount > 0 ? colorDiffAccum / neighborCount : 0;
      if (stableCount >= 5 && avgColorDiff < COLOR_EDGE_THRESHOLD) {
        result[idx] = median;
      }
    }
  }
  return result;
}

function applyEdgeAwareSmooth(depth, colors, width, height) {
  const result = new Float32Array(depth.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const center = depth[idx];
      if (center <= 0) {
        result[idx] = center;
        continue;
      }
      const baseOffset = idx * 4;
      const cr = colors[baseOffset];
      const cg = colors[baseOffset + 1];
      const cb = colors[baseOffset + 2];
      let accum = 0;
      let weightSum = 0;
      let kernelIndex = 0;
      for (let ky = -1; ky <= 1; ky++) {
        const ny = clampIndex(y + ky, height);
        for (let kx = -1; kx <= 1; kx++) {
          const nx = clampIndex(x + kx, width);
          const neighbor = depth[ny * width + nx];
          const spatial = SPATIAL_KERNEL[kernelIndex++];
          const depthDiff = neighbor - center;
          const depthWeight = Math.exp(-(depthDiff * depthDiff) / (2 * BILATERAL_DEPTH_SIGMA * BILATERAL_DEPTH_SIGMA));
          const no = (ny * width + nx) * 4;
          const colorDiff = colorDistance(cr, cg, cb, colors[no], colors[no + 1], colors[no + 2]);
          const colorWeight = Math.exp(-(colorDiff * colorDiff) / (2 * BILATERAL_COLOR_SIGMA * BILATERAL_COLOR_SIGMA));
          const weight = spatial * depthWeight * colorWeight;
          accum += neighbor * weight;
          weightSum += weight;
        }
      }
      const smoothed = weightSum > 0 ? accum / weightSum : center;
      result[idx] = center + (smoothed - center) * SMOOTH_BLEND;
    }
  }
  return result;
}

function colorDistance(r1, g1, b1, r2, g2, b2) {
  const dr = (r1 - r2) / 255;
  const dg = (g1 - g2) / 255;
  const db = (b1 - b2) / 255;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function clampIndex(value, size) {
  if (value < 0) return 0;
  if (value >= size) return size - 1;
  return value;
}

function computeDepthStats(depth) {
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (let i = 0; i < depth.length; i++) {
    const d = depth[i];
    if (d > 0) {
      if (d < min) min = d;
      if (d > max) max = d;
    }
  }
  if (!Number.isFinite(min)) min = MIN_DEPTH_CLAMP;
  if (max <= 0) max = min + 1;
  return { min, max };
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
      const dir = normalize3(screenX, screenY, 1);
      const depthValue = sampleDepth(depth, width, height, pixelX, pixelY, depthMin);
      const px = dir[0] * depthValue;
      const py = dir[1] * depthValue;
      const pz = -dir[2] * depthValue;

      positions[index * 3] = px;
      positions[index * 3 + 1] = py;
      positions[index * 3 + 2] = pz;

      if (pz < baseMinZ) baseMinZ = pz;
      if (pz > baseMaxZ) baseMaxZ = pz;

      rayDirections[index * 3] = dir[0];
      rayDirections[index * 3 + 1] = dir[1];
      rayDirections[index * 3 + 2] = -dir[2];

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
  const {
    positions,
    rayDirections,
    baseDepths,
    baseDepthMin,
  } = mesh;
  const {
    magnification,
    farClip,
    mode,
    logPower,
  } = options;

  const minDepth = Math.max(baseDepthMin, MIN_DEPTH_CLAMP);
  const farLimit = Number.isFinite(farClip) ? farClip : Number.POSITIVE_INFINITY;
  const scaledMin = minDepth;

  for (let i = 0; i < baseDepths.length; i++) {
    const dirX = rayDirections[i * 3];
    const dirY = rayDirections[i * 3 + 1];
    const dirZ = rayDirections[i * 3 + 2];
    const base = baseDepths[i];
    const relative = Math.max(base - minDepth + OFFSET, 0.001);
    let shaped = base;
    if (mode === 'log') {
      shaped = minDepth + Math.log(1 + Math.pow(relative, logPower));
    }
    const scaled = scaledMin + magnification * (shaped - scaledMin);
    const depth = Math.min(Math.max(scaled, scaledMin + 0.001), farLimit);
    positions[i * 3] = dirX * depth;
    positions[i * 3 + 1] = dirY * depth;
    positions[i * 3 + 2] = dirZ * depth;
  }
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

function normalize3(x, y, z) {
  const len = Math.hypot(x, y, z);
  if (len === 0) return [0, 0, 1];
  return [x / len, y / len, z / len];
}

async function parsePng(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) {
      throw new Error('Invalid PNG signature');
    }
  }
  if (bytes.length < 33) {
    throw new Error('Invalid PNG signature');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];

  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    offset += 4;
    const type = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );
    offset += 4;

    if (type === 'IHDR') {
      width = view.getUint32(offset);
      height = view.getUint32(offset + 4);
      bitDepth = bytes[offset + 8];
      colorType = bytes[offset + 9];
      if (bitDepth !== 8 || colorType !== 6) {
        throw new Error(`Unsupported PNG format (bitDepth=${bitDepth}, colorType=${colorType})`);
      }
    } else if (type === 'IDAT') {
      idatChunks.push(bytes.slice(offset, offset + length));
    } else if (type === 'IEND') {
      break;
    }

    offset += length + 4; // skip data + CRC
  }

  const compressed = concatenate(idatChunks);
  const inflated = await inflateData(compressed);
  const stride = width * 4;
  const raw = new Uint8Array(width * height * 4);
  let src = 0;
  let dst = 0;

  for (let y = 0; y < height; y++) {
    const filterType = inflated[src++];
    switch (filterType) {
      case 0:
        for (let i = 0; i < stride; i++) {
          raw[dst + i] = inflated[src + i];
        }
        break;
      case 1:
        for (let x = 0; x < stride; x++) {
          const left = x >= 4 ? raw[dst + x - 4] : 0;
          raw[dst + x] = (inflated[src + x] + left) & 0xff;
        }
        break;
      case 2:
        for (let x = 0; x < stride; x++) {
          const up = y > 0 ? raw[dst + x - stride] : 0;
          raw[dst + x] = (inflated[src + x] + up) & 0xff;
        }
        break;
      case 3:
        for (let x = 0; x < stride; x++) {
          const left = x >= 4 ? raw[dst + x - 4] : 0;
          const up = y > 0 ? raw[dst + x - stride] : 0;
          const avg = ((left + up) >> 1) & 0xff;
          raw[dst + x] = (inflated[src + x] + avg) & 0xff;
        }
        break;
      case 4:
        for (let x = 0; x < stride; x++) {
          const left = x >= 4 ? raw[dst + x - 4] : 0;
          const up = y > 0 ? raw[dst + x - stride] : 0;
          const upLeft = y > 0 && x >= 4 ? raw[dst + x - stride - 4] : 0;
          raw[dst + x] = (inflated[src + x] + paeth(left, up, upLeft)) & 0xff;
        }
        break;
      default:
        throw new Error(`Unsupported PNG filter type: ${filterType}`);
    }
    src += stride;
    dst += stride;
  }

  return { width, height, data: raw };
}

function concatenate(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function inflateData(data) {
  if ('DecompressionStream' in window) {
    const stream = new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate')));
    const buffer = await stream.arrayBuffer();
    return new Uint8Array(buffer);
  }
  throw new Error('Deflate decompression is not supported in this browser.');
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
