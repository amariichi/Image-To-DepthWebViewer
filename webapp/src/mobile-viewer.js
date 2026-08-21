import { parseGlb } from './glb-loader.js';
import { HeadTracker, getActiveDelegate } from './head-tracker.js';
import {
  computeEyeViewMatrix,
  computeOffAxisProjection,
  computeVirtualScreen,
  transformBounds,
} from './head-coupled-projection.js';
import { mat4 } from './rendering.js';
import { createTouchInteraction } from './mobile-interaction.js';
import {
  DEFAULT_DISPARITY_BLEND,
  anchorVisibleFrontToScreen,
  constrainReliefBehindScreen,
  findVisibleDepthRange,
  createReliefInteractionMatrix,
  createMobileReliefScene,
  estimateUniformScaleDepthSpan,
} from './mobile-relief.js';
import {
  DEFAULT_VIEWING_DISTANCE_MM,
  VIEWING_DISTANCE_STORAGE_KEY,
  DEVICE_SIZE_STORAGE_KEY,
  computeViewingGeometry,
  loadStoredNumber,
  resolveScreenMetrics,
  saveStoredNumber,
} from './device-metrics.js';
import { createMobileRenderer } from './mobile-rendering.js';
import {
  classifyViewport,
  createRateMeter,
  createRenderGate,
  loadFrontCameraMirrorX,
  inferFrontCameraXyGain,
  probeMotionCapabilities,
  saveFrontCameraMirrorX,
} from './mobile-runtime.js';
import {
  MOBILE_RELIEF_EXAGGERATION,
  fetchPublishedScenePair,
} from './mobile-scene-client.js';
import { clampTiltCorrection, createTiltTracker } from './device-tilt.js';

const canvas = document.getElementById('viewer-canvas');
const sceneLabel = document.getElementById('scene-label');
const status = document.getElementById('viewer-status');
const startButton = document.getElementById('start-tracking');
const reloadButton = document.getElementById('reload-scene');
const recenterButton = document.getElementById('recenter-tracking');
const enableLevellingButton = document.getElementById('enable-levelling');
const flipTrackingXButton = document.getElementById('flip-tracking-x');
const stopButton = document.getElementById('stop-tracking');
const trackingVideo = document.getElementById('tracking-video');
const runtimeStatus = document.getElementById('runtime-status');
const poseReadout = document.getElementById('pose-readout');
const debugDistanceInput = document.getElementById('debug-distance');
const debugDistanceValue = document.getElementById('debug-distance-value');
const debugSpanInput = document.getElementById('debug-span');
const debugSpanValue = document.getElementById('debug-span-value');
const debugBlendInput = document.getElementById('debug-blend');
const debugBlendValue = document.getElementById('debug-blend-value');
const debugAnchorInput = document.getElementById('debug-anchor');
const debugRefitInput = document.getElementById('debug-refit');
const debugLevelInput = document.getElementById('debug-level');
const viewerParams = new URLSearchParams(window.location.search);
const debugTracking = viewerParams.has('debug');
// A URL override for the horizontal direction. Stored settings do not survive
// clearing site data, which makes an intermittent handedness problem very hard
// to pin down; `?flip=0` or `?flip=1` pins it for a session regardless.
const flipOverride = viewerParams.has('flip')
  ? viewerParams.get('flip') !== '0'
  : null;
let trackingMirrorX = flipOverride === null
  ? loadFrontCameraMirrorX(window.localStorage, navigator.userAgent)
  : flipOverride;
// Which way a device reports gravity relative to its screen is the same kind of
// device-dependent convention as the front camera's handedness, so it gets the
// same escape hatch: `?level=0` turns levelling off, `?levelFlip=1` reverses it.
const levelInvert = viewerParams.get('levelFlip') === '1';
// Forces the face model onto one processor so the two can be compared on the
// device. Left unset, the CPU path is tried first; see head-tracker.js.
const delegateOverride = viewerParams.get('delegate');
const levelEnabledByUrl = viewerParams.get('level') !== '0';
const trackingXyGain = inferFrontCameraXyGain(navigator.userAgent);

// Physical screen size is what turns the virtual screen's world units into real
// millimetres. Without it every head-tracking gain is a guess, and the eye ends
// up at roughly half the distance a phone is actually held at.
const screenMetrics = resolveScreenMetrics({
  screenWidth: window.screen?.width,
  screenHeight: window.screen?.height,
  devicePixelRatio: window.devicePixelRatio,
  measuredMmPerCssPx: loadStoredNumber(window.localStorage, DEVICE_SIZE_STORAGE_KEY),
});
let viewingDistanceMm = loadStoredNumber(window.localStorage, VIEWING_DISTANCE_STORAGE_KEY)
  ?? screenMetrics.defaultViewingDistanceMm
  ?? DEFAULT_VIEWING_DISTANCE_MM;

const state = {
  revision: 0,
  sourceScene: null,
  sourceImageSize: null,
  scene: null,
  manifest: null,
  interaction: null,
  loading: false,
  renderPending: false,
  eyePose: null,
  orientation: classifyViewport(window.innerWidth, window.innerHeight),
  geometry: null,
  variant: 'full',
  reducedAvailable: null,
  depthSpan: MOBILE_RELIEF_EXAGGERATION,
  disparityBlend: DEFAULT_DISPARITY_BLEND,
  motionCapabilities: null,
  tiltPermission: null,
  // A real object behind glass stays upright while its frame turns. Sharing the
  // screen's up axis makes the whole scene roll with the device instead.
  levelToGravity: levelEnabledByUrl,
  screenRoll: null,
  anchorVisibleFront: true,
  refitDepthToView: true,
  baseDepthRange: null,
  visibleFrontCorrection: 0,
  fittedDepthRange: null,
  refitHandle: null,
};
const renderRate = createRateMeter({ windowMs: 1200 });
// Draws only when an input has moved far enough to change a pixel. The eye pose
// arrives twenty times a second, so a sixty-times-a-second animation loop spent
// two frames in three redrawing an identical image.
const renderGate = createRenderGate();
let sceneGeneration = 0;
document.body.dataset.orientation = state.orientation;

let renderer;
try {
  renderer = createMobileRenderer(canvas);
} catch (error) {
  document.body.dataset.state = 'error';
  status.textContent = error.message;
  throw error;
}

function setStatus(message) {
  status.textContent = message;
  runtimeStatus.textContent = message;
}

function currentRenderInputs() {
  const eye = state.eyePose;
  const interaction = state.interaction || {};
  return {
    sceneId: sceneGeneration,
    width: canvas.clientWidth,
    height: canvas.clientHeight,
    eyeX: eye?.x ?? 0,
    eyeY: eye?.y ?? 0,
    eyeZ: eye?.z ?? currentBaselineEyeZ(),
    roll: state.levelToGravity ? (state.screenRoll ?? 0) : 0,
    yaw: Number(interaction.yaw) || 0,
    pitch: Number(interaction.pitch) || 0,
    panX: Number(interaction.panX) || 0,
    panY: Number(interaction.panY) || 0,
    scale: Number(interaction.scale) || 1,
  };
}

// `force` is for the things the gate cannot see: new geometry, a new texture,
// a changed presentation setting.
function requestRender({ force = false } = {}) {
  if (state.renderPending) return;
  if (force) renderGate.reset();
  const inputs = currentRenderInputs();
  if (!renderGate.shouldRender(inputs)) return;
  state.renderPending = true;
  requestAnimationFrame((timestamp) => {
    state.renderPending = false;
    // Re-read rather than reusing the inputs from scheduling time: anything
    // that moved in between belongs to the frame about to be drawn.
    renderGate.commit(currentRenderInputs());
    render();
    renderRate.mark(timestamp);
    updateDebugReadout();
  });
}

// The raw inputs, so which frame this platform reports gravity in can be read
// off a device instead of inferred from the specification.
function describeTiltReading() {
  const r = tilt.getReading?.();
  if (!r) return 'x — y — z —  screenAngle —';
  return `x ${r.x.toFixed(1)} y ${r.y.toFixed(1)} z ${r.z.toFixed(1)}  screenAngle ${r.screenAngle}`;
}

function describeMotionCapabilities() {
  const capabilities = state.motionCapabilities;
  if (!capabilities) return 'probing…';
  return [
    `immersive-ar ${capabilities.immersiveAr ? 'yes' : 'no'}`,
    `orientation ${capabilities.deviceOrientation ? 'yes' : 'no'}`,
    `motion ${capabilities.deviceMotion ? 'yes' : 'no'}`,
    capabilities.needsMotionPermission ? 'permission required' : 'no permission gate',
  ].join('  ');
}

function updateDebugReadout() {
  if (!debugTracking) return;
  const pose = state.eyePose;
  const metrics = tracker.getMetrics();
  // What the relief thickness would be with no depth remapping at all, only a
  // uniform scale, which is how the desktop and Looking Glass paths present the
  // same mesh. Comparing the two numbers shows how much this scene is being
  // compressed to keep it a miniature just behind the glass.
  // How much wider the back of the relief is than its front. Every vertex sits
  // on the ray from the calibrated eye through its own image anchor, which is
  // what makes the initial view reproduce the source image exactly -- and the
  // same construction necessarily splays the relief outwards with depth. The
  // two cannot be separated: an apex further away would splay less but would
  // contract distant content instead, so the picture would no longer match.
  // Past roughly 1.5 the splay turns each depth discontinuity into a long
  // radial streak.
  const effectiveSpan = state.scene?.effectiveSpan ?? state.depthSpan;
  const coneSplay = (currentBaselineEyeZ() + effectiveSpan) / currentBaselineEyeZ();
  const uniformSpan = state.scene ? estimateUniformScaleDepthSpan({
    sourceDepth: state.scene.sourceDepth,
    imageRectHeight: state.scene.imageRect?.height,
    captureFovDeg: state.manifest?.captureFovDeg,
  }) : null;
  // Stated explicitly because the handedness of a front camera is the one thing
  // here that cannot be settled by reasoning, only by looking at the number
  // while moving. Moving to your own right must make x go positive.
  const poseLine = pose
    ? `eye  x ${pose.x.toFixed(3)}  y ${pose.y.toFixed(3)}  z ${pose.z.toFixed(3)}   (move right → x should rise)`
    : 'eye  awaiting calibration';
  const firstPose = metrics.firstTrackedPoseMs === null
    ? '—'
    : `${Math.round(metrics.firstTrackedPoseMs)} ms`;
  poseReadout.textContent = [
    poseLine,
    `render ${renderRate.rate().toFixed(1)} fps  inference ${metrics.inferenceHz.toFixed(1)} Hz / ${metrics.inferenceDurationMs.toFixed(1)} ms on ${getActiveDelegate() ?? '—'}`,
    `camera ${metrics.cameraWidth || '—'}×${metrics.cameraHeight || '—'}  first pose ${firstPose}`,
    `viewport ${state.orientation}  ${window.innerWidth}×${window.innerHeight}`,
    `flip ${trackingMirrorX ? 'on' : 'off'}${flipOverride === null ? '' : ' (from URL)'}  source ${metrics.poseSource}  raw head x ${metrics.rawHeadXMm.toFixed(0)} mm  vs calibration ${metrics.calibratedHeadXMm.toFixed(0)} mm`,
    `screen ${screenMetrics.label} (${screenMetrics.source})  ${(state.geometry?.screenHeightMm ?? 0).toFixed(0)} mm tall  1 unit ${(state.geometry?.worldUnitMm ?? 0).toFixed(1)} mm`,
    `viewing ${viewingDistanceMm.toFixed(0)} mm  eyeZ ${(state.geometry?.baselineEyeZ ?? 0).toFixed(2)}  fov ${(state.geometry?.verticalFovDeg ?? 0).toFixed(1)}°  head ${metrics.headDistanceMm ? `${metrics.headDistanceMm.toFixed(0)} mm` : '—'}`,
    `depth span ${state.depthSpan.toFixed(2)} → ${effectiveSpan.toFixed(2)}  cone splay ${coneSplay.toFixed(2)}x  disparity blend ${state.disparityBlend.toFixed(2)}  uniform-scale span ${uniformSpan === null ? '—' : uniformSpan.toFixed(1)}`,
    `visible-front anchor ${state.anchorVisibleFront ? `on  pulled ${state.visibleFrontCorrection.toFixed(3)}` : 'off'}`,
    `sensors ${describeMotionCapabilities()}`,
    `level ${state.levelToGravity ? 'on' : 'off'}${levelInvert ? ' flipped' : ''}  permission ${state.tiltPermission ?? '—'}  roll ${state.screenRoll === null ? '—' : `${((state.screenRoll * 180) / Math.PI).toFixed(1)}°`}  applied ${((clampTiltCorrection(state.screenRoll ?? 0, { invert: levelInvert }) * 180) / Math.PI).toFixed(1)}°`,
    `gravity ${describeTiltReading()}`,
    `depth range ${state.scene ? `${state.scene.sourceDepth.near.toFixed(2)}–${state.scene.sourceDepth.far.toFixed(2)}${state.scene.depthRangeIsFitted ? ' (refit to view)' : ''}` : '—'}`,
  ].join('\n');
}

function decodeTexture(blob, timeoutMs = 15_000) {
  const timeout = new Promise((_, reject) => {
    window.setTimeout(
      () => reject(new Error('Published scene texture decode timed out on this device.')),
      timeoutMs,
    );
  });
  if (typeof createImageBitmap === 'function') {
    return Promise.race([
      createImageBitmap(blob).catch(() => {
        throw new Error('Published scene texture could not be decoded.');
      }),
      timeout,
    ]);
  }
  const legacy = new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    const finish = (callback, value) => {
      URL.revokeObjectURL(url);
      callback(value);
    };
    image.onload = () => finish(resolve, image);
    image.onerror = () => finish(
      reject,
      new Error('Published scene texture could not be decoded.'),
    );
    image.decoding = 'async';
    image.src = url;
  });
  return Promise.race([legacy, timeout]);
}

// The canvas is the physical window. Its CSS height times the device's real
// millimetres-per-CSS-pixel gives the screen height in millimetres, and the
// virtual screen is always two world units tall, so one world unit is half of
// that. Everything downstream — eye distance, head motion, relief depth — is
// expressed in those units.
function refreshViewingGeometry() {
  const cssHeight = Math.max(canvas.clientHeight || window.innerHeight, 1);
  state.geometry = computeViewingGeometry({
    canvasCssHeight: cssHeight,
    mmPerCssPx: screenMetrics.mmPerCssPx,
    viewingDistanceMm,
  });
  return state.geometry;
}

function currentBaselineEyeZ() {
  return state.geometry?.baselineEyeZ || refreshViewingGeometry().baselineEyeZ;
}

// The query projection must use the calibrated eye rather than the live one, or
// the model would swim about as the viewer's head moved.
function calibratedViewProjection(screen, transformedBounds) {
  const calibrated = { x: 0, y: 0, z: currentBaselineEyeZ() };
  const projectionMatrix = computeOffAxisProjection({
    eye: calibrated,
    screenHalfWidth: screen.halfWidth,
    screenHalfHeight: screen.halfHeight,
    near: 0.05,
    far: Math.max(10, calibrated.z - transformedBounds.min[2] + 2),
  }).projectionMatrix;
  return mat4.multiply(projectionMatrix, computeEyeViewMatrix(calibrated));
}

// Rebuilds the relief over the depth range that is actually on screen.
//
// Zooming into something distant is the case this exists for. In a room with a
// person at 1 m and balloons on a wall at 4 m, the balloons' own 10 cm of depth
// is under one percent of the scene's depth budget, so they stay flat however
// the relief is anchored. Rebuilt over just their range they receive all of it.
//
// This runs after a gesture settles rather than during it, because it rebuilds
// every vertex and re-uploads the buffers.
function refitDepthToVisibleRange() {
  if (!state.refitDepthToView || !state.scene || !state.sourceScene) return;
  const aspect = Math.max(canvas.clientWidth / Math.max(canvas.clientHeight, 1), 0.1);
  const screen = computeVirtualScreen(aspect);
  const pivotZ = state.scene.frontZ ?? 0;
  const touchTransform = createReliefInteractionMatrix({
    interaction: state.interaction,
    frontZ: pivotZ,
  });
  const safeModel = constrainReliefBehindScreen({
    bounds: state.scene.bounds,
    modelMatrix: touchTransform,
  });
  const visible = findVisibleDepthRange({
    frontSamples: state.scene.frontSamples,
    modelMatrix: safeModel.modelMatrix,
    viewProjectionMatrix: calibratedViewProjection(screen, safeModel.transformedBounds),
  });
  if (!visible) return;
  // The per-cell records hold raw source depths, so a refit must be clamped back
  // to the range the outlier quantiles chose. Without this, refitting would
  // quietly widen the range again and undo the outlier rejection.
  const base = state.baseDepthRange;
  const near = base ? Math.max(visible.near, base.near) : visible.near;
  const far = base ? Math.min(visible.far, base.far) : visible.far;
  if (!(far > near)) return;
  const current = state.scene.sourceDepth;
  const currentSpan = current.far - current.near;
  const visibleSpan = far - near;
  // Rebuilding is only worth its cost when the visible range is meaningfully
  // narrower than the one already in use. The comparison also stops the rebuild
  // from feeding back on itself, because refitting does not change which cells
  // are on screen.
  const narrowedEnough = visibleSpan < currentSpan * 0.9;
  const shiftedEnough = Math.abs(near - current.near) > currentSpan * 0.05;
  if (!narrowedEnough && !shiftedEnough) return;
  state.fittedDepthRange = { near, far };
  rebuildReliefGeometry();
  requestRender({ force: true });
}

function scheduleDepthRefit() {
  if (!state.refitDepthToView) return;
  window.clearTimeout(state.refitHandle);
  state.refitHandle = window.setTimeout(refitDepthToVisibleRange, 250);
}

function computeHeadCoupledMatrices(scene, interaction, eyePose) {
  const aspect = Math.max(canvas.clientWidth / Math.max(canvas.clientHeight, 1), 0.1);
  const screen = computeVirtualScreen(aspect);
  const eye = eyePose || {
    x: 0,
    y: 0,
    z: currentBaselineEyeZ(),
  };
  const pivotZ = scene.frontZ ?? 0;
  let touchTransform = createReliefInteractionMatrix({ interaction, frontZ: pivotZ });
  const levelling = state.levelToGravity && state.screenRoll !== null
    ? clampTiltCorrection(state.screenRoll, { invert: levelInvert })
    : 0;
  if (levelling !== 0) {
    // Rotated about the glass so the correction pivots where the picture meets
    // the screen, which is the one plane that must stay put.
    //
    // The sign follows from the measurement: gravity swinging toward the
    // screen's right edge means the device was turned clockwise as the viewer
    // sees it, and the scene must turn the other way, which is a positive
    // rotation about +z in screen coordinates. Confirmed on hardware.
    let level = mat4.translate(mat4.identity(), [0, 0, pivotZ]);
    level = mat4.rotateZ(level, levelling);
    level = mat4.translate(level, [0, 0, -pivotZ]);
    touchTransform = mat4.multiply(level, touchTransform);
  }
  let safeModel = constrainReliefBehindScreen({
    bounds: scene.bounds,
    modelMatrix: touchTransform,
  });
  // Once the viewer pinches into part of the scene, the nearest thing still on
  // screen may sit deep inside the relief, and everything in view then shares a
  // large common slide that carries no shape information. Pulling the visible
  // front up to the glass removes that common part and puts the view back on
  // the steepest part of the parallax curve.
  if (state.anchorVisibleFront) {
    const anchored = anchorVisibleFrontToScreen({
      frontSamples: scene.frontSamples,
      modelMatrix: safeModel.modelMatrix,
      viewProjectionMatrix: calibratedViewProjection(screen, safeModel.transformedBounds),
    });
    if (anchored) {
      safeModel = {
        modelMatrix: anchored.modelMatrix,
        transformedBounds: transformBounds(scene.bounds, anchored.modelMatrix),
        correctionZ: safeModel.correctionZ + anchored.correctionZ,
      };
      state.visibleFrontCorrection = anchored.correctionZ;
    }
  }
  // No geometry is ever allowed in front of the glass, so nothing can be nearer
  // than the eye's own distance. Pushing the near plane out accordingly keeps
  // depth precision usable even when the relief is set several screen heights
  // deep for comparison against plain uniform scaling.
  const near = Math.max(0.05, (eye.z - safeModel.transformedBounds.max[2]) * 0.5);
  const far = Math.max(near * 4, eye.z - safeModel.transformedBounds.min[2] + 2);
  const { projectionMatrix } = computeOffAxisProjection({
    eye,
    screenHalfWidth: screen.halfWidth,
    screenHalfHeight: screen.halfHeight,
    near,
    far,
  });
  return {
    modelMatrix: safeModel.modelMatrix,
    viewMatrix: computeEyeViewMatrix(eye),
    projectionMatrix,
  };
}

function rebuildReliefGeometry({ upload = true } = {}) {
  if (!state.sourceScene || !state.sourceImageSize) return;
  const aspect = Math.max(canvas.clientWidth / Math.max(canvas.clientHeight, 1), 0.1);
  const screen = computeVirtualScreen(aspect);
  const { width: sourceWidth, height: sourceHeight } = state.sourceImageSize;
  state.scene = createMobileReliefScene({
    scene: state.sourceScene,
    sourceAspect: sourceWidth / Math.max(sourceHeight, 1),
    screenWidth: screen.width,
    screenHeight: screen.height,
    baselineEyeZ: refreshViewingGeometry().baselineEyeZ,
    depthSpan: state.depthSpan,
    disparityBlend: state.disparityBlend,
    depthRange: state.fittedDepthRange,
    // The virtual glass is the invariant pivot plane. Legacy manifests may
    // contain a small offset, but no published relief is allowed to move it.
    frontZ: 0,
    occupancy: state.manifest?.screenOccupancy ?? 0.92,
  });
  // The first build of a scene establishes the outlier-trimmed range that every
  // later refit is clamped to.
  if (!state.scene.depthRangeIsFitted) {
    state.baseDepthRange = { ...state.scene.sourceDepth };
  }
  if (upload) renderer.updateGeometry(state.scene);
  sceneGeneration += 1;
}

function render() {
  renderer.resize(window.innerWidth, window.innerHeight);
  if (!state.scene) {
    renderer.clear();
    return;
  }
  renderer.render(computeHeadCoupledMatrices(state.scene, state.interaction, state.eyePose));
}

async function loadPublishedScene({ force = false, variant = state.variant } = {}) {
  if (state.loading) return;
  state.loading = true;
  const wasViewing = tracker.running || document.body.dataset.state === 'viewing';
  try {
    const { envelope, modelResponse, unchanged, servedVariant } = await fetchPublishedScenePair({
      knownRevision: state.revision,
      knownPublishedAt: state.manifest?.publishedAt,
      force,
      variant,
    });
    if (!envelope.available) {
      state.sourceScene = null;
      state.sourceImageSize = null;
      state.scene = null;
      state.revision = 0;
      startButton.disabled = true;
      state.variant = 'full';
      state.reducedAvailable = false;
      tracker.stop({ emit: false });
      tilt.stop();
      state.screenRoll = null;
      renderRate.reset();
      recenterButton.disabled = true;
      stopButton.disabled = true;
      sceneGeneration += 1;
      sceneLabel.textContent = 'Awaiting published scene';
      document.body.dataset.state = 'no-scene';
      setStatus('No scene yet. Use Publish to Mobile in the desktop editor.');
      requestRender();
      return;
    }
    if (unchanged) return;

    const contentLength = Number(modelResponse.headers.get('Content-Length'));
    const sizeLabel = Number.isFinite(contentLength) && contentLength > 0
      ? ` (${(contentLength / (1024 * 1024)).toFixed(1)} MB)`
      : '';
    setStatus(`Downloading ${envelope.filename}${sizeLabel}…`);
    const modelBuffer = await modelResponse.arrayBuffer();
    setStatus(`Parsing ${envelope.filename}…`);
    const sourceScene = parseGlb(modelBuffer);
    setStatus(`Decoding ${envelope.filename} texture…`);
    const image = await decodeTexture(sourceScene.imageBlob);
    state.sourceScene = sourceScene;
    // The bitmap is released as soon as it reaches the GPU, so its dimensions
    // are kept separately for the relief rebuilds that follow every resize.
    state.sourceImageSize = {
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
    };
    state.variant = servedVariant || variant;
    state.fittedDepthRange = null;
    state.baseDepthRange = null;
    state.reducedAvailable = Boolean(envelope.hasReduced);
    state.manifest = envelope.manifest;
    state.depthSpan = Number.isFinite(envelope.manifest?.depthSpan)
      ? envelope.manifest.depthSpan
      : MOBILE_RELIEF_EXAGGERATION;
    state.disparityBlend = Number.isFinite(envelope.manifest?.disparityBlend)
      ? envelope.manifest.disparityBlend
      : DEFAULT_DISPARITY_BLEND;
    syncDebugControls();
    rebuildReliefGeometry({ upload: false });
    renderer.setScene(state.scene, image);
    sceneGeneration += 1;
    state.revision = envelope.revision;
    startButton.disabled = false;
    sceneLabel.textContent = `${envelope.filename} · r${envelope.revision}`;
    document.body.dataset.state = wasViewing ? 'viewing' : 'ready';
    const variantNote = state.variant === 'reduced' ? ' (reduced build)' : '';
    setStatus(wasViewing
      ? `Scene updated to revision ${envelope.revision}${variantNote}.`
      : `Scene ready${variantNote}. Drag to rotate; pinch to zoom and pan.`);
    requestRender();
  } catch (error) {
    console.error(error);
    // No browser API on iOS reports available memory, so the smaller build can
    // only be chosen after the full one has genuinely failed to load.
    if (variant !== 'reduced' && state.reducedAvailable !== false) {
      state.loading = false;
      setStatus('Full scene did not load on this device; retrying with the reduced build…');
      await loadPublishedScene({ force: true, variant: 'reduced' });
      return;
    }
    document.body.dataset.state = 'error';
    setStatus(error.message || 'Published scene could not be loaded.');
  } finally {
    state.loading = false;
  }
}

let flipGestureGuard = false;
let levellingGestureGuard = false;

// Reads which way is down so the miniature can stay upright while the device
// rolls. Only the screen-plane roll is used, which is referenced to gravity and
// so does not drift; no heading is involved.
const tilt = createTiltTracker({
  onRoll(roll) {
    state.screenRoll = roll;
    requestRender();
  },
});

const touch = createTouchInteraction(canvas, {
  onChange(interaction) {
    state.interaction = interaction;
    // When the view returns to the whole image the relief goes back to the full
    // scene, so zooming out always undoes a refit.
    if (interaction.scale <= 1.01 && state.fittedDepthRange) {
      state.fittedDepthRange = null;
      rebuildReliefGeometry();
    }
    scheduleDepthRefit();
    requestRender();
  },
});
state.interaction = touch.getState();

document.body.classList.toggle('debug-tracking', debugTracking);

const tracker = new HeadTracker({
  video: trackingVideo,
  baselineEyeZ: refreshViewingGeometry().baselineEyeZ,
  worldUnitMm: state.geometry.worldUnitMm,
  mirrorX: trackingMirrorX,
  xyGain: trackingXyGain,
  delegate: delegateOverride,
  onStatus({ code, message }) {
    document.body.dataset.tracking = code;
    setStatus(message);
  },
  onPose(pose) {
    state.eyePose = pose;
    requestRender();
  },
});

// Shown only when levelling is wanted, the camera is running, and motion access
// has not been granted. iOS home-screen apps have been seen to skip the prompt
// entirely on a cold start, and there is otherwise no way to ask again without
// restarting the camera.
function updateLevellingButton() {
  const needed = state.levelToGravity
    && tracker.running
    && state.tiltPermission !== null
    && state.tiltPermission !== 'granted';
  enableLevellingButton.hidden = !needed;
}

enableLevellingButton.addEventListener('pointerdown', (event) => {
  if (touch.activePointerCount() > 0) {
    event.preventDefault();
    levellingGestureGuard = true;
  }
});

enableLevellingButton.addEventListener('click', () => {
  if (levellingGestureGuard) {
    levellingGestureGuard = false;
    return;
  }
  // Issued before any await so the tap still counts as a user action.
  const request = tilt.start();
  setStatus('Requesting motion access…');
  void request.then((permission) => {
    state.tiltPermission = permission;
    setStatus(permission === 'granted'
      ? 'Motion access granted · the view will stay upright.'
      : 'Motion access was refused; the view will not stay upright.');
    updateLevellingButton();
    requestRender();
  });
});

function updateTrackingDirectionButton() {
  flipTrackingXButton.setAttribute('aria-pressed', String(trackingMirrorX));
  // This button sits over the canvas, so a stray finger during a pinch can
  // toggle it, and the wrong setting then persists across sessions. Say so
  // loudly rather than leaving it to be discovered by the view feeling wrong.
  flipTrackingXButton.textContent = trackingMirrorX ? 'Flip L/R' : 'L/R inverted';
  flipTrackingXButton.title = trackingMirrorX
    ? 'Horizontal camera coordinates are flipped (the normal setting)'
    : 'Horizontal camera coordinates are used as delivered (inverted from normal)';
}

// Guard against a finger that is really part of a canvas gesture. This button
// overlays the canvas, and an accidental flip persists across sessions, which
// makes it look as though tracking has spontaneously reversed.
flipTrackingXButton.addEventListener('pointerdown', (event) => {
  if (touch.activePointerCount() > 0) {
    event.preventDefault();
    flipGestureGuard = true;
    setStatus('Left/right button ignored during a canvas gesture.');
  }
});

flipTrackingXButton.addEventListener('click', () => {
  if (flipGestureGuard) {
    flipGestureGuard = false;
    return;
  }
  trackingMirrorX = !trackingMirrorX;
  saveFrontCameraMirrorX(window.localStorage, trackingMirrorX);
  tracker.setMirrorX(trackingMirrorX);
  state.eyePose = null;
  updateTrackingDirectionButton();
  setStatus('Left/right tracking direction changed · hold center while recalibrating.');
  requestRender({ force: true });
});
updateTrackingDirectionButton();

function recenterTracking() {
  state.eyePose = null;
  tracker.recenter();
  requestRender({ force: true });
}

startButton.addEventListener('click', async () => {
  if (!state.scene || tracker.running) return;
  startButton.disabled = true;
  setStatus('Starting local head tracking…');
  try {
    const geometry = refreshViewingGeometry();
    tracker.setViewingGeometry({
      worldUnitMm: geometry.worldUnitMm,
      baselineEyeZ: geometry.baselineEyeZ,
    });
    // Both permission-gated calls are issued before anything is awaited, so
    // both are made while the tap still counts as a user action. Awaiting the
    // camera first spends that activation: starting it also fetches the face
    // model, which takes seconds on a cold start, and the motion request that
    // followed then found no activation left and never prompted. A home-screen
    // app starts cold every time, which is why it failed there first.
    const trackingStarted = tracker.start();
    const tiltStarted = state.levelToGravity ? tilt.start() : null;
    // Recorded independently of the camera, so its answer is never lost when
    // the camera fails and its promise is always consumed.
    if (tiltStarted) {
      void tiltStarted.then((permission) => {
        state.tiltPermission = permission;
        if (permission !== 'granted') state.screenRoll = null;
        updateLevellingButton();
        requestRender();
      });
    }
    await trackingStarted;
    document.body.dataset.state = 'viewing';
    startButton.textContent = 'Tracking active';
    recenterButton.disabled = false;
    stopButton.disabled = false;
    renderRate.reset();
    requestRender({ force: true });
  } catch (error) {
    console.error(error);
    document.body.dataset.state = 'tracking-error';
    document.body.dataset.tracking = 'unavailable';
    startButton.textContent = 'Retry camera';
    startButton.disabled = false;
    recenterButton.disabled = true;
    stopButton.disabled = true;
    renderRate.reset();
    setStatus(`Camera tracking unavailable: ${error.message} Static touch view remains active.`);
  }
});

recenterButton.addEventListener('click', recenterTracking);

stopButton.addEventListener('click', () => {
  tracker.stop();
  tilt.stop();
  state.screenRoll = null;
  state.tiltPermission = null;
  updateLevellingButton();
  renderRate.reset();
  startButton.textContent = 'Start 3D';
  startButton.disabled = false;
  recenterButton.disabled = true;
  stopButton.disabled = true;
  state.eyePose = null;
  requestRender();
});

reloadButton.addEventListener('click', () => {
  void loadPublishedScene({ force: true });
});

function handleViewportChange() {
  touch.cancelGesture();
  const nextOrientation = classifyViewport(window.innerWidth, window.innerHeight);
  if (nextOrientation !== state.orientation) {
    state.orientation = nextOrientation;
    document.body.dataset.orientation = nextOrientation;
    if (tracker.running) recenterTracking();
  }
  const geometry = refreshViewingGeometry();
  tracker.setViewingGeometry({
    worldUnitMm: geometry.worldUnitMm,
    baselineEyeZ: geometry.baselineEyeZ,
  });
  rebuildReliefGeometry();
  requestRender({ force: true });
}

window.addEventListener('resize', handleViewportChange);
window.addEventListener('orientationchange', () => requestAnimationFrame(handleViewportChange));
window.visualViewport?.addEventListener('resize', handleViewportChange);
window.addEventListener('pagehide', () => {
  tilt.stop();
  tracker.stop({ emit: false });
  renderRate.reset();
  touch.destroy();
}, { once: true });

// The three presentation variables that can only be settled by looking at a
// real device: how far the viewer actually holds it, how thick the miniature
// should be, and how much of the depth budget the near subject should take.
function syncDebugControls() {
  if (!debugTracking) return;
  debugDistanceInput.value = String(Math.round(viewingDistanceMm));
  debugDistanceValue.textContent = String(Math.round(viewingDistanceMm));
  debugSpanInput.value = state.depthSpan.toFixed(2);
  debugSpanValue.textContent = state.depthSpan.toFixed(2);
  debugBlendInput.value = state.disparityBlend.toFixed(2);
  debugBlendValue.textContent = state.disparityBlend.toFixed(2);
  debugAnchorInput.checked = state.anchorVisibleFront;
  debugRefitInput.checked = state.refitDepthToView;
  debugLevelInput.checked = state.levelToGravity;
}

if (debugTracking) {
  debugDistanceInput.addEventListener('input', () => {
    viewingDistanceMm = Number(debugDistanceInput.value);
    saveStoredNumber(window.localStorage, VIEWING_DISTANCE_STORAGE_KEY, viewingDistanceMm);
    const geometry = refreshViewingGeometry();
    tracker.setViewingGeometry({
      worldUnitMm: geometry.worldUnitMm,
      baselineEyeZ: geometry.baselineEyeZ,
    });
    syncDebugControls();
    rebuildReliefGeometry();
    requestRender({ force: true });
  });
  debugSpanInput.addEventListener('input', () => {
    state.depthSpan = Number(debugSpanInput.value);
    syncDebugControls();
    rebuildReliefGeometry();
    requestRender({ force: true });
  });
  debugBlendInput.addEventListener('input', () => {
    state.disparityBlend = Number(debugBlendInput.value);
    syncDebugControls();
    rebuildReliefGeometry();
    requestRender({ force: true });
  });
  debugLevelInput.addEventListener('change', async () => {
    state.levelToGravity = debugLevelInput.checked;
    if (state.levelToGravity && tracker.running) {
      const permission = await tilt.start();
      if (permission !== 'granted') {
        setStatus('Motion access was refused; the view will not stay upright.');
      }
    } else if (!state.levelToGravity) {
      tilt.stop();
      state.screenRoll = null;
    }
    syncDebugControls();
    requestRender({ force: true });
  });
  debugRefitInput.addEventListener('change', () => {
    state.refitDepthToView = debugRefitInput.checked;
    if (!state.refitDepthToView && state.fittedDepthRange) {
      state.fittedDepthRange = null;
      rebuildReliefGeometry();
    }
    syncDebugControls();
    requestRender({ force: true });
  });
  debugAnchorInput.addEventListener('change', () => {
    state.anchorVisibleFront = debugAnchorInput.checked;
    state.visibleFrontCorrection = 0;
    syncDebugControls();
    requestRender({ force: true });
  });
  syncDebugControls();
}

if (debugTracking) {
  void probeMotionCapabilities().then((capabilities) => {
    state.motionCapabilities = capabilities;
    updateDebugReadout();
  });
}

void loadPublishedScene();
window.setInterval(() => void loadPublishedScene(), 3000);
