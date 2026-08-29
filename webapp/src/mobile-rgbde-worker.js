import { preprocessDepth } from './depth-processing.js';
import { computeDepthStats } from './geometry.js';
import { decodeRgbdeComponentsFromBlob } from './rgbde-decoder.js';
import { createSourceSceneFromRgbde } from './mobile-source-scene.js';

function transferredResult(kind, payload, transfer = []) {
  return { message: { kind, ...payload }, transfer };
}

function requireId(id) {
  if (!Number.isInteger(id) || id < 1) throw new Error('RGBDE worker request id is invalid.');
  return id;
}

function requireBuffer(value, label) {
  if (!(value instanceof ArrayBuffer)) throw new Error(`${label} must be an ArrayBuffer.`);
  return value;
}

function successResult(id, decoded, scene, metrics) {
  const positions = scene.positions;
  const uvs = scene.uvs;
  const indices = scene.indices;
  const textureBuffer = decoded.leftPixels.buffer;
  return transferredResult('success', {
    id,
    width: decoded.width,
    height: decoded.height,
    metadata: decoded.metadata ?? null,
    depthStats: decoded.depthStats,
    captureFovDeg: scene.captureFovDeg,
    positions,
    uvs,
    indices,
    bounds: scene.bounds,
    textureBuffer,
    metrics,
  }, [positions.buffer, uvs.buffer, indices.buffer, textureBuffer]);
}

function buildDecoded(id, decoded, { maxVertices, fovDeg }, metrics = {}, onPhase = () => {}) {
  const captureFovDeg = Number.isFinite(fovDeg) && fovDeg > 0 && fovDeg < 180
    ? fovDeg
    : decoded?.metadata?.verticalFovDeg;
  if (!(Number.isFinite(captureFovDeg) && captureFovDeg > 0 && captureFovDeg < 180)) {
    const leftPixelsBuffer = decoded.leftPixels.buffer;
    const depthBuffer = decoded.depth.buffer;
    return transferredResult('needs-fov', {
      id,
      width: decoded.width,
      height: decoded.height,
      leftPixelsBuffer,
      depthBuffer,
      depthStats: decoded.depthStats,
      metadata: decoded.metadata ?? null,
      metrics,
    }, [leftPixelsBuffer, depthBuffer]);
  }
  onPhase('Building mesh');
  const buildStarted = performance.now();
  const scene = createSourceSceneFromRgbde(decoded, {
    maxVertices,
    fovDeg: captureFovDeg,
    texture: { width: decoded.width, height: decoded.height },
  });
  return successResult(id, decoded, scene, {
    ...metrics,
    meshMs: performance.now() - buildStarted,
    vertexCount: scene.positions.length / 3,
    indexCount: scene.indices.length,
  });
}

export async function processMobileRgbdeMessage(data, { onPhase = () => {} } = {}) {
  const id = requireId(data?.id);
  const maxVertices = Number.isInteger(data?.maxVertices) ? data.maxVertices : undefined;
  if (data?.kind === 'decode-and-build') {
    if (!(data.blob instanceof Blob) || data.blob.size === 0) {
      throw new Error('RGBDE worker requires a non-empty PNG blob.');
    }
    const decodeStarted = performance.now();
    const components = await decodeRgbdeComponentsFromBlob(data.blob);
    const decodeMs = performance.now() - decodeStarted;
    onPhase('Decoding depth');
    const preprocessStarted = performance.now();
    const depth = preprocessDepth(
      components.depth,
      components.leftPixels,
      components.width,
      components.height,
    );
    const decoded = {
      ...components,
      depth,
      depthStats: computeDepthStats(depth),
    };
    return buildDecoded(id, decoded, {
      maxVertices,
      fovDeg: data.fovDeg,
    }, {
      decodeMs,
      preprocessMs: performance.now() - preprocessStarted,
    }, onPhase);
  }
  if (data?.kind === 'build-decoded') {
    const width = Number(data.width);
    const height = Number(data.height);
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
      throw new Error('RGBDE worker decoded dimensions are invalid.');
    }
    const leftPixels = new Uint8ClampedArray(requireBuffer(
      data.leftPixelsBuffer,
      'leftPixelsBuffer',
    ));
    const depth = new Float32Array(requireBuffer(data.depthBuffer, 'depthBuffer'));
    if (leftPixels.length !== width * height * 4 || depth.length !== width * height) {
      throw new Error('RGBDE worker decoded buffers do not match their dimensions.');
    }
    return buildDecoded(id, {
      width,
      height,
      leftPixels,
      depth,
      depthStats: data.depthStats ?? computeDepthStats(depth),
      metadata: data.metadata ?? null,
    }, {
      maxVertices,
      fovDeg: data.fovDeg,
    }, {}, onPhase);
  }
  throw new Error('RGBDE worker request kind is unsupported.');
}

if (typeof globalThis.addEventListener === 'function'
    && typeof globalThis.postMessage === 'function'
    && typeof globalThis.document === 'undefined') {
  globalThis.addEventListener('message', (event) => {
    const id = event.data?.id;
    void processMobileRgbdeMessage(event.data, {
      onPhase(phase) {
        globalThis.postMessage({ kind: 'phase', id, phase });
      },
    }).then(({ message, transfer }) => {
      globalThis.postMessage(message, transfer);
    }).catch((error) => {
      globalThis.postMessage({
        kind: 'error',
        id,
        error: error?.message || 'RGBDE worker failed.',
      });
    });
  });
}
