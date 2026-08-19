import { parseGlb } from './glb-loader.js';
import { HeadTracker } from './head-tracker.js';
import {
  computeEyeViewMatrix,
  computeOffAxisProjection,
  computeVirtualScreen,
} from './head-coupled-projection.js';
import { createTouchInteraction } from './mobile-interaction.js';
import {
  DEFAULT_DISPARITY_BLEND,
  constrainReliefBehindScreen,
  createReliefInteractionMatrix,
  createMobileReliefScene,
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
  sourceImage: null,
  scene: null,
  manifest: null,
  interaction: null,
  loading: false,
  renderPending: false,
  continuousRenderHandle: null,
  eyePose: null,
  orientation: classifyViewport(window.innerWidth, window.innerHeight),
  geometry: null,
  depthSpan: 1,
  disparityBlend: DEFAULT_DISPARITY_BLEND,
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
    `depth span ${state.depthSpan.toFixed(3)}  disparity blend ${state.disparityBlend.toFixed(2)}`,
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

function loadImage(blob, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
      callback(value);
    };
    const timer = window.setTimeout(() => {
      image.src = '';
      finish(reject, new Error('Published scene texture decode timed out on this device. Republish the optimized mobile scene.'));
    }, timeoutMs);
    image.onload = () => {
      finish(resolve, image);
    };
    image.onerror = () => {
      finish(reject, new Error('Published scene texture could not be decoded. Republish the optimized mobile scene.'));
    };
    image.decoding = 'async';
    image.src = url;
  });
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

function computeHeadCoupledMatrices(scene, interaction, eyePose) {
  const aspect = Math.max(canvas.clientWidth / Math.max(canvas.clientHeight, 1), 0.1);
  const screen = computeVirtualScreen(aspect);
  const eye = eyePose || {
    x: 0,
    y: 0,
    z: currentBaselineEyeZ(),
  };
  const near = 0.05;
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
  const safeModel = constrainReliefBehindScreen({
    bounds: scene.bounds,
    modelMatrix: touchTransform,
  });
  const far = Math.max(10, eye.z - safeModel.transformedBounds.min[2] + 2);
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
  if (!state.sourceScene || !state.sourceImage) return;
  const aspect = Math.max(canvas.clientWidth / Math.max(canvas.clientHeight, 1), 0.1);
  const screen = computeVirtualScreen(aspect);
  const sourceWidth = state.sourceImage.naturalWidth || state.sourceImage.width;
  const sourceHeight = state.sourceImage.naturalHeight || state.sourceImage.height;
  state.scene = createMobileReliefScene({
    scene: state.sourceScene,
    sourceAspect: sourceWidth / Math.max(sourceHeight, 1),
    screenWidth: screen.width,
    screenHeight: screen.height,
    baselineEyeZ: refreshViewingGeometry().baselineEyeZ,
    depthSpan: state.depthSpan,
    disparityBlend: state.disparityBlend,
    // The virtual glass is the invariant pivot plane. Legacy manifests may
    // contain a small offset, but no published relief is allowed to move it.
    frontZ: 0,
    occupancy: state.manifest?.screenOccupancy ?? 0.92,
  });
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

async function loadPublishedScene({ force = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  const wasViewing = tracker.running || document.body.dataset.state === 'viewing';
  try {
    const { envelope, modelResponse, unchanged } = await fetchPublishedScenePair({
      knownRevision: state.revision,
      knownPublishedAt: state.manifest?.publishedAt,
      force,
    });
    if (!envelope.available) {
      state.sourceScene = null;
      state.sourceImage = null;
      state.scene = null;
      state.revision = 0;
      startButton.disabled = true;
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
    const image = await loadImage(sourceScene.imageBlob);
    state.sourceScene = sourceScene;
    state.sourceImage = image;
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
    setStatus(wasViewing
      ? `Scene updated to revision ${envelope.revision}.`
      : 'Scene ready. Drag to rotate; pinch to zoom and pan.');
    requestRender();
  } catch (error) {
    console.error(error);
    document.body.dataset.state = 'error';
    setStatus(error.message || 'Published scene could not be loaded.');
  } finally {
    state.loading = false;
  }
}

const touch = createTouchInteraction(canvas, {
  onChange(interaction) {
    state.interaction = interaction;
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
  syncDebugControls();
}

void loadPublishedScene();
window.setInterval(() => void loadPublishedScene(), 3000);
