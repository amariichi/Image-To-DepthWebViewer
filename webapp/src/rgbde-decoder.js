const MIN_DEPTH_CLAMP = 0.15;

export async function decodeRgbdeComponentsFromBlob(blob) {
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

  return {
    width,
    height,
    leftPixels,
    depth: depthValues,
    depthStats: {
      min: depthMin,
      max: depthMax > 0 ? depthMax : depthMin + 1,
    },
  };
}

export function computeDepthStats(depth) {
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
      bytes[offset + 3],
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
      idatChunks.push({ offset, length });
    } else if (type === 'IEND') {
      break;
    }

    offset += length + 4;
  }

  const compressed = concatenateRanges(bytes, idatChunks);
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

function concatenateRanges(bytes, ranges) {
  let total = 0;
  for (const range of ranges) total += range.length;
  const result = new Uint8Array(total);
  let resultOffset = 0;
  for (const range of ranges) {
    result.set(bytes.subarray(range.offset, range.offset + range.length), resultOffset);
    resultOffset += range.length;
  }
  return result;
}

async function inflateData(data) {
  if ('DecompressionStream' in globalThis) {
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
