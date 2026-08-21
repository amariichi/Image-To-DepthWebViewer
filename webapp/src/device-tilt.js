// Keeping the miniature upright in the room while the phone rolls.
//
// The relief currently shares the screen's up axis, so rolling the device rolls
// the whole scene with it. A real object behind glass does not do that: the
// frame turns and the view stays upright. Correcting for it needs only which
// way is down, which is the one thing inertial sensing gives away for free.
//
// Gravity is read from `accelerationIncludingGravity` rather than from the
// Euler angles of `deviceorientation`. The Euler route needs a sign convention
// that differs between platforms and degenerates when the device points
// straight up or down; a vector has neither problem. It does pick up real hand
// acceleration, but gravity is a constant and hand motion is not, so a low-pass
// filter separates them.
//
// Only roll within the screen plane is used. That is referenced to gravity and
// therefore does not drift, unlike a heading, which would need the
// magnetometer and would wander indoors.

export const DEFAULT_TILT_TIME_CONSTANT_MS = 220;

// The scene is not infinite: it is a picture with edges, so counter-rotating it
// fully would swing its corners into view and expose the background behind
// them. A partial, bounded correction gives the cue without the reveal.
export const DEFAULT_TILT_GAIN = 0.5;
export const MAX_TILT_CORRECTION_RAD = (18 * Math.PI) / 180;

const MIN_GRAVITY_MAGNITUDE = 2;

// The angle of "down" within the screen plane, measured from the screen's own
// downward direction, with the page's rotation relative to the hardware taken
// out.
//
// `accelerationIncludingGravity` is reported in the device's natural frame,
// which does not turn with the page, so the page's rotation has to be added
// back. The sign matters and was wrong at first: turning the device
// anticlockwise puts gravity along its -x, giving a device roll of -90, while
// the page rotates to compensate and reports an angle of 90. Subtracting gave
// -180 and turning the device the other way gave -180 as well, so both landscape
// orientations pinned the correction at its cap instead of levelling. Adding
// gives 0 for both, which is level.
export function computeScreenRoll(gravity, screenAngleDeg = 0) {
  const x = Number(gravity?.x);
  const y = Number(gravity?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // Near-vertical device orientations leave almost nothing in the screen plane,
  // so the angle becomes meaningless rather than merely noisy.
  if (Math.hypot(x, y) < MIN_GRAVITY_MAGNITUDE) return null;
  const deviceRoll = Math.atan2(x, -y);
  const screenAngle = (Number(screenAngleDeg) || 0) * (Math.PI / 180);
  return wrapAngle(deviceRoll + screenAngle);
}

export function wrapAngle(angle) {
  let wrapped = angle;
  while (wrapped > Math.PI) wrapped -= Math.PI * 2;
  while (wrapped < -Math.PI) wrapped += Math.PI * 2;
  return wrapped;
}

export function clampTiltCorrection(roll, {
  gain = DEFAULT_TILT_GAIN,
  maxCorrection = MAX_TILT_CORRECTION_RAD,
  invert = false,
} = {}) {
  if (!Number.isFinite(roll)) return 0;
  const safeGain = Number.isFinite(gain) ? gain : DEFAULT_TILT_GAIN;
  const limit = Number.isFinite(maxCorrection) && maxCorrection >= 0
    ? maxCorrection
    : MAX_TILT_CORRECTION_RAD;
  const scaled = roll * safeGain * (invert ? -1 : 1);
  return Math.min(Math.max(scaled, -limit), limit);
}

// Angles wrap, so they cannot be averaged directly: filtering the shortest
// signed difference keeps the filter stable across the boundary.
export function createRollFilter({ timeConstantMs = DEFAULT_TILT_TIME_CONSTANT_MS } = {}) {
  let filtered = null;
  let lastTimestamp = null;
  return {
    reset() {
      filtered = null;
      lastTimestamp = null;
    },
    get: () => filtered,
    update(roll, timestamp) {
      if (!Number.isFinite(roll)) return filtered;
      if (filtered === null || !Number.isFinite(lastTimestamp) || !Number.isFinite(timestamp)) {
        filtered = roll;
        lastTimestamp = timestamp;
        return filtered;
      }
      const delta = Math.max(0, Math.min(timestamp - lastTimestamp, 500));
      const alpha = 1 - Math.exp(-delta / Math.max(timeConstantMs, 1));
      filtered = wrapAngle(filtered + wrapAngle(roll - filtered) * alpha);
      lastTimestamp = timestamp;
      return filtered;
    },
  };
}

// iOS gates motion events behind a call made from a user gesture. Everywhere
// else the events simply arrive.
export async function requestTiltPermission({ motionEvent = globalThis.DeviceMotionEvent } = {}) {
  if (typeof motionEvent?.requestPermission !== 'function') return 'granted';
  try {
    return await motionEvent.requestPermission();
  } catch {
    return 'denied';
  }
}

export function createTiltTracker({
  target = globalThis,
  screen = globalThis.screen,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  timeConstantMs = DEFAULT_TILT_TIME_CONSTANT_MS,
  onRoll = () => {},
} = {}) {
  const filter = createRollFilter({ timeConstantMs });
  let running = false;
  let lastRawRoll = null;

  function handleMotion(event) {
    const gravity = event?.accelerationIncludingGravity;
    const roll = computeScreenRoll(gravity, screen?.orientation?.angle ?? 0);
    if (roll === null) return;
    lastRawRoll = roll;
    const smoothed = filter.update(roll, now());
    if (smoothed !== null) onRoll(smoothed);
  }

  return {
    get running() {
      return running;
    },
    getRawRoll: () => lastRawRoll,
    getRoll: () => filter.get(),
    async start() {
      if (running) return 'granted';
      const permission = await requestTiltPermission();
      if (permission !== 'granted') return permission;
      filter.reset();
      target.addEventListener('devicemotion', handleMotion);
      running = true;
      return 'granted';
    },
    stop() {
      if (!running) return;
      target.removeEventListener('devicemotion', handleMotion);
      running = false;
      filter.reset();
      lastRawRoll = null;
    },
  };
}
