// `baselineEyeZ` is only a fallback. The mobile viewer derives the real value
// from the device's physical screen size and the viewer's measured distance,
// because a virtual screen two world units tall must be viewed from roughly
// two screen heights away to match how a phone or tablet is actually held.
//
// `depthSpan` is the relief thickness in the same world units. One unit is half
// the physical screen height, so the default 1.0 places a miniature about one
// half-screen-height deep behind the glass. That is the thickness at which a
// near subject's relief is proportional to its on-screen size, which is what
// makes it read as a solid object instead of a flat card.
export const MOBILE_PRESENTATION_DEFAULTS = Object.freeze({
  frontOffset: 0,
  screenOccupancy: 0.92,
  baselineEyeZ: 4.5,
  depthSpan: 1,
  disparityBlend: 1,
});

export function mobileDepthSpanForMagnification(magnification) {
  const value = Number.isFinite(magnification) ? magnification : 0.5;
  return Math.min(Math.max(value * 2, 0.2), 1.8);
}

export function createMobileSceneManifest({
  sourceName,
  publishedAt = new Date().toISOString(),
  frontOffset = MOBILE_PRESENTATION_DEFAULTS.frontOffset,
  screenOccupancy = MOBILE_PRESENTATION_DEFAULTS.screenOccupancy,
  baselineEyeZ = MOBILE_PRESENTATION_DEFAULTS.baselineEyeZ,
  depthSpan = MOBILE_PRESENTATION_DEFAULTS.depthSpan,
  disparityBlend = MOBILE_PRESENTATION_DEFAULTS.disparityBlend,
  captureFovDeg = null,
} = {}) {
  const normalizedSourceName = typeof sourceName === 'string' && sourceName.trim()
    ? sourceName.trim()
    : 'depth_export_RGBDE.png';
  return {
    schemaVersion: 1,
    sourceName: normalizedSourceName,
    publishedAt,
    frontOffset,
    screenOccupancy,
    baselineEyeZ,
    depthSpan,
    disparityBlend,
    captureFovDeg: Number.isFinite(captureFovDeg) && captureFovDeg > 0 ? captureFovDeg : null,
  };
}

export async function fetchPublishedScenePair({
  fetchImpl = globalThis.fetch,
  knownRevision = 0,
  knownPublishedAt = null,
  force = false,
  maxAttempts = 3,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch is unavailable for mobile scene loading.');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('Mobile scene loading requires at least one attempt.');
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const manifestResponse = await fetchImpl('/viewer-api/scene/manifest', { cache: 'no-store' });
    if (!manifestResponse.ok) {
      throw new Error(`Scene manifest failed with HTTP ${manifestResponse.status}.`);
    }
    const envelope = await manifestResponse.json();
    if (!envelope.available) return { envelope, modelResponse: null, unchanged: false };
    if (!Number.isInteger(envelope.revision) || envelope.revision < 1) {
      throw new Error('Scene manifest returned an invalid revision.');
    }
    const publishedAt = envelope.manifest?.publishedAt;
    if (!force && envelope.revision === knownRevision
        && typeof publishedAt === 'string' && publishedAt === knownPublishedAt) {
      return { envelope, modelResponse: null, unchanged: true };
    }

    const modelResponse = await fetchImpl('/viewer-api/scene/model', { cache: 'no-store' });
    if (modelResponse.status === 404) continue;
    if (!modelResponse.ok) {
      throw new Error(`Published GLB failed with HTTP ${modelResponse.status}.`);
    }
    const modelRevision = Number(modelResponse.headers.get('X-Scene-Revision'));
    if (modelRevision !== envelope.revision) continue;
    return { envelope, modelResponse, unchanged: false };
  }
  throw new Error('Published scene changed repeatedly while loading; retrying on the next poll.');
}

export async function publishMobileScene({
  blob,
  filename,
  manifest,
  fetchImpl = globalThis.fetch,
}) {
  if (!(blob instanceof Blob) || blob.size === 0) {
    throw new Error('A non-empty GLB blob is required for mobile publish.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch is unavailable for mobile publish.');
  }

  const modelFilename = typeof filename === 'string' && filename.trim()
    ? filename.trim()
    : 'depth_export.glb';
  const form = new FormData();
  form.append('model', blob, modelFilename);
  form.append('manifest', JSON.stringify(manifest));

  const response = await fetchImpl('/viewer-api/scene', {
    method: 'POST',
    body: form,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // A useful status-based error is produced below when the response is not JSON.
  }
  if (!response.ok) {
    const detail = payload && typeof payload.detail === 'string'
      ? payload.detail
      : `Mobile publish failed with HTTP ${response.status}.`;
    throw new Error(detail);
  }
  if (!payload || !Number.isInteger(payload.revision)) {
    throw new Error('Mobile publish returned an invalid revision.');
  }
  return payload;
}
