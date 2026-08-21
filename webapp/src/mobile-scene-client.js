export const MOBILE_RELIEF_EXAGGERATION = 1.5;

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
  depthSpan: MOBILE_RELIEF_EXAGGERATION,
  disparityBlend: 1,
});

// The ceiling is deliberately far above the "miniature just behind the glass"
// default. A monocular head-tracked display has no vergence/accommodation
// conflict, so unlike a stereo display it can carry a great deal more depth,
// and a deep setting is how the presentation is compared against plain uniform
// scaling on a real device.
export const MAX_MOBILE_DEPTH_SPAN = 8;

// Depth Magnification of 1 is the scene at its own metric depth. The relief span
// is a proportion of the fitted picture's height, so the multiplier here is how
// much the mobile relief exaggerates that.
//
// 1.5 restores what the span of 1 gave before depth became proportional. A 16:9
// photograph is about 0.68 units tall on an iPad held upright, so a proportional
// span of 1 came out at 0.68 against the 1.0 the fixed span used to give -- the
// same picture read as flatter than before, which is what recalibration was for.
export function mobileDepthSpanForMagnification(magnification) {
  const value = Number.isFinite(magnification) ? magnification : 1;
  return Math.min(
    Math.max(value * MOBILE_RELIEF_EXAGGERATION, 0.2),
    MAX_MOBILE_DEPTH_SPAN,
  );
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
  variant = 'full',
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

    const modelUrl = variant === 'reduced'
      ? '/viewer-api/scene/model?variant=reduced'
      : '/viewer-api/scene/model';
    const modelResponse = await fetchImpl(modelUrl, { cache: 'no-store' });
    if (modelResponse.status === 404) continue;
    if (!modelResponse.ok) {
      throw new Error(`Published GLB failed with HTTP ${modelResponse.status}.`);
    }
    const modelRevision = Number(modelResponse.headers.get('X-Scene-Revision'));
    if (modelRevision !== envelope.revision) continue;
    return {
      envelope,
      modelResponse,
      unchanged: false,
      servedVariant: modelResponse.headers.get('X-Scene-Variant') || 'full',
    };
  }
  throw new Error('Published scene changed repeatedly while loading; retrying on the next poll.');
}

export async function publishMobileScene({
  blob,
  reducedBlob = null,
  filename,
  manifest,
  fetchImpl = globalThis.fetch,
}) {
  if (!(blob instanceof Blob) || blob.size === 0) {
    throw new Error('A non-empty GLB blob is required for mobile publish.');
  }
  if (reducedBlob !== null && (!(reducedBlob instanceof Blob) || reducedBlob.size === 0)) {
    throw new Error('The reduced mobile GLB must be a non-empty blob when provided.');
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
  // Published alongside the full build so a constrained browser has something
  // to fall back to after a genuine load failure. No browser API on iOS can be
  // asked for available memory ahead of time.
  if (reducedBlob) form.append('modelReduced', reducedBlob, modelFilename);

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
