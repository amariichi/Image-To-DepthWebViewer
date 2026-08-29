// Reference-relative phone attitude for the physical-window renderer.

export const DEFAULT_LEVELLING_GAIN = 0.5;
// Retained for explicit full-response math/tests. Runtime True Window pitch is
// deliberately gentler because the camera/off-axis path already supplies the
// main change of viewpoint and a deep mesh exposes its back under a large turn.
export const TRUE_WINDOW_LEVELLING_GAIN = 1;
export const MAX_LEVELLING_RAD = (18 * Math.PI) / 180;
export const TRUE_WINDOW_PITCH_GAIN = 0.5;
export const TRUE_WINDOW_PITCH_MAX_RAD = (9 * Math.PI) / 180;

const MIN_GRAVITY = 2;

export function upInDeviceFrame(gravity) {
  const x = Number(gravity?.x);
  const y = Number(gravity?.y);
  const z = Number(gravity?.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  const magnitude = Math.hypot(x, y, z);
  if (!(magnitude >= MIN_GRAVITY)) return null;
  return { x: x / magnitude, y: y / magnitude, z: z / magnitude };
}

function damp(angle, gain, limit) {
  const safeGain = Number.isFinite(gain) && gain >= 0 ? gain : DEFAULT_LEVELLING_GAIN;
  const safeLimit = Number.isFinite(limit) && limit >= 0 ? limit : MAX_LEVELLING_RAD;
  return Math.min(Math.max(angle * safeGain, -safeLimit), safeLimit);
}

export function computeLevelling(gravity, {
  reference = null,
  gain = DEFAULT_LEVELLING_GAIN,
  rollGain = gain,
  tipGain = gain,
  maxAngle = MAX_LEVELLING_RAD,
  rollMaxAngle = maxAngle,
  tipMaxAngle = maxAngle,
} = {}) {
  const up = upInDeviceFrame(gravity);
  if (!up) return null;
  const from = reference ?? { x: 0, y: 1, z: 0 };
  const rollNow = Math.atan2(-up.x, up.y);
  const rollWas = Math.atan2(-from.x, from.y);
  let rollDelta = rollNow - rollWas;
  while (rollDelta > Math.PI) rollDelta -= Math.PI * 2;
  while (rollDelta < -Math.PI) rollDelta += Math.PI * 2;
  const tipDelta = Math.asin(Math.min(Math.max(up.z, -1), 1))
    - Math.asin(Math.min(Math.max(from.z, -1), 1));
  const roll = damp(rollDelta, rollGain, rollMaxAngle);
  const tip = damp(tipDelta, tipGain, tipMaxAngle);
  return Math.abs(roll) < 1e-6 && Math.abs(tip) < 1e-6 ? null : { roll, tip };
}

// A phone already tipped back is not aligned with room-up. Turning it about
// screen up then rotates the reference gravity vector through the other device
// axes, which a gravity-only decomposition mistakes for roll/tip. In portrait
// screen up is normally device Y; after a quarter turn it is device X (with a
// platform-dependent sign). Derive that axis from the freshly captured gravity
// reference instead of trusting screen.orientation or a fixed device axis.
// DeviceOrientation's relative screen heading identifies the turn. Rotate the
// reading back only for gravity decomposition; heading never becomes rendered
// yaw.
export function gravityWithoutScreenYaw(gravity, screenYaw, { reference = null } = {}) {
  const x = Number(gravity?.x);
  const y = Number(gravity?.y);
  const z = Number(gravity?.z);
  if (![x, y, z].every(Number.isFinite) || !Number.isFinite(screenYaw)) {
    return gravity ? { ...gravity } : gravity;
  }
  const referenceX = Number(reference?.x);
  const referenceY = Number(reference?.y);
  const referenceInPlane = Math.hypot(referenceX, referenceY);
  // Initial hand roll must remain a reference posture, not tilt the inferred
  // yaw axis. Screen orientation contributes a quarter turn, so snap the
  // dominant reference component to device X or Y just as computeScreenRoll()
  // removes a quarter-turn offset without trusting its platform-specific sign.
  const landscapeAxis = referenceInPlane > 1e-6 && Math.abs(referenceX) > Math.abs(referenceY);
  const axisX = landscapeAxis ? Math.sign(referenceX) || 1 : 0;
  const axisY = landscapeAxis ? 0 : Math.sign(referenceY) || 1;
  const cosine = Math.cos(screenYaw);
  const sine = Math.sin(screenYaw);
  const dot = axisX * x + axisY * y;
  // Rodrigues' formula around the reference screen-up axis (axisZ is zero).
  return {
    ...gravity,
    x: x * cosine + axisY * z * sine + axisX * dot * (1 - cosine),
    y: y * cosine - axisX * z * sine + axisY * dot * (1 - cosine),
    z: z * cosine + (axisX * y - axisY * x) * sine,
  };
}

// True Window keeps gravity-derived pitch even when Hold level is off, so it
// also needs heading to distinguish a screen-up turn from a real pitch. Photo
// mode with Hold off renders no gravity attitude and stays on its camera-only
// path. This policy is kept pure so the sensor lifetime cannot regress during
// UI refactors.
export function screenYawForGravityAttitude(relativeYaw, {
  trueWindow = false,
  holdLevel = false,
} = {}) {
  return Number.isFinite(relativeYaw) && (trueWindow || holdLevel) ? relativeYaw : 0;
}

function attenuateTowardZero(rawValue, correctedValue) {
  if (!(Math.abs(correctedValue) < Math.abs(rawValue))) return rawValue;
  // A correction landing exactly on zero has explained the axis, and zero is
  // the answer. One that comes back reversed has overshot and explained
  // nothing, so the reading stands. Treating the two alike deleted real tilt:
  // a measured four-degree roll under a twenty-five-degree turn was rendered
  // as no roll at all, in ten per cent of a swept posture grid.
  return rawValue * correctedValue < 0 ? rawValue : correctedValue;
}

function bestAttenuation(rawValue, correctedValues) {
  return correctedValues.reduce((best, correctedValue) => {
    const candidate = attenuateTowardZero(rawValue, correctedValue);
    return Math.abs(candidate) < Math.abs(best) ? candidate : best;
  }, rawValue);
}

// Heading is deliberately allowed only to subtract the gravity tilt it can
// explain. A drifting heading with unchanged gravity therefore cannot create
// model motion: any correction that would enlarge or reverse an axis is
// rejected. With screenYaw=0 this is exactly computeLevelling().
export function computeYawDecoupledLevelling(gravity, {
  screenYaw = 0,
  ...options
} = {}) {
  const raw = computeLevelling(gravity, options);
  if (!raw || !Number.isFinite(screenYaw) || Math.abs(screenYaw) < 1e-9) return raw;
  // `computeScreenHeading()` normalizes the glass heading, but iOS/browser
  // sensor frames have historically disagreed in sign after orientation
  // changes. Try both equivalent transport conventions and accept only the
  // one that reduces a gravity-derived axis toward zero.
  const corrected = [screenYaw, -screenYaw].map((yaw) => computeLevelling(
    gravityWithoutScreenYaw(gravity, yaw, { reference: options.reference }),
    options,
  ));
  const roll = bestAttenuation(raw.roll, corrected.map((value) => value?.roll ?? 0));
  const tip = bestAttenuation(raw.tip, corrected.map((value) => value?.tip ?? 0));
  return Math.abs(roll) < 1e-6 && Math.abs(tip) < 1e-6 ? null : { roll, tip };
}

export function toQuaternion({ roll, tip }) {
  const hx = tip / 2;
  const hz = roll / 2;
  const sx = Math.sin(hx);
  const cx = Math.cos(hx);
  const sz = Math.sin(hz);
  const cz = Math.cos(hz);
  return {
    x: cz * sx,
    y: sz * sx,
    z: sz * cx,
    w: cz * cx,
  };
}

export function rotateVectorByQuaternion(vector, rotation) {
  if (![vector?.x, vector?.y, vector?.z].every(Number.isFinite)) return { ...vector };
  const magnitude = Math.hypot(rotation?.x, rotation?.y, rotation?.z, rotation?.w);
  if (!(magnitude > 1e-9) || !Number.isFinite(magnitude)) return { ...vector };
  const x = rotation.x / magnitude;
  const y = rotation.y / magnitude;
  const z = rotation.z / magnitude;
  const w = rotation.w / magnitude;
  const tx = 2 * (y * vector.z - z * vector.y);
  const ty = 2 * (z * vector.x - x * vector.z);
  const tz = 2 * (x * vector.y - y * vector.x);
  return {
    x: vector.x + w * tx + (y * tz - z * ty),
    y: vector.y + w * ty + (z * tx - x * tz),
    z: vector.z + w * tz + (x * ty - y * tx),
  };
}

export function inverseRotation(rotation) {
  if (!rotation) return null;
  const magnitude = Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w);
  if (!(magnitude > 1e-9) || !Number.isFinite(magnitude)) return null;
  return {
    x: -rotation.x / magnitude,
    y: -rotation.y / magnitude,
    z: -rotation.z / magnitude,
    w: rotation.w / magnitude,
  };
}

export function quaternionToMatrix(rotation) {
  const magnitude = Math.hypot(rotation?.x, rotation?.y, rotation?.z, rotation?.w);
  if (!(magnitude > 1e-9) || !Number.isFinite(magnitude)) return null;
  const x = rotation.x / magnitude;
  const y = rotation.y / magnitude;
  const z = rotation.z / magnitude;
  const w = rotation.w / magnitude;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return new Float32Array([
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
    0, 0, 0, 1,
  ]);
}

export function sceneRotationForMode(attitude, { trueWindow }) {
  if (!attitude) return null;
  const magnitude = Math.hypot(attitude.x, attitude.y, attitude.z, attitude.w);
  if (!(magnitude > 1e-9) || !Number.isFinite(magnitude)) return null;
  const q = {
    x: attitude.x / magnitude,
    y: attitude.y / magnitude,
    z: attitude.z / magnitude,
    w: attitude.w / magnitude,
  };
  if (trueWindow) return { x: -q.x, y: -q.y, z: q.z, w: q.w };
  const halfRoll = Math.atan2(q.z, q.w);
  const z = Math.sin(halfRoll);
  return Math.abs(z) < 1e-9 ? null : { x: 0, y: 0, z, w: Math.cos(halfRoll) };
}

export function counterRotateEye(eye, attitude) {
  const inverse = inverseRotation(attitude);
  return inverse ? rotateVectorByQuaternion(eye, inverse) : { ...eye };
}

// Pitch changes the direction through which a literal window is viewed even
// when horizon holding is disabled. Extract it from the reference-relative
// roll×pitch quaternion so Hold level can continue to own roll independently.
// `toQuaternion()` gives x/w = tan(tip/2), unaffected by its preceding roll.
export function trueWindowPitchRotation(attitude) {
  if (!attitude) return null;
  const magnitude = Math.hypot(attitude.x, attitude.y, attitude.z, attitude.w);
  if (!(magnitude > 1e-9) || !Number.isFinite(magnitude)) return null;
  const halfTip = Math.atan2(attitude.x / magnitude, attitude.w / magnitude);
  const x = -Math.sin(halfTip);
  return Math.abs(x) < 1e-9
    ? null
    : { x, y: 0, z: 0, w: Math.cos(halfTip) };
}

// A right-handed turn about screen up, with identity for unusable input.
function yawRotation(angle) {
  if (!Number.isFinite(angle)) return { x: 0, y: 0, z: 0, w: 1 };
  const half = angle / 2;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

// Express a camera-frame eye in the heading reference captured at start.
//
// Turning the phone by `yaw` makes a stationary observer appear through the
// inverse turn in camera coordinates. Applying the device-to-reference turn
// removes that phone motion and leaves real head translation carried through
// the rotation, so the front-camera axis calibration stays what it was.
export function eyeInYawReferenceFrame(eye, yaw) {
  return Number.isFinite(yaw)
    ? rotateVectorByQuaternion(eye, yawRotation(yaw))
    : { ...eye };
}

// A stationary world behind the glass, expressed in the turned phone frame.
export function sceneYawForDevice(yaw) {
  return yawRotation(-yaw);
}

// Heading was once deliberately absent here, on the grounds that the tracker
// returns reference-relative X/Y beside an absolute Z, so rotating the whole
// vector would turn that large Z into a false lateral orbit.
//
// Hardware showed the cost of leaving it out. Bringing the left edge of the
// phone towards you and pushing the right edge away turned the model the wrong
// way, in every projection mode and with Hold level either on or off, because a
// camera watching a face cannot tell a turned phone from a moved head and the
// two need opposite corrections. With neither measurement the turn was read as
// the head alone, which is the one reading that is always backwards.
//
// The objection does not survive the geometry it appeals to. X, Y and Z share
// the glass origin, and after a turn of `yaw` an observer who has not moved
// really is about `z * sin(yaw)` to one side of the glass normal. That is the
// term rotating the vector adds, so it is the window behaving correctly rather
// than an artefact of the hybrid. Drift is answered by the relative heading
// reference and Recenter, not by dropping the axis.
export function referencedEyeForDevicePose(eye, { relativeYaw = 0 } = {}) {
  return eyeInYawReferenceFrame(eye, relativeYaw);
}

// True Window always retains reference-relative pitch because tipping the
// glass changes its elevation even without horizon holding. Hold level also
// owns roll; photo mode keeps its established Hold-only roll and never adds
// device pitch. A null result is the identity.
export function sceneRotationForDevicePose(attitude, {
  trueWindow = false,
  holdLevel = false,
} = {}) {
  return trueWindow
    ? (holdLevel
      ? sceneRotationForMode(attitude, { trueWindow: true })
      : trueWindowPitchRotation(attitude))
    : (holdLevel ? sceneRotationForMode(attitude, { trueWindow: false }) : null);
}
