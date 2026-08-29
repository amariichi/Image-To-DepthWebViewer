// Pure placement math for the physical-window mobile presentation.
//
// Source geometry is expressed in capture-camera metres with +x right, +y up,
// and negative z behind the camera. The mobile window uses the same x/y axes,
// places the glass at z=0, and uses +z toward the viewer. True Window therefore
// needs only one uniform scale and one rigid translation; it never rebuilds x/y
// as a function of depth.

export const MIN_TRUE_WINDOW_MODEL_SCALE = 0.3;
export const MAX_TRUE_WINDOW_MODEL_SCALE = 4;
// Effectively the nearest surface on a normal mobile mesh, while leaving a
// handful of reconstruction strays unable to place the whole scene. Two per
// cent leaves visibly near geometry in front of the glass; StereoSplatViewer's
// hardware-tested True Window uses the same 0.1 per cent rule.
export const DEFAULT_TRUE_WINDOW_ANCHOR_QUANTILE = 0.001;

const FULL_FRAME_DIAGONAL_MM = Math.hypot(36, 24);

function finitePositive(value, label) {
  if (!Number.isFinite(value) || !(value > 0)) {
    throw new Error(`${label} must be positive and finite.`);
  }
  return value;
}

export function estimateCameraAxisDepthQuantile(positions, {
  quantile = DEFAULT_TRUE_WINDOW_ANCHOR_QUANTILE,
  stride = 1,
} = {}) {
  if (!(positions instanceof Float32Array) || positions.length < 3
      || positions.length % 3 !== 0) {
    throw new Error('True Window depth estimation requires Float32 XYZ positions.');
  }
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
    throw new Error('True Window depth quantile must be between zero and one.');
  }
  if (!Number.isFinite(stride) || !(stride >= 1)) {
    throw new Error('True Window depth stride must be at least one.');
  }
  const safeStride = Math.max(1, Math.floor(stride));
  const depths = [];
  for (let vertex = 0; vertex < positions.length / 3; vertex += safeStride) {
    // Camera-axis depth is -z, not Euclidean radius. An off-axis point must not
    // look deeper merely because x or y is large.
    const depth = -positions[vertex * 3 + 2];
    if (Number.isFinite(depth) && depth > 1e-6) depths.push(depth);
  }
  if (depths.length === 0) return null;
  depths.sort((a, b) => a - b);
  const index = Math.min(depths.length - 1, Math.floor((depths.length - 1) * quantile));
  return depths[index];
}

// Flatten the tiny shallow tail selected out by the near-depth quantile onto
// the glass anchor without moving it off its original capture-camera ray.
// Moving the entire mesh backward to accommodate one shallow vertex also moves
// the transformed capture apex, which creates the wrong focal viewpoint and a
// nonlinear z slide while the phone is tipped. Ray-preserving clamping keeps
// the source projection intact and leaves the raw source array immutable.
export function clampCameraRayDepthFloor(positions, minDepth) {
  if (!(positions instanceof Float32Array) || positions.length < 3
      || positions.length % 3 !== 0) {
    throw new Error('True Window ray clamping requires Float32 XYZ positions.');
  }
  finitePositive(minDepth, 'minDepth');
  const clampedPositions = new Float32Array(positions.length);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let clampedCount = 0;
  for (let index = 0; index < positions.length; index += 3) {
    let x = positions[index];
    let y = positions[index + 1];
    let z = positions[index + 2];
    if (![x, y, z].every(Number.isFinite)) {
      throw new Error('True Window positions must be finite.');
    }
    const depth = -z;
    if (!(depth > 0)) {
      throw new Error('True Window positions must lie behind the capture camera.');
    }
    if (depth < minDepth) {
      const factor = minDepth / depth;
      x *= factor;
      y *= factor;
      z = -minDepth;
      clampedCount += 1;
    }
    clampedPositions[index] = x;
    clampedPositions[index + 1] = y;
    clampedPositions[index + 2] = z;
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], z);
  }
  return {
    positions: clampedPositions,
    bounds: { min, max },
    clampedCount,
  };
}

export function captureTangentFromFov(captureFovDeg) {
  finitePositive(captureFovDeg, 'captureFovDeg');
  if (!(captureFovDeg < 180)) {
    throw new Error('captureFovDeg must be below 180 degrees.');
  }
  return Math.tan((captureFovDeg * Math.PI) / 360);
}

export const MIN_COMFORT_EYE_FRACTION = 0.6;
export const MAX_TRUE_WINDOW_LATERAL_RESPONSE = 1.5;
// The ceiling above is a portrait ceiling. Applying one shared ceiling after
// the orientation gain silently deleted the compensation below: at arm's length
// every lens from 35 mm upwards drove both orientations to exactly 1.5, so the
// ratio hardware settled at 1.20 became 1.00 for the whole range this project
// recommends. Landscape is therefore bounded at the same multiple of it.
export const MAX_TRUE_WINDOW_LANDSCAPE_LATERAL_RESPONSE = 1.8;
// Physical testing found True Window's screen-up left/right look weaker than
// desired after the other axes were comfort-matched. Keep this as a bounded
// camera-X-only adjustment: it must not affect Y/Z, source placement, model
// aspect, or the neutral eye.
export const TRUE_WINDOW_LATERAL_RESPONSE_GAIN = 2.4;
// The same physical camera displacement occupies a smaller share of a wide
// landscape aperture. Hardware established a 1.20 landscape/portrait gain
// ratio as equal-feeling, so preserve that compensation while common amplitude
// is tuned at this camera-X boundary rather than by rotating the model.
export const TRUE_WINDOW_LANDSCAPE_LATERAL_RESPONSE_GAIN = 2.88;

// StereoSplatViewer maps the physical holding distance into the capture
// camera's smaller virtual coordinate system. All three axes share one factor;
// scaling Z alone makes lateral motion too strong and feels like twisting.
export function mapTrackedEyeToCaptureApex({
  eye,
  nominalZ,
  captureApex,
  minFraction = MIN_COMFORT_EYE_FRACTION,
  maxFraction = 6,
}) {
  finitePositive(nominalZ, 'nominalZ');
  finitePositive(captureApex, 'captureApex');
  const factor = captureApex / nominalZ;
  const x = Number.isFinite(eye?.x) ? eye.x * factor : 0;
  const y = Number.isFinite(eye?.y) ? eye.y * factor : 0;
  const z = Number.isFinite(eye?.z) && eye.z > 0
    ? Math.min(
      Math.max(eye.z * factor, captureApex * minFraction),
      captureApex * maxFraction,
    )
    : captureApex;
  return { x, y, z };
}

// Source-exact True Window must keep its neutral capture apex at the calibrated
// eye or depth-edge bridges reappear. Dampen only displacement around that
// exact reference. The default remains one uniform gain; a caller may retain a
// separate lateral X response without changing neutral geometry or mesh aspect.
export function mapTrackedEyeAroundReference({
  eye,
  referenceZ,
  response,
  lateralResponse = response,
  minFraction = MIN_COMFORT_EYE_FRACTION,
  maxFraction = 6,
}) {
  finitePositive(referenceZ, 'referenceZ');
  if (!Number.isFinite(response) || !(response > 0 && response <= 1)) {
    throw new Error('eye response must be finite, positive, and no greater than one.');
  }
  if (!Number.isFinite(lateralResponse)
      || !(lateralResponse > 0
        && lateralResponse <= MAX_TRUE_WINDOW_LANDSCAPE_LATERAL_RESPONSE)) {
    throw new Error(`lateral eye response must be finite, positive, and no greater than ${MAX_TRUE_WINDOW_LANDSCAPE_LATERAL_RESPONSE}.`);
  }
  const rawX = Number.isFinite(eye?.x) ? eye.x : 0;
  const rawY = Number.isFinite(eye?.y) ? eye.y : 0;
  const rawZ = Number.isFinite(eye?.z) && eye.z > 0 ? eye.z : referenceZ;
  return {
    x: rawX * lateralResponse,
    y: rawY * response,
    z: Math.min(
      Math.max(
        referenceZ + (rawZ - referenceZ) * response,
        referenceZ * minFraction,
      ),
      referenceZ * maxFraction,
    ),
  };
}

export function trueWindowEyeResponse({ captureFovDeg, referenceEyeZ }) {
  finitePositive(referenceEyeZ, 'referenceEyeZ');
  const sourceApexAtLiteralWindow = 1 / captureTangentFromFov(captureFovDeg);
  return Math.min(1, sourceApexAtLiteralWindow / referenceEyeZ);
}

export function trueWindowLateralEyeResponse({
  captureFovDeg,
  referenceEyeZ,
  orientation = 'portrait',
  gain = null,
}) {
  if (orientation !== 'portrait' && orientation !== 'landscape') {
    throw new Error('orientation must be portrait or landscape.');
  }
  const resolvedGain = gain ?? (orientation === 'landscape'
    ? TRUE_WINDOW_LANDSCAPE_LATERAL_RESPONSE_GAIN
    : TRUE_WINDOW_LATERAL_RESPONSE_GAIN);
  finitePositive(resolvedGain, 'lateral response gain');
  const base = trueWindowEyeResponse({ captureFovDeg, referenceEyeZ });
  // An explicit gain is a caller overriding the whole policy, so it keeps the
  // plain ceiling. The orientation defaults instead bound the portrait
  // equivalent and then restore the orientation ratio on top of it, which
  // leaves portrait exactly as it was tuned and stops the ceiling from eating
  // the landscape compensation.
  if (gain !== null && gain !== undefined) {
    return Math.min(MAX_TRUE_WINDOW_LATERAL_RESPONSE, base * resolvedGain);
  }
  const orientationRatio = resolvedGain / TRUE_WINDOW_LATERAL_RESPONSE_GAIN;
  const portraitEquivalent = Math.min(
    MAX_TRUE_WINDOW_LATERAL_RESPONSE,
    base * TRUE_WINDOW_LATERAL_RESPONSE_GAIN,
  );
  return portraitEquivalent * orientationRatio;
}

// Match the maximum motion-parallax lever of True Window's metric depth to the
// shallow photo relief. This response is used for the pitch-coupled Y/Z pair.
// Lateral X uses its separately comfort-boosted source-lens response because a
// screen-up phone turn is observed mainly as camera X and must remain a usable
// horizontal look.
export function trueWindowEyeResponseForRelief({
  captureFovDeg,
  referenceEyeZ,
  trueWindowDepth,
  trueWindowFramingScale = 1,
  sourceAspect,
  screenWidth,
  screenHeight,
  reliefDepthSpan,
  occupancy = 0.92,
}) {
  const baseResponse = trueWindowEyeResponse({ captureFovDeg, referenceEyeZ });
  finitePositive(trueWindowDepth, 'trueWindowDepth');
  finitePositive(trueWindowFramingScale, 'trueWindowFramingScale');
  finitePositive(sourceAspect, 'sourceAspect');
  finitePositive(screenWidth, 'screenWidth');
  finitePositive(screenHeight, 'screenHeight');
  finitePositive(reliefDepthSpan, 'reliefDepthSpan');
  if (!Number.isFinite(occupancy) || !(occupancy > 0 && occupancy <= 1)) {
    throw new Error('occupancy must be finite, positive, and no greater than one.');
  }
  const screenAspect = screenWidth / screenHeight;
  const imageHeight = sourceAspect >= screenAspect
    ? (screenWidth * occupancy) / sourceAspect
    : screenHeight * occupancy;
  const captureTangent = captureTangentFromFov(captureFovDeg);
  const photoApex = (imageHeight / 2) / captureTangent;
  const photoDepth = reliefDepthSpan * imageHeight;
  const photoEyeResponse = photoApex / referenceEyeZ;
  const photoLever = photoDepth / (photoApex + photoDepth);
  const trueWindowLever = trueWindowDepth / (referenceEyeZ + trueWindowDepth);
  // Framing below one expands the virtual aperture, so a fixed glass-plane
  // displacement covers proportionally fewer display pixels. Match displayed
  // parallax; at literal 1.00x this reduces to the physical-glass comparison.
  return Math.min(
    baseResponse,
    (photoEyeResponse * photoLever) / (trueWindowLever * trueWindowFramingScale),
  );
}

// Convert the rectilinear source's vertical FOV into the familiar 35 mm
// equivalent focal-length convention. This is a diagnostic for the capture
// lens, not a display-side target or a claim about the human eye. Using the
// diagonal makes it valid for arbitrary image aspect ratios.
export function focalLength35mmEquivalentFromVerticalFov({
  captureFovDeg,
  sourceAspect,
}) {
  const verticalTangent = captureTangentFromFov(captureFovDeg);
  finitePositive(sourceAspect, 'sourceAspect');
  const diagonalTangent = verticalTangent * Math.hypot(sourceAspect, 1);
  return FULL_FRAME_DIAGONAL_MM / (2 * diagonalTangent);
}

// Find the projection-only framing that shows the complete source photograph
// at the neutral Source-exact eye. At that eye, the capture's top edge meets
// the glass at E*tan(fovY/2), and its side edge is that value times the source
// aspect. Dividing those extents by the physical glass extents gives the
// framing limit for each axis. The smaller limit fits both axes.
//
// This deliberately returns at most 1: a narrow/telephoto source may already
// fit through the literal glass, but auto-fit must never enlarge it past the
// physical-window view. Values below 1 widen only the projection aperture; the
// metric XYZ mesh, capture apex, and source focal length remain unchanged.
export function computeSourceOverviewFraming({
  captureFovDeg,
  sourceAspect,
  screenAspect,
  referenceEyeZ,
  occupancy = 0.92,
}) {
  const captureTangent = captureTangentFromFov(captureFovDeg);
  finitePositive(sourceAspect, 'sourceAspect');
  finitePositive(screenAspect, 'screenAspect');
  finitePositive(referenceEyeZ, 'referenceEyeZ');
  if (!Number.isFinite(occupancy) || !(occupancy > 0 && occupancy <= 1)) {
    throw new Error('occupancy must be finite and no greater than one.');
  }
  const sourceHalfHeightOnGlass = referenceEyeZ * captureTangent;
  const sourceHalfWidthOnGlass = sourceHalfHeightOnGlass * sourceAspect;
  const verticalFit = occupancy / sourceHalfHeightOnGlass;
  const horizontalFit = occupancy * screenAspect / sourceHalfWidthOnGlass;
  return Math.min(1, verticalFit, horizontalFit);
}

// Place a metric pinhole reconstruction behind the physical glass with its
// original capture-camera apex at the calibrated physical eye.
//
// Source camera coordinates use z=-depth. Mapping the source camera (z=0) to
// physical eye E and the near anchor -a to the glass gives the unique uniform
// transform s=E/a and T=E. From that eye every source-camera ray therefore
// lands on its original image coordinate, so a bridge across a depth edge is
// hidden at the neutral pose instead of being exposed by a display-side lens
// change. Live head motion can still reveal genuinely missing single-view
// surfaces. Setback is an explicit rigid move after the exact placement.
// Overview framing is projection-only and intentionally not accepted here.
export function computeSourceExactWindowPlacement({
  captureFovDeg,
  sourceAspect,
  anchorDistance,
  referenceEyeZ,
  pushBack = 0,
}) {
  finitePositive(anchorDistance, 'anchorDistance');
  finitePositive(referenceEyeZ, 'referenceEyeZ');
  if (!Number.isFinite(pushBack) || pushBack < 0) {
    throw new Error('pushBack must be finite and non-negative.');
  }
  const sourceFocalLength35mmEq = focalLength35mmEquivalentFromVerticalFov({
    captureFovDeg,
    sourceAspect,
  });
  const scale = referenceEyeZ / anchorDistance;
  const sourceCaptureApex = referenceEyeZ - pushBack;
  return {
    scale,
    translation: [0, 0, sourceCaptureApex],
    sourceCaptureApex,
    sourceFocalLength35mmEq,
    referenceEyeZ,
    windowHalfHeight: 1,
    anchorDepth: -pushBack,
    pushBack,
  };
}

// Choose the neutral miniature size whose transformed capture-camera apex is
// the calibrated physical eye. This makes the initial True Window use the
// source photograph's viewpoint without changing the fixed aperture or
// introducing non-uniform placement; when the physical aperture subtends a
// narrower angle it naturally shows a central crop. This legacy helper remains
// for the bounded model-scale API; active pinch changes projection framing.
export function modelScaleForCaptureApex({ captureFovDeg, eyeZ }) {
  finitePositive(eyeZ, 'eyeZ');
  const scale = eyeZ * captureTangentFromFov(captureFovDeg);
  return Math.min(
    Math.max(scale, MIN_TRUE_WINDOW_MODEL_SCALE),
    MAX_TRUE_WINDOW_MODEL_SCALE,
  );
}

export function computeTrueWindowPlacement({
  captureFovDeg,
  anchorDistance,
  modelScale = 1,
  pushBack = 0,
}) {
  const captureTangent = captureTangentFromFov(captureFovDeg);
  finitePositive(anchorDistance, 'anchorDistance');
  finitePositive(modelScale, 'modelScale');
  if (!Number.isFinite(pushBack) || pushBack < 0) {
    throw new Error('pushBack must be finite and non-negative.');
  }
  const clampedModelScale = Math.min(
    Math.max(modelScale, MIN_TRUE_WINDOW_MODEL_SCALE),
    MAX_TRUE_WINDOW_MODEL_SCALE,
  );
  const scaledApex = clampedModelScale / captureTangent;
  const scale = scaledApex / anchorDistance;
  const translation = [0, 0, scaledApex - pushBack];
  return {
    scale,
    translation,
    captureTangent,
    scaledApex,
    modelScale: clampedModelScale,
    windowHalfHeight: 1,
    anchorDepth: pushBack === 0 ? 0 : -pushBack,
    pushBack,
  };
}

// Keep a tracked physical point fixed in millimetres when an orientation or
// viewport change alters how many millimetres one world unit represents.
export function preservePhysicalEye(eye, previousWorldUnitMm, nextWorldUnitMm) {
  finitePositive(previousWorldUnitMm, 'previousWorldUnitMm');
  finitePositive(nextWorldUnitMm, 'nextWorldUnitMm');
  const x = Number(eye?.x);
  const y = Number(eye?.y);
  const z = Number(eye?.z);
  if (![x, y, z].every(Number.isFinite)) {
    throw new Error('Physical eye conversion requires finite XYZ coordinates.');
  }
  const factor = previousWorldUnitMm / nextWorldUnitMm;
  return { x: x * factor, y: y * factor, z: z * factor };
}
