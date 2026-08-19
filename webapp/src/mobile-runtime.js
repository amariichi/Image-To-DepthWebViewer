export const TRACKING_MIRROR_STORAGE_KEY = 'rgbde-mobile-tracking-mirror-x-v2';

export function inferFrontCameraMirrorX(userAgent = '') {
  // Second-pass device testing found the same display-space correction is
  // required by Safari and iOS Chrome. Keep the manual persisted override for
  // devices whose camera pipeline differs.
  void userAgent;
  return true;
}

export function inferFrontCameraXyGain(userAgent = '') {
  // Safari was still about twice as strong as desired. iOS Chrome was already
  // substantially weaker, so retain its previous numerical gain while both
  // browsers share the corrected handedness.
  return /\bCriOS(?:\/|\b)/i.test(String(userAgent)) ? 0.65 : 0.325;
}

export function loadFrontCameraMirrorX(storage, userAgent = '') {
  try {
    const stored = storage?.getItem?.(TRACKING_MIRROR_STORAGE_KEY);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
  } catch {
    // Private browsing can reject storage access; browser inference remains usable.
  }
  return inferFrontCameraMirrorX(userAgent);
}

export function saveFrontCameraMirrorX(storage, mirrorX) {
  try {
    storage?.setItem?.(TRACKING_MIRROR_STORAGE_KEY, String(Boolean(mirrorX)));
  } catch {
    // Tracking still works for the current page when persistence is unavailable.
  }
}

export function classifyViewport(width, height) {
  if (!(width > 0) || !(height > 0)) {
    throw new Error('Viewport width and height must be positive.');
  }
  return width >= height ? 'landscape' : 'portrait';
}

export function createRateMeter({ windowMs = 1000 } = {}) {
  if (!(windowMs > 0)) throw new Error('Rate window must be positive.');
  let samples = [];

  function trim(timestamp) {
    const cutoff = timestamp - windowMs;
    samples = samples.filter((sample) => sample >= cutoff);
  }

  return {
    mark(timestamp) {
      if (!Number.isFinite(timestamp)) return 0;
      samples.push(timestamp);
      trim(timestamp);
      return this.rate(timestamp);
    },
    rate(timestamp = samples.at(-1) ?? 0) {
      if (!Number.isFinite(timestamp) || samples.length < 2) return 0;
      trim(timestamp);
      if (samples.length < 2) return 0;
      const span = samples.at(-1) - samples[0];
      return span > 0 ? ((samples.length - 1) * 1000) / span : 0;
    },
    reset() {
      samples = [];
    },
  };
}


// What this device could offer beyond the front camera, reported so the question
// can be settled by looking rather than by argument.
//
// Position is the part that decides whether a model can be left standing in the
// room and walked around. Integrating an accelerometer twice cannot provide it:
// the error grows as the square of time, and it is dominated not by sensor bias
// but by gravity leaking through attitude error, where a tenth of a degree of
// tilt already contributes 17 mg. Only visual-inertial tracking, which is what
// `immersive-ar` exposes, holds position over tens of seconds.
export async function probeMotionCapabilities({
  xr = globalThis.navigator?.xr,
  orientationEvent = globalThis.DeviceOrientationEvent,
  motionEvent = globalThis.DeviceMotionEvent,
} = {}) {
  let immersiveAr = false;
  try {
    immersiveAr = Boolean(await xr?.isSessionSupported?.('immersive-ar'));
  } catch {
    immersiveAr = false;
  }
  return {
    immersiveAr,
    deviceOrientation: Boolean(orientationEvent),
    deviceMotion: Boolean(motionEvent),
    // iOS gates both behind a call made from a user gesture.
    needsMotionPermission: typeof orientationEvent?.requestPermission === 'function'
      || typeof motionEvent?.requestPermission === 'function',
  };
}
