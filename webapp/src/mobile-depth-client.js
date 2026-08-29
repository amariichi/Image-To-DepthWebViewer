export class MobileDepthRequestAborted extends Error {
  constructor() {
    super('The previous image request was replaced.');
    this.name = 'AbortError';
    this.code = 'stale-request';
  }
}

export const MIN_FOCAL_LENGTH_35MM = 10;
export const MAX_FOCAL_LENGTH_35MM = 800;

export function validateFocalLength35mm(value) {
  if (value === null || value === undefined || value === '') return null;
  const focal = Number(value);
  if (!Number.isFinite(focal)
      || focal < MIN_FOCAL_LENGTH_35MM
      || focal > MAX_FOCAL_LENGTH_35MM) {
    throw new Error('Lens must be from 10 to 800 mm in 35 mm equivalent.');
  }
  return focal;
}

function safeFilename(response) {
  const encoded = response.headers.get('X-RGBDE-Filename-Encoded');
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // Fall through to the ASCII-safe header.
    }
  }
  const plain = response.headers.get('X-RGBDE-Filename');
  return plain && plain.trim() ? plain.trim() : 'pasted_RGBDE.png';
}

async function responseDetail(response) {
  try {
    const payload = await response.clone().json();
    if (payload && typeof payload.detail === 'string' && payload.detail.trim()) {
      return payload.detail.trim();
    }
  } catch {
    // Status fallback below is deliberately safe and contains no upload data.
  }
  return `Depth generation failed with HTTP ${response.status}.`;
}

function asNamedPng(blob, filename) {
  if (typeof File === 'function') {
    return new File([blob], filename, { type: 'image/png' });
  }
  Object.defineProperty(blob, 'name', { value: filename, enumerable: true });
  return blob;
}

export async function requestRgbdeForImage(file, {
  fetchImpl = globalThis.fetch,
  signal,
  onPhase = () => {},
  focalLength35mm = null,
} = {}) {
  if (!(file instanceof Blob) || file.size === 0 || !file.type?.startsWith('image/')) {
    throw new Error('Paste image requires a non-empty image file.');
  }
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable for depth generation.');
  const focal = validateFocalLength35mm(focalLength35mm);
  const form = new FormData();
  const uploadName = typeof file.name === 'string' && file.name.trim()
    ? file.name.trim()
    : file.type === 'image/jpeg'
      ? 'pasted-image.jpg'
      : 'pasted-image.png';
  form.append('image', file, uploadName);
  const endpoint = focal === null
    ? '/api/process'
    : `/api/process?focal_length_35mm=${encodeURIComponent(String(focal))}`;
  onPhase('Sending image');
  let responsePromise;
  try {
    responsePromise = fetchImpl(endpoint, {
      method: 'POST',
      body: form,
      // The editor posts to this same endpoint through the same host, so the
      // host keeps a copy for the editor only when the phone asked. Without
      // the marker the editor would be offered back what it had just made.
      headers: { 'X-RGBDE-Origin': 'mobile' },
      signal,
    });
    onPhase('Estimating depth');
    const response = await responsePromise;
    if (!response.ok) throw new Error(await responseDetail(response));
    const contentType = response.headers.get('Content-Type') || '';
    if (!contentType.toLowerCase().startsWith('image/png')) {
      throw new Error('Depth generation returned an unexpected response type.');
    }
    const blob = await response.blob();
    if (blob.size === 0) throw new Error('Depth generation returned an empty RGBDE image.');
    return asNamedPng(blob, safeFilename(response));
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') {
      throw new MobileDepthRequestAborted();
    }
    throw error;
  }
}
