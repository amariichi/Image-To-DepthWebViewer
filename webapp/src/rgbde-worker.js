import { preprocessDepth } from './depth-processing.js';
import { computeDepthStats, decodeRgbdeComponentsFromBlob } from './rgbde-decoder.js';

self.addEventListener('message', async (event) => {
  const { id, blob } = event.data || {};
  if (!id || !blob) {
    return;
  }

  try {
    const decodeStart = performance.now();
    const decoded = await decodeRgbdeComponentsFromBlob(blob);
    const decodeMs = performance.now() - decodeStart;

    const preprocessStart = performance.now();
    const preprocessedDepth = preprocessDepth(decoded.depth, decoded.leftPixels, decoded.width, decoded.height);
    const depthStats = computeDepthStats(preprocessedDepth);
    const preprocessMs = performance.now() - preprocessStart;

    self.postMessage(
      {
        id,
        ok: true,
        width: decoded.width,
        height: decoded.height,
        leftPixelsBuffer: decoded.leftPixels.buffer,
        depthBuffer: preprocessedDepth.buffer,
        depthStats,
        metadata: decoded.metadata,
        metrics: {
          decodeMs,
          preprocessMs,
          totalMs: decodeMs + preprocessMs,
        },
      },
      [decoded.leftPixels.buffer, preprocessedDepth.buffer],
    );
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
