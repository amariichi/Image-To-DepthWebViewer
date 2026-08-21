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


// Decides whether the image on screen would actually differ from the one
// already drawn.
//
// The eye pose only changes when a new face observation arrives, which is
// twenty times a second, while a continuous animation loop redraws sixty times
// a second: two frames in three were identical, and each carried a quarter of a
// million vertices, a multisample resolve, and a scan of the relief's front
// samples. Rendering only when an input moved leaves the picture unchanged --
// the same photons, drawn once instead of three times.
//
// The thresholds are set below one pixel of on-screen movement, so a skipped
// frame is one that could not have looked different. On a phone the picture
// spans roughly 400 CSS pixels for about 0.95 world units, making a pixel about
// 0.0024 units; each limit below is well inside that once multiplied by how
// strongly that input moves the picture.
export const DEFAULT_RENDER_THRESHOLDS = Object.freeze({
  // Eye translation moves a point at depth D by D / (eye + D) of itself, at
  // most about 0.63 for the deepest relief allowed.
  eye: 0.0015,
  // Yaw and pitch swing the deepest geometry, so the movement is roughly the
  // relief depth times the angle, and the deepest relief allowed is 8.
  angle: 0.0002,
  // Roll is different in kind and was wrongly given the same limit. Levelling
  // rotates within the screen plane, so it moves a point by the image radius
  // times the angle, halved again by the levelling gain -- about 0.3 units per
  // radian against 8. Holding the depth limit made ordinary hand tremor exceed
  // it on nearly every motion event, redrawing at the sensor's rate rather than
  // at the rate the picture actually changed.
  roll: 0.004,
  // Pan is applied directly in world units.
  pan: 0.0015,
  // Pinch moves the image edge by half the scale change.
  scale: 0.002,
});

export function createRenderGate(thresholds = {}) {
  const limits = { ...DEFAULT_RENDER_THRESHOLDS, ...thresholds };
  let last = null;

  const moved = (a, b, limit) => !(Math.abs(a - b) < limit);

  return {
    reset() {
      last = null;
    },
    shouldRender(inputs) {
      if (!last) return true;
      // Anything that replaces the geometry or the viewport must always draw.
      if (last.sceneId !== inputs.sceneId) return true;
      if (last.width !== inputs.width || last.height !== inputs.height) return true;
      if (moved(last.eyeX, inputs.eyeX, limits.eye)) return true;
      if (moved(last.eyeY, inputs.eyeY, limits.eye)) return true;
      if (moved(last.eyeZ, inputs.eyeZ, limits.eye)) return true;
      if (moved(last.roll, inputs.roll, limits.roll)) return true;
      if (moved(last.yaw, inputs.yaw, limits.angle)) return true;
      if (moved(last.pitch, inputs.pitch, limits.angle)) return true;
      if (moved(last.panX, inputs.panX, limits.pan)) return true;
      if (moved(last.panY, inputs.panY, limits.pan)) return true;
      if (moved(last.scale, inputs.scale, limits.scale)) return true;
      return false;
    },
    // Recorded against what was drawn, not against what was last checked, so a
    // slow drift still accumulates until it crosses the threshold.
    commit(inputs) {
      last = { ...inputs };
    },
  };
}
