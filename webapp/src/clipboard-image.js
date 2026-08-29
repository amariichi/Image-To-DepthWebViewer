// Clipboard image extraction shared by keyboard paste and the explicit mobile
// Paste image button. No clipboard contents are logged or inspected beyond MIME
// type selection.

export const PREFERRED_IMAGE_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export function pickImageType(types = []) {
  for (const preferred of PREFERRED_IMAGE_TYPES) {
    if (types.includes(preferred)) return preferred;
  }
  return Array.from(types).find((type) => type.startsWith('image/')) ?? null;
}

export function nameForType(type, now = new Date()) {
  const extension = type === 'image/png' ? 'png'
    : type === 'image/webp' ? 'webp'
      : type === 'image/jpeg' ? 'jpg'
        : (type.split('/')[1] || 'png').replace(/[^a-z0-9]/giu, '') || 'png';
  const stamp = now.toISOString().replace(/[-:]/gu, '').replace(/\..*/u, '');
  return `pasted-${stamp}.${extension}`;
}

function namedFile(parts, name, type) {
  if (typeof File === 'function') return new File(parts, name, { type });
  const blob = new Blob(parts, { type });
  Object.defineProperty(blob, 'name', { value: name, enumerable: true });
  return blob;
}

export function imageFromPasteEvent(event) {
  const items = event?.clipboardData?.items;
  if (items) {
    for (const item of Array.from(items)) {
      if (item.kind !== 'file' || !item.type?.startsWith('image/')) continue;
      const file = item.getAsFile?.();
      if (file) return file;
    }
  }
  const files = event?.clipboardData?.files;
  if (files) {
    for (const file of Array.from(files)) {
      if (file.type?.startsWith('image/')) return file;
    }
  }
  return null;
}

export async function readImageFromClipboard({
  clipboard = globalThis.navigator?.clipboard,
} = {}) {
  if (!clipboard || typeof clipboard.read !== 'function') {
    return { ok: false, reason: 'unsupported' };
  }
  let items;
  try {
    items = await clipboard.read();
  } catch {
    return { ok: false, reason: 'denied' };
  }
  for (const item of items) {
    const type = pickImageType(item.types || []);
    if (!type) continue;
    try {
      const blob = await item.getType(type);
      return {
        ok: true,
        file: namedFile([blob], nameForType(type), type),
      };
    } catch {
      // Clipboard items can disappear between read() and getType(). Continue to
      // the next image instead of turning a partial clipboard into an error.
    }
  }
  return { ok: false, reason: 'empty' };
}
