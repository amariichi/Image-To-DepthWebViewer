import { parseGlb } from './glb-loader.js';
import { HeadTracker } from './head-tracker.js';
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
  loadFrontCameraMirrorX,
  inferFrontCameraXyGain,
  saveFrontCameraMirrorX,
} from './mobile-runtime.js';
import { fetchPublishedScenePair } from './mobile-scene-client.js';

const canvas = document.getElementById('viewer-canvas');
const sceneLabel = document.getElementById('scene-label');
const status = document.getElementById('viewer-status');
const startButton = document.getElementById('start-tracking');
const reloadButton = document.getElementById('reload-scene');
const recenterButton = document.getElementById('recenter-tracking');
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
const debugTracking = new URLSearchParams(window.location.search).has('debug');
let trackingMirrorX = loadFrontCameraMirrorX(window.localStorage, navigator.userAgent);
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
  continuousRenderHandle: null,
  eyePose: null,
  orientation: classifyViewport(window.innerWidth, window.innerHeight),
  geometry: null,
  variant: 'full',
  reducedAvailable: null,
  depthSpan: 1,
  disparityBlend: DEFAULT_DISPARITY_BLEND,
  anchorVisibleFront: true,
  refitDepthToView: true,
  baseDepthRange: null,
  visibleFrontCorrection: 0,
  fittedDepthRange: null,
  refitHandle: null,
};
const renderRate = createRateMeter({ windowMs: 1200 });
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

function requestRender() {
  if (state.continuousRenderHandle !== null) return;
  if (state.renderPending) return;
  state.renderPending = true;
  requestAnimationFrame((timestamp) => {
    state.renderPending = false;
    render();
    renderRate.mark(timestamp);
    updateDebugReadout();
  });
}

function updateDebugReadout() {
  if (!debugTracking) return;
  const pose = state.eyePose;
  const metrics = tracker.getMetrics();
  // What the relief thickness would be with no depth remapping at all, only a
  // uniform scale, which is how the desktop and Looking Glass paths present the
  // same mesh. Comparing the two numbers shows how much this scene is being
  // compressed to keep it a miniature just behind the glass.
  const uniformSpan = state.scene ? estimateUniformScaleDepthSpan({
    sourceDepth: state.scene.sourceDepth,
    imageRectHeight: state.scene.imageRect?.height,
    captureFovDeg: state.manifest?.captureFovDeg,
  }) : null;
  const poseLine = pose
    ? `eye  x ${pose.x.toFixed(3)}  y ${pose.y.toFixed(3)}  z ${pose.z.toFixed(3)}`
    : 'eye  awaiting calibration';
  const firstPose = metrics.firstTrackedPoseMs === null
    ? '—'
    : `${Math.round(metrics.firstTrackedPoseMs)} ms`;
  poseReadout.textContent = [
    poseLine,
    `render ${renderRate.rate().toFixed(1)} fps  inference ${metrics.inferenceHz.toFixed(1)} Hz / ${metrics.inferenceDurationMs.toFixed(1)} ms`,
    `camera ${metrics.cameraWidth || '—'}×${metrics.cameraHeight || '—'}  first pose ${firstPose}`,
    `viewport ${state.orientation}  ${window.innerWidth}×${window.innerHeight}`,
    `horizontal camera flip ${trackingMirrorX ? 'on' : 'off'}  ${metrics.metricAvailable ? 'metric head pose' : `ratio fallback gain ${trackingXyGain.toFixed(3)}`}`,
    `screen ${screenMetrics.label} (${screenMetrics.source})  ${(state.geometry?.screenHeightMm ?? 0).toFixed(0)} mm tall  1 unit ${(state.geometry?.worldUnitMm ?? 0).toFixed(1)} mm`,
    `viewing ${viewingDistanceMm.toFixed(0)} mm  eyeZ ${(state.geometry?.baselineEyeZ ?? 0).toFixed(2)}  fov ${(state.geometry?.verticalFovDeg ?? 0).toFixed(1)}°  head ${metrics.headDistanceMm ? `${metrics.headDistanceMm.toFixed(0)} mm` : '—'}`,
    `depth span ${state.depthSpan.toFixed(2)}  disparity blend ${state.disparityBlend.toFixed(2)}  uniform-scale span ${uniformSpan === null ? '—' : uniformSpan.toFixed(1)}`,
    `visible-front anchor ${state.anchorVisibleFront ? `on  pulled ${state.visibleFrontCorrection.toFixed(3)}` : 'off'}`,
    `depth range ${state.scene ? `${state.scene.sourceDepth.near.toFixed(2)}–${state.scene.sourceDepth.far.toFixed(2)}${state.scene.depthRangeIsFitted ? ' (refit to view)' : ''}` : '—'}`,
  ].join('\n');
}

function continuousRender(timestamp) {
  state.continuousRenderHandle = null;
  render();
  renderRate.mark(timestamp);
  updateDebugReadout();
  if (tracker.running) {
    state.continuousRenderHandle = requestAnimationFrame(continuousRender);
  }
}

function startContinuousRendering() {
  if (state.continuousRenderHandle !== null) return;
  renderRate.reset();
  state.continuousRenderHandle = requestAnimationFrame(continuousRender);
}

function stopContinuousRendering() {
  if (state.continuousRenderHandle !== null) {
    cancelAnimationFrame(state.continuousRenderHandle);
    state.continuousRenderHandle = null;
  }
  renderRate.reset();
}

// `createImageBitmap` decodes off the main thread and hands back a GPU-ready
// bitmap, so no full-size RGBA copy is ever materialised in the page. The
// texture is the single largest thing a constrained browser has to hold, so
// this is where the memory headroom actually comes from.
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
    depthSpan: state.scene.depthSpan || state.depthSpan,
    eyeZ: currentBaselineEyeZ(),
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
  requestRender();
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
  // Pinch magnifies the miniature, so relief depth grows with it up to a bound
  // set by the viewer's real distance. Freezing depth would flatten the model
  // into an anamorphic card exactly when the viewer zooms in to inspect it.
  const touchTransform = createReliefInteractionMatrix({
    interaction,
    frontZ: pivotZ,
    depthSpan: scene.depthSpan || state.depthSpan,
    eyeZ: eye.z,
  });
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
      stopContinuousRendering();
      recenterButton.disabled = true;
      stopButton.disabled = true;
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
      : 1;
    state.disparityBlend = Number.isFinite(envelope.manifest?.disparityBlend)
      ? envelope.manifest.disparityBlend
      : DEFAULT_DISPARITY_BLEND;
    syncDebugControls();
    rebuildReliefGeometry({ upload: false });
    renderer.setScene(state.scene, image);
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
  onStatus({ code, message }) {
    document.body.dataset.tracking = code;
    setStatus(message);
  },
  onPose(pose) {
    state.eyePose = pose;
    requestRender();
  },
});

function updateTrackingDirectionButton() {
  flipTrackingXButton.setAttribute('aria-pressed', String(trackingMirrorX));
  flipTrackingXButton.title = trackingMirrorX
    ? 'Horizontal camera coordinates are flipped'
    : 'Horizontal camera coordinates are used as delivered';
}

flipTrackingXButton.addEventListener('click', () => {
  trackingMirrorX = !trackingMirrorX;
  saveFrontCameraMirrorX(window.localStorage, trackingMirrorX);
  tracker.setMirrorX(trackingMirrorX);
  state.eyePose = null;
  updateTrackingDirectionButton();
  setStatus('Left/right tracking direction changed · hold center while recalibrating.');
  requestRender();
});
updateTrackingDirectionButton();

function recenterTracking() {
  state.eyePose = null;
  tracker.recenter();
  requestRender();
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
    await tracker.start();
    document.body.dataset.state = 'viewing';
    startButton.textContent = 'Tracking active';
    recenterButton.disabled = false;
    stopButton.disabled = false;
    startContinuousRendering();
  } catch (error) {
    console.error(error);
    document.body.dataset.state = 'tracking-error';
    document.body.dataset.tracking = 'unavailable';
    startButton.textContent = 'Retry camera';
    startButton.disabled = false;
    recenterButton.disabled = true;
    stopButton.disabled = true;
    stopContinuousRendering();
    setStatus(`Camera tracking unavailable: ${error.message} Static touch view remains active.`);
  }
});

recenterButton.addEventListener('click', recenterTracking);

stopButton.addEventListener('click', () => {
  tracker.stop();
  stopContinuousRendering();
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
  requestRender();
}

window.addEventListener('resize', handleViewportChange);
window.addEventListener('orientationchange', () => requestAnimationFrame(handleViewportChange));
window.visualViewport?.addEventListener('resize', handleViewportChange);
window.addEventListener('pagehide', () => {
  tracker.stop({ emit: false });
  stopContinuousRendering();
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
    requestRender();
  });
  debugSpanInput.addEventListener('input', () => {
    state.depthSpan = Number(debugSpanInput.value);
    syncDebugControls();
    rebuildReliefGeometry();
    requestRender();
  });
  debugBlendInput.addEventListener('input', () => {
    state.disparityBlend = Number(debugBlendInput.value);
    syncDebugControls();
    rebuildReliefGeometry();
    requestRender();
  });
  debugRefitInput.addEventListener('change', () => {
    state.refitDepthToView = debugRefitInput.checked;
    if (!state.refitDepthToView && state.fittedDepthRange) {
      state.fittedDepthRange = null;
      rebuildReliefGeometry();
    }
    syncDebugControls();
    requestRender();
  });
  debugAnchorInput.addEventListener('change', () => {
    state.anchorVisibleFront = debugAnchorInput.checked;
    state.visibleFrontCorrection = 0;
    syncDebugControls();
    requestRender();
  });
  syncDebugControls();
}

void loadPublishedScene();
window.setInterval(() => void loadPublishedScene(), 3000);
