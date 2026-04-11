const DEPTH_SPIKE_THRESHOLD = 0.45;
const DEPTH_STABLE_TOLERANCE = 0.12;
const COLOR_EDGE_THRESHOLD = 0.1;
const SMOOTH_BLEND = 0.3;
const BILATERAL_DEPTH_SIGMA = 0.35;
const BILATERAL_COLOR_SIGMA = 0.08;

const INV_2_DEPTH_SIGMA_SQ = 1 / (2 * BILATERAL_DEPTH_SIGMA * BILATERAL_DEPTH_SIGMA);
const INV_2_COLOR_SIGMA_SQ = 1 / (2 * BILATERAL_COLOR_SIGMA * BILATERAL_COLOR_SIGMA);

const SPATIAL_KERNEL = [
  0.075, 0.124, 0.075,
  0.124, 0.204, 0.124,
  0.075, 0.124, 0.075,
];

export function preprocessDepth(depth, colors, width, height) {
  if (!depth || !colors) {
    return depth;
  }
  const spikeReduced = reduceDepthSpikes(depth, colors, width, height);
  return applyEdgeAwareSmooth(spikeReduced, colors, width, height);
}

export function median9(values) {
  for (let i = 1; i < 9; i++) {
    const current = values[i];
    let j = i - 1;
    while (j >= 0 && values[j] > current) {
      values[j + 1] = values[j];
      j--;
    }
    values[j + 1] = current;
  }
  return values[4];
}

export function reduceDepthSpikes(depth, colors, width, height) {
  const result = new Float32Array(depth);
  const window = new Float32Array(9);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const center = depth[idx];
      if (center <= 0) {
        continue;
      }

      let windowIndex = 0;
      for (let ky = -1; ky <= 1; ky++) {
        const ny = clampIndex(y + ky, height);
        for (let kx = -1; kx <= 1; kx++) {
          const nx = clampIndex(x + kx, width);
          window[windowIndex++] = depth[ny * width + nx];
        }
      }

      const median = median9(window);
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
          const neighborOffset = (ny * width + nx) * 4;
          colorDiffAccum += colorDistance(
            cr,
            cg,
            cb,
            colors[neighborOffset],
            colors[neighborOffset + 1],
            colors[neighborOffset + 2],
          );
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

export function applyEdgeAwareSmooth(depth, colors, width, height) {
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
          const depthWeight = Math.exp(-(depthDiff * depthDiff) * INV_2_DEPTH_SIGMA_SQ);
          const neighborOffset = (ny * width + nx) * 4;
          const colorDiffSq = colorDistanceSquared(
            cr,
            cg,
            cb,
            colors[neighborOffset],
            colors[neighborOffset + 1],
            colors[neighborOffset + 2],
          );
          const colorWeight = Math.exp(-colorDiffSq * INV_2_COLOR_SIGMA_SQ);
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

export function colorDistanceSquared(r1, g1, b1, r2, g2, b2) {
  const dr = (r1 - r2) / 255;
  const dg = (g1 - g2) / 255;
  const db = (b1 - b2) / 255;
  return dr * dr + dg * dg + db * db;
}

function colorDistance(r1, g1, b1, r2, g2, b2) {
  return Math.sqrt(colorDistanceSquared(r1, g1, b1, r2, g2, b2));
}

function clampIndex(value, size) {
  if (value < 0) return 0;
  if (value >= size) return size - 1;
  return value;
}
