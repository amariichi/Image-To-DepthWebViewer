import { parseGlb } from './glb-loader.js';
import { HeadTracker, getActiveDelegate } from './head-tracker.js';
import {
  computeEyeViewMatrix,
  computeOffAxisProjection,
  computeVirtualScreen,
  frameVirtualScreen,
  transformBounds,
} from './head-coupled-projection.js';
import { mat4 } from './rendering.js';
import { MIN_TOUCH_SCALE, createTouchInteraction } from './mobile-interaction.js';
import {
  DEFAULT_DISPARITY_BLEND,
  anchorVisibleFrontToScreen,
  constrainReliefBehindScreen,
  findVisibleDepthRange,
  createReliefInteractionMatrix,
  createTrueWindowInteractionMatrix,
  createMobileReliefScene,
  estimateUniformScaleDepthSpan,
} from './mobile-relief.js';
import {
  DEFAULT_VIEWING_DISTANCE_MM,
  VIEWING_DISTANCE_STORAGE_KEY,
  DEVICE_SIZE_STORAGE_KEY,
  computeViewingGeometry,
  loadStoredNumber,
  mmPerCssPxFromPanelLongSide,
  preservePhysicalPoint,
  resolveScreenMetrics,
  saveStoredNumber,
} from './device-metrics.js';
import {
  distanceScaleFrom,
  loadDistanceScale,
  saveDistanceScale,
} from './head-distance-calibration.js';
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
  fetchPublishedSceneManifest,
  fetchPublishedScenePair,
} from './mobile-scene-client.js';
import {
  DEFAULT_ORIENTATION_SETTLE_MS,
  createTiltTracker,
  wrapAngle,
} from './device-tilt.js';
import {
  DEFAULT_LEVELLING_GAIN,
  TRUE_WINDOW_PITCH_GAIN,
  TRUE_WINDOW_PITCH_MAX_RAD,
  computeYawDecoupledLevelling,
  quaternionToMatrix,
  referencedEyeForDevicePose,
  sceneRotationForDevicePose,
  sceneYawForDevice,
  screenYawForGravityAttitude,
  toQuaternion,
  upInDeviceFrame,
} from './mobile-levelling.js';
import {
  createSourceSceneFromBuiltRgbde,
  createSourceSceneFromGlb,
} from './mobile-source-scene.js';
import {
  clampCameraRayDepthFloor,
  computeSourceExactWindowPlacement,
  computeSourceOverviewFraming,
  estimateCameraAxisDepthQuantile,
  mapTrackedEyeAroundReference,
  mapTrackedEyeToCaptureApex,
  trueWindowEyeResponseForRelief,
  trueWindowLateralEyeResponse,
} from './mobile-window-placement.js';
import { imageFromPasteEvent, readImageFromClipboard } from './clipboard-image.js';
import {
  MAX_FOCAL_LENGTH_35MM,
  MIN_FOCAL_LENGTH_35MM,
  MobileDepthRequestAborted,
  requestRgbdeForImage,
  validateFocalLength35mm,
} from './mobile-depth-client.js';
import { createLatestRequestGate } from './mobile-request-gate.js';
import { MAX_MOBILE_PUBLISH_VERTICES } from './mobile-publish-mesh.js';
import { createMobileChromeMachine } from './mobile-chrome.js';

const MOBILE_VIEWER_BUILD = '2026-08-29-m23';

const canvas = document.getElementById('viewer-canvas');
const viewerStage = document.getElementById('viewer-stage');
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
const pasteImageButton = document.getElementById('paste-image');
const chooseImageButton = document.getElementById('choose-image');
const imageFileInput = document.getElementById('image-file-input');
const buildOverlay = document.getElementById('build-overlay');
const buildPhase = document.getElementById('build-phase');
const buildElapsed = document.getElementById('build-elapsed');
const fovDialog = document.getElementById('fov-dialog');
const fovForm = document.getElementById('fov-form');
const fovInput = document.getElementById('fov-input');
const fovError = document.getElementById('fov-error');
const cancelFovButton = document.getElementById('cancel-fov');
const trueWindowButton = document.getElementById('true-window-toggle');
const setbackButton = document.getElementById('setback-cycle');
const windowFramingOutput = document.getElementById('window-framing-output');
const panelLongSideInput = document.getElementById('panel-long-side-mm');
const calibrateScreenButton = document.getElementById('calibrate-screen');
const screenCalibrationOutput = document.getElementById('screen-calibration-output');
const actualEyeDistanceInput = document.getElementById('actual-eye-distance-mm');
const calibrateEyeDistanceButton = document.getElementById('calibrate-eye-distance');
const eyeDistanceOutput = document.getElementById('eye-distance-output');
const resetViewButton = document.getElementById('reset-view');
const openDetailsButton = document.getElementById('open-details');
const detailsDialog = document.getElementById('details-dialog');
const hideUiButton = document.getElementById('hide-ui');
const sourceFovOutput = document.getElementById('source-fov-output');
const sourceLensOutput = document.getElementById('source-lens-output');
const sourceLensInput = document.getElementById('source-lens-35mm');
const rebuildSourceLensButton = document.getElementById('rebuild-source-lens');
const sourceLensStatus = document.getElementById('source-lens-status');
const runtimeDiagnostics = document.getElementById('runtime-diagnostics');
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
// Levelling can be disabled for a session while investigating device sensor
// behavior. Direction fixes belong in the tested sensor/composition boundary.
// Forces the face model onto one processor so the two can be compared on the
// device. Left unset, the CPU path is tried first; see head-tracker.js.
const delegateOverride = viewerParams.get('delegate');
const levelEnabledByUrl = viewerParams.get('level') !== '0';
const trueWindowByUrl = viewerParams.get('trueWindow') !== '0';
const trackingXyGain = inferFrontCameraXyGain(navigator.userAgent);

// Physical screen size is what turns the virtual screen's world units into real
// millimetres. Without it every head-tracking gain is a guess, and the eye ends
// up at roughly half the distance a phone is actually held at.
let screenMetrics = resolveScreenMetrics({
  screenWidth: window.screen?.width,
  screenHeight: window.screen?.height,
  devicePixelRatio: window.devicePixelRatio,
  measuredMmPerCssPx: loadStoredNumber(window.localStorage, DEVICE_SIZE_STORAGE_KEY),
});
let viewingDistanceMm = loadStoredNumber(window.localStorage, VIEWING_DISTANCE_STORAGE_KEY)
  ?? screenMetrics.defaultViewingDistanceMm
  ?? DEFAULT_VIEWING_DISTANCE_MM;
let headDistanceScale = loadDistanceScale(window.localStorage);

const state = {
  revision: 0,
  sourceScene: null,
  sourceImageSize: null,
  presentedScene: null,
  manifest: null,
  publishedManifest: null,
  interaction: null,
  loading: false,
  renderPending: false,
  eyePose: null,
  orientation: classifyViewport(window.innerWidth, window.innerHeight),
  geometry: null,
  variant: 'full',
  reducedAvailable: null,
  depthSpan: 1,
  disparityBlend: DEFAULT_DISPARITY_BLEND,
  motionCapabilities: null,
  tiltPermission: null,
  // A real object behind glass stays upright while its frame turns. Sharing the
  // screen's up axis makes the whole scene roll with the device instead.
  levelToGravity: levelEnabledByUrl,
  screenRoll: null,
  gravityReading: null,
  gravityReference: null,
  heading: null,
  headingReference: null,
  relativeYaw: 0,
  attitude: null,
  anchorVisibleFront: true,
  refitDepthToView: true,
  baseDepthRange: null,
  visibleFrontCorrection: 0,
  fittedDepthRange: null,
  refitHandle: null,
  trueWindow: trueWindowByUrl,
  windowFramingScale: 1,
  windowFramingAuto: true,
  trueWindowAnchorDistance: null,
  trueWindowFarDistance: null,
  trueWindowReferenceEyeZ: null,
  trueWindowReferencePending: true,
  pushBackMm: 0,
  sourceFovDeg: null,
  // Filename-free, session-only source copy. The backend remains stateless;
  // this is released on source replacement, published-scene install/pagehide.
  localSourceBlob: null,
  sourceLensOrigin: null,
  building: false,
  buildPhase: null,
  buildStartedAt: 0,
  buildTimer: null,
  pollTimer: null,
  desktopUpdateAvailable: false,
  buildMetrics: null,
};
const renderRate = createRateMeter({ windowMs: 1200 });
// Draws only when an input has moved far enough to change a pixel. The eye pose
// arrives twenty times a second, so a sixty-times-a-second animation loop spent
// two frames in three redrawing an identical image.
const renderGate = createRenderGate();
let sceneGeneration = 0;
let projectionInteractionProgrammatic = false;
const sourceRequestGate = createLatestRequestGate();
document.body.dataset.orientation = state.orientation;
document.body.dataset.projection = state.trueWindow ? 'true-window' : 'photo';

const chrome = createMobileChromeMachine({
  onChange({ hidden }) {
    document.body.dataset.chrome = hidden ? 'hidden' : 'visible';
    hideUiButton.setAttribute('aria-pressed', String(hidden));
    if (hidden && detailsDialog.open) detailsDialog.close();
  },
});

const interactiveSelector = 'button, input, summary, a, [role="button"], dialog';
const chromePointer = (event) => ({
  pointerId: event.pointerId,
  x: event.clientX,
  y: event.clientY,
  time: event.timeStamp,
  interactive: Boolean(event.target?.closest?.(interactiveSelector)),
});
viewerStage.addEventListener('pointerdown', (event) => {
  chrome.pointerDown(chromePointer(event));
}, true);
viewerStage.addEventListener('pointermove', (event) => {
  chrome.pointerMove(chromePointer(event));
}, true);
viewerStage.addEventListener('pointerup', (event) => {
  chrome.pointerUp(chromePointer(event));
}, true);
viewerStage.addEventListener('pointercancel', (event) => {
  chrome.pointerCancel(chromePointer(event));
}, true);

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

function revealChromeForBlockingState() {
  chrome.revealForBlockingState();
}

function updateBuildElapsed() {
  if (!state.building) return;
  const seconds = Math.max(0, Math.floor((performance.now() - state.buildStartedAt) / 1000));
  buildElapsed.textContent = `${seconds} s`;
}

function setBuildPhase(phase) {
  state.buildPhase = phase;
  buildPhase.textContent = phase;
  buildOverlay.hidden = false;
  setStatus(phase);
  updateBuildElapsed();
}

function beginBuildStatus() {
  revealChromeForBlockingState();
  state.building = true;
  state.buildStartedAt = performance.now();
  window.clearInterval(state.buildTimer);
  state.buildTimer = window.setInterval(updateBuildElapsed, 1000);
  document.body.dataset.building = 'true';
  pasteImageButton.disabled = true;
  chooseImageButton.disabled = true;
  rebuildSourceLensButton.disabled = true;
  setBuildPhase('Reading image');
}

function finishBuildStatus() {
  state.building = false;
  window.clearInterval(state.buildTimer);
  state.buildTimer = null;
  state.buildPhase = null;
  document.body.dataset.building = 'false';
  buildOverlay.hidden = true;
  pasteImageButton.disabled = false;
  chooseImageButton.disabled = false;
  updateProjectionControls();
}

let pendingFovPrompt = null;

function hideFovDialog() {
  if (typeof fovDialog.close === 'function' && fovDialog.open) fovDialog.close();
  else fovDialog.removeAttribute('open');
}

function settleFovPrompt(value) {
  const pending = pendingFovPrompt;
  if (!pending) return;
  pendingFovPrompt = null;
  hideFovDialog();
  pending.resolve(value);
}

function requestVerticalFov() {
  revealChromeForBlockingState();
  if (pendingFovPrompt) settleFovPrompt(null);
  buildOverlay.hidden = true;
  fovError.textContent = '';
  fovInput.value = '32';
  if (typeof fovDialog.showModal === 'function') fovDialog.showModal();
  else fovDialog.setAttribute('open', '');
  return new Promise((resolve) => {
    pendingFovPrompt = { resolve };
    window.setTimeout(() => fovInput.focus(), 0);
  });
}

fovForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = Number(fovInput.value);
  if (!Number.isFinite(value) || value < 15 || value > 120) {
    fovError.textContent = 'Enter a vertical FOV from 15 to 120 degrees.';
    return;
  }
  settleFovPrompt(value);
});

cancelFovButton.addEventListener('click', () => settleFovPrompt(null));
fovDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  settleFovPrompt(null);
});

let rgbdeWorker = null;
const rgbdeWorkerJobs = new Map();

function rejectWorkerJobs(error) {
  for (const entry of rgbdeWorkerJobs.values()) entry.reject(error);
  rgbdeWorkerJobs.clear();
}

function getRgbdeWorker() {
  if (rgbdeWorker) return rgbdeWorker;
  rgbdeWorker = new Worker(new URL('./mobile-rgbde-worker.js', import.meta.url), {
    type: 'module',
  });
  rgbdeWorker.addEventListener('message', (event) => {
    const entry = rgbdeWorkerJobs.get(event.data?.id);
    if (!entry) return;
    if (event.data.kind === 'phase') {
      entry.onPhase(event.data.phase);
      return;
    }
    rgbdeWorkerJobs.delete(event.data.id);
    if (event.data.kind === 'error') {
      entry.reject(new Error(event.data.error || 'RGBDE worker failed.'));
      return;
    }
    entry.resolve(event.data);
  });
  rgbdeWorker.addEventListener('error', (event) => {
    rejectWorkerJobs(event.error || new Error('RGBDE worker failed to load.'));
    rgbdeWorker?.terminate();
    rgbdeWorker = null;
  });
  return rgbdeWorker;
}

function runRgbdeWorker(message, transfer = [], onPhase = () => {}) {
  return new Promise((resolve, reject) => {
    rgbdeWorkerJobs.set(message.id, { resolve, reject, onPhase });
    getRgbdeWorker().postMessage(message, transfer);
  });
}

function installLocalScene(result, { sourceBlob, focalLength35mm = null } = {}) {
  const texturePixels = new Uint8ClampedArray(result.textureBuffer);
  const texture = new ImageData(texturePixels, result.width, result.height);
  const sourceScene = createSourceSceneFromBuiltRgbde(result, {
    texture,
    // Clipboard and file names are intentionally not retained in state or logs.
    sourceName: 'Pasted image',
  });
  state.sourceScene = sourceScene;
  state.trueWindowAnchorDistance = null;
  state.trueWindowFarDistance = null;
  state.sourceImageSize = {
    width: sourceScene.sourceWidth,
    height: sourceScene.sourceHeight,
  };
  state.manifest = {
    sourceName: 'Pasted image',
    captureFovDeg: sourceScene.captureFovDeg,
    screenOccupancy: 0.92,
  };
  state.sourceFovDeg = sourceScene.captureFovDeg;
  state.localSourceBlob = sourceBlob;
  state.sourceLensOrigin = focalLength35mm !== null
    ? 'specified'
    : Number(result.metadata?.inputFocalLengthPx) > 0
      ? 'image metadata'
      : 'Depth Pro estimate';
  resetProjectionInteraction();
  updateProjectionControls();
  state.variant = 'local';
  state.fittedDepthRange = null;
  state.baseDepthRange = null;
  state.desktopUpdateAvailable = false;
  state.buildMetrics = {
    ...result.metrics,
    responseBytes: result.responseBytes,
    inputBytes: result.inputBytes,
    totalMs: performance.now() - state.buildStartedAt,
  };
  document.body.dataset.source = 'local-rgbde';
  document.body.dataset.desktopUpdate = 'false';
  rebuildPresentedGeometry({ upload: false });
  renderer.setScene(state.presentedScene, texture);
  sceneGeneration += 1;
  sceneLabel.textContent = 'Pasted image · local';
  syncTrackingControls();
  document.body.dataset.state = tracker.running ? 'viewing' : 'ready';
  requestRender({ force: true });
}

async function buildSceneFromImage(file, { focalLength35mm = null } = {}) {
  settleFovPrompt(null);
  const request = sourceRequestGate.begin();
  // File.slice returns a Blob without a filename. Keeping only this copy avoids
  // retaining user-identifying path/name information in the active session.
  const sourceBlob = file.slice(0, file.size, file.type);
  beginBuildStatus();
  try {
    const rgbde = await requestRgbdeForImage(file, {
      signal: request.signal,
      onPhase: setBuildPhase,
      focalLength35mm,
    });
    if (!sourceRequestGate.isCurrent(request.generation)) return;
    const responseBytes = rgbde.size;
    setBuildPhase('Decoding depth');
    let result = await runRgbdeWorker({
      kind: 'decode-and-build',
      id: request.generation,
      blob: rgbde,
      maxVertices: MAX_MOBILE_PUBLISH_VERTICES,
    }, [], (phase) => {
      if (sourceRequestGate.isCurrent(request.generation)) setBuildPhase(phase);
    });
    if (!sourceRequestGate.isCurrent(request.generation)) return;
    if (result.kind === 'needs-fov') {
      const fovDeg = await requestVerticalFov();
      if (!sourceRequestGate.isCurrent(request.generation)) return;
      if (fovDeg === null) throw new Error('Vertical FOV confirmation was cancelled.');
      setBuildPhase('Building mesh');
      result = await runRgbdeWorker({
        kind: 'build-decoded',
        id: request.generation,
        width: result.width,
        height: result.height,
        leftPixelsBuffer: result.leftPixelsBuffer,
        depthBuffer: result.depthBuffer,
        depthStats: result.depthStats,
        metadata: result.metadata,
        fovDeg,
        maxVertices: MAX_MOBILE_PUBLISH_VERTICES,
      }, [result.leftPixelsBuffer, result.depthBuffer], (phase) => {
        if (sourceRequestGate.isCurrent(request.generation)) setBuildPhase(phase);
      });
    }
    if (!sourceRequestGate.isCurrent(request.generation)) return;
    if (result.kind !== 'success') throw new Error('RGBDE worker returned an invalid result.');
    result.inputBytes = file.size;
    result.responseBytes = responseBytes;
    installLocalScene(result, { sourceBlob, focalLength35mm });
    setStatus('Scene ready. Start 3D when you are ready to grant camera access.');
  } catch (error) {
    if (error instanceof MobileDepthRequestAborted
        || !sourceRequestGate.isCurrent(request.generation)) return;
    revealChromeForBlockingState();
    console.error('Local image build failed:', error?.message || error);
    document.body.dataset.state = state.presentedScene ? 'ready' : 'error';
    setStatus(`${error?.message || 'Image build failed.'} Choose image remains available.`);
  } finally {
    if (sourceRequestGate.isCurrent(request.generation)) finishBuildStatus();
  }
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
    roll: state.levelToGravity ? (state.attitude?.z ?? 0) : 0,
    yaw: Number(interaction.yaw) || 0,
    pitch: (Number(interaction.pitch) || 0)
      + (state.trueWindow ? (state.attitude?.x ?? 0) : 0),
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
  const metrics = tracker.getMetrics();
  runtimeDiagnostics.textContent = [
    `Build ${MOBILE_VIEWER_BUILD}`,
    `Render ${renderRate.rate().toFixed(1)} fps`,
    `inference ${metrics.inferenceHz.toFixed(1)} Hz / ${metrics.inferenceDurationMs.toFixed(1)} ms`,
    `camera ${metrics.cameraWidth || '—'}×${metrics.cameraHeight || '—'}`,
    `pose ${metrics.poseSource}`,
    `viewport ${state.orientation} ${window.innerWidth}×${window.innerHeight}`,
    state.buildMetrics
      ? `last build ${state.buildMetrics.totalMs.toFixed(0)} ms / ${state.buildMetrics.vertexCount?.toLocaleString?.() ?? '—'} vertices / ${(state.buildMetrics.responseBytes / 1024).toFixed(0)} KiB RGBDE`
      : 'no local build yet',
  ].join(' · ');
  if (!debugTracking) return;
  const pose = state.eyePose;
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
  const effectiveSpan = state.presentedScene?.effectiveSpan ?? state.depthSpan;
  const coneSplay = (currentBaselineEyeZ() + effectiveSpan) / currentBaselineEyeZ();
  const sourcePlacement = currentSourceExactWindowPlacement({
    pushBack: state.pushBackMm
      / (state.geometry?.worldUnitMm || refreshViewingGeometry().worldUnitMm),
  });
  const uniformSpan = state.presentedScene?.sourceDepth ? estimateUniformScaleDepthSpan({
    sourceDepth: state.presentedScene.sourceDepth,
    imageRectHeight: state.presentedScene.imageRect?.height,
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
    `viewing ${viewingDistanceMm.toFixed(0)} mm  eyeZ ${(state.geometry?.baselineEyeZ ?? 0).toFixed(2)}  fov ${(state.geometry?.verticalFovDeg ?? 0).toFixed(1)}°  head ${metrics.headDistanceMm ? `${metrics.headDistanceMm.toFixed(0)}→${metrics.correctedHeadDistanceMm.toFixed(0)} mm` : '—'}`,
    `projection ${state.trueWindow ? 'real-window source exact' : 'photo'}  capture fov ${state.sourceFovDeg?.toFixed(1) ?? '—'}°  anchor ${state.trueWindowAnchorDistance?.toFixed(3) ?? '—'}  framing ${state.windowFramingScale.toFixed(2)}x  setback ${state.pushBackMm} mm`,
    `lens ${sourcePlacement ? `${sourcePlacement.sourceFocalLength35mmEq.toFixed(1)} mm eq  source camera ${sourcePlacement.sourceCaptureApex.toFixed(2)}  reference eye ${currentTrueWindowReferenceEyeZ().toFixed(2)}` : '—'}`,
    `depth span ${state.depthSpan.toFixed(2)} → ${effectiveSpan.toFixed(2)}  cone splay ${coneSplay.toFixed(2)}x  disparity blend ${state.disparityBlend.toFixed(2)}  uniform-scale span ${uniformSpan === null ? '—' : uniformSpan.toFixed(1)}`,
    `visible-front anchor ${state.anchorVisibleFront ? `on  pulled ${state.visibleFrontCorrection.toFixed(3)}` : 'off'}`,
    `sensors ${describeMotionCapabilities()}`,
    `level ${state.levelToGravity ? 'on' : 'off'}  permission ${state.tiltPermission ?? '—'}  roll ${state.screenRoll === null ? '—' : `${((state.screenRoll * 180) / Math.PI).toFixed(1)}°`}  sensor heading Δ ${((state.relativeYaw * 180) / Math.PI).toFixed(1)}° (gravity decoupling and rendered yaw)`,
    `gravity ${describeTiltReading()}`,
    `depth range ${state.presentedScene?.sourceDepth ? `${state.presentedScene.sourceDepth.near.toFixed(2)}–${state.presentedScene.sourceDepth.far.toFixed(2)}${state.presentedScene.depthRangeIsFitted ? ' (refit to view)' : ''}` : 'raw metric'}`,
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

function refreshTrackerGeometry({ preserveEye = true } = {}) {
  const previousGeometry = state.geometry;
  const previousEye = state.eyePose;
  const previousReferenceEyeZ = state.trueWindowReferenceEyeZ;
  const geometry = refreshViewingGeometry();
  if (preserveEye && previousEye && previousGeometry?.worldUnitMm) {
    state.eyePose = preservePhysicalPoint(
      previousEye,
      previousGeometry.worldUnitMm,
      geometry.worldUnitMm,
    );
  }
  if (preserveEye && previousReferenceEyeZ > 0 && previousGeometry?.worldUnitMm) {
    state.trueWindowReferenceEyeZ = preservePhysicalPoint(
      { x: 0, y: 0, z: previousReferenceEyeZ },
      previousGeometry.worldUnitMm,
      geometry.worldUnitMm,
    ).z;
  }
  tracker.setViewingGeometry({
    worldUnitMm: geometry.worldUnitMm,
    baselineEyeZ: geometry.baselineEyeZ,
  });
  return geometry;
}

function currentBaselineEyeZ() {
  return state.geometry?.baselineEyeZ || refreshViewingGeometry().baselineEyeZ;
}

function currentTrueWindowReferenceEyeZ() {
  return state.trueWindowReferenceEyeZ > 0
    ? state.trueWindowReferenceEyeZ
    : currentBaselineEyeZ();
}

function currentSourceAspect() {
  const width = state.sourceImageSize?.width;
  const height = state.sourceImageSize?.height;
  return width > 0 && height > 0 ? width / height : null;
}

function currentSourceExactWindowPlacement({ pushBack = 0 } = {}) {
  const sourceAspect = currentSourceAspect();
  if (!(state.sourceFovDeg > 0)
      || !(sourceAspect > 0)
      || !(state.trueWindowAnchorDistance > 0)) return null;
  return computeSourceExactWindowPlacement({
    captureFovDeg: state.sourceFovDeg,
    sourceAspect,
    anchorDistance: state.trueWindowAnchorDistance,
    referenceEyeZ: currentTrueWindowReferenceEyeZ(),
    pushBack,
  });
}

function currentSourceOverviewFramingScale() {
  const sourceAspect = currentSourceAspect();
  if (!(state.sourceFovDeg > 0) || !(sourceAspect > 0)) return 1;
  const canvasWidth = Math.max(canvas.clientWidth || window.innerWidth, 1);
  const canvasHeight = Math.max(canvas.clientHeight || window.innerHeight, 1);
  return Math.max(MIN_TOUCH_SCALE, computeSourceOverviewFraming({
    captureFovDeg: state.sourceFovDeg,
    sourceAspect,
    screenAspect: canvasWidth / canvasHeight,
    referenceEyeZ: currentTrueWindowReferenceEyeZ(),
    occupancy: state.manifest?.screenOccupancy ?? 0.92,
  }));
}

function updateWindowFramingOutput() {
  const autoFit = state.trueWindow && state.windowFramingAuto ? ' · auto fit' : '';
  windowFramingOutput.textContent = `${state.windowFramingScale.toFixed(2)}×${autoFit}`;
}

function applyWindowFraming(scale, {
  auto = true,
  preserveInteraction = false,
} = {}) {
  state.windowFramingScale = scale;
  state.windowFramingAuto = auto;
  const nextInteraction = preserveInteraction
    ? { ...state.interaction, scale }
    : { scale };
  projectionInteractionProgrammatic = true;
  try {
    touch.reset(nextInteraction);
  } finally {
    projectionInteractionProgrammatic = false;
  }
  updateWindowFramingOutput();
}

function refreshAutoWindowFraming() {
  if (!state.trueWindow || !state.windowFramingAuto) return;
  const scale = currentSourceOverviewFramingScale();
  if (Math.abs(scale - state.windowFramingScale) < 1e-6) return;
  applyWindowFraming(scale, { auto: true, preserveInteraction: true });
}

function captureTrueWindowReferenceEye(pose) {
  const eyeZ = Number(pose?.z);
  if (!(eyeZ > 0) || !Number.isFinite(eyeZ)) return false;
  state.trueWindowReferenceEyeZ = eyeZ;
  state.trueWindowReferencePending = false;
  return true;
}

function useBaselineTrueWindowReference({ awaitTrackedPose = false } = {}) {
  state.trueWindowReferenceEyeZ = currentBaselineEyeZ();
  state.trueWindowReferencePending = awaitTrackedPose;
}

function resetProjectionInteraction() {
  // Start with the source frame visible, like Photo relief. This is a wider
  // projection aperture when the source lens is wider than the physical phone
  // window. The Source-exact metric placement itself remains untouched, and a
  // user can pinch back to the literal glass at 1×.
  const scale = state.trueWindow ? currentSourceOverviewFramingScale() : 1;
  applyWindowFraming(scale, { auto: state.trueWindow });
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
  if (state.trueWindow || !state.refitDepthToView
      || !state.presentedScene || !state.sourceScene) return;
  const aspect = Math.max(canvas.clientWidth / Math.max(canvas.clientHeight, 1), 0.1);
  const screen = computeVirtualScreen(aspect);
  const pivotZ = state.presentedScene.frontZ ?? 0;
  const touchTransform = createReliefInteractionMatrix({
    interaction: state.interaction,
    frontZ: pivotZ,
  });
  const safeModel = constrainReliefBehindScreen({
    bounds: state.presentedScene.bounds,
    modelMatrix: touchTransform,
  });
  const visible = findVisibleDepthRange({
    frontSamples: state.presentedScene.frontSamples,
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
  const current = state.presentedScene.sourceDepth;
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
  rebuildPresentedGeometry();
  requestRender({ force: true });
}

function scheduleDepthRefit() {
  if (state.trueWindow || !state.refitDepthToView) return;
  window.clearTimeout(state.refitHandle);
  state.refitHandle = window.setTimeout(refitDepthToVisibleRange, 250);
}

function sceneAttitudeMatrix({ trueWindow }) {
  return quaternionToMatrix(sceneRotationForDevicePose(state.attitude, {
    trueWindow,
    holdLevel: state.levelToGravity,
  }));
}

// Turning the phone is not a stabiliser and is not owned by Hold level: it is
// what makes the glass a window. The scene receives the inverse of the turn so
// the world behind it stays where it is in the room, in both projection modes
// and in both Hold states, matching where the eye is taken from.
function deviceYawMatrix() {
  return Math.abs(state.relativeYaw) < 1e-9
    ? null
    : quaternionToMatrix(sceneYawForDevice(state.relativeYaw));
}

function computeHeadCoupledMatrices(scene, interaction, eyePose) {
  const aspect = Math.max(canvas.clientWidth / Math.max(canvas.clientHeight, 1), 0.1);
  const physicalScreen = computeVirtualScreen(aspect);
  const screen = state.trueWindow
    ? frameVirtualScreen(physicalScreen, state.windowFramingScale)
    : physicalScreen;
  const rawEye = eyePose || {
    x: 0,
    y: 0,
    z: currentBaselineEyeZ(),
  };
  const placement = state.trueWindow ? currentSourceExactWindowPlacement({
    pushBack: state.pushBackMm
      / (state.geometry?.worldUnitMm || refreshViewingGeometry().worldUnitMm),
  }) : null;
  if (state.trueWindow && !placement) {
    throw new Error('Real Window requires capture FOV, image aspect, and metric depth.');
  }
  const trueWindowDepth = placement && state.trueWindowFarDistance > state.trueWindowAnchorDistance
    ? placement.pushBack
      + (state.trueWindowFarDistance - state.trueWindowAnchorDistance) * placement.scale
    : null;
  const sourceAspect = currentSourceAspect();
  const trueWindowLateralResponse = trueWindowLateralEyeResponse({
    captureFovDeg: state.sourceFovDeg,
    referenceEyeZ: currentTrueWindowReferenceEyeZ(),
    orientation: state.orientation,
  });
  const trueWindowDepthResponse = state.trueWindow && trueWindowDepth > 0 && sourceAspect > 0
    ? trueWindowEyeResponseForRelief({
      captureFovDeg: state.sourceFovDeg,
      referenceEyeZ: currentTrueWindowReferenceEyeZ(),
      trueWindowDepth,
      trueWindowFramingScale: state.windowFramingScale,
      sourceAspect,
      screenWidth: physicalScreen.width,
      screenHeight: physicalScreen.height,
      reliefDepthSpan: state.depthSpan,
      occupancy: state.manifest?.screenOccupancy ?? 0.92,
    })
    : trueWindowLateralResponse;
  const mappedEye = state.trueWindow
    ? mapTrackedEyeAroundReference({
      eye: rawEye,
      referenceZ: currentTrueWindowReferenceEyeZ(),
      response: trueWindowDepthResponse,
      lateralResponse: trueWindowLateralResponse,
    })
    : mapTrackedEyeToCaptureApex({
      eye: rawEye,
      nominalZ: currentBaselineEyeZ(),
      captureApex: scene.captureApex || currentBaselineEyeZ(),
    });
  const eye = referencedEyeForDevicePose(mappedEye, {
    relativeYaw: state.relativeYaw,
  });
  if (state.trueWindow) {
    let modelMatrix = mat4.translate(mat4.identity(), [0, 0, placement.translation[2]]);
    modelMatrix = mat4.scale(modelMatrix, placement.scale);
    const deviceAttitude = sceneAttitudeMatrix({ trueWindow: true });
    if (deviceAttitude) modelMatrix = mat4.multiply(deviceAttitude, modelMatrix);
    const deviceYaw = deviceYawMatrix();
    if (deviceYaw) modelMatrix = mat4.multiply(deviceYaw, modelMatrix);
    const touchMatrix = createTrueWindowInteractionMatrix({ interaction });
    modelMatrix = mat4.multiply(touchMatrix, modelMatrix);
    // Do not rigidly push a tipped True Window scene back behind the glass.
    // Such a correction moves its capture apex and changes every frame as the
    // rotated bounds change, which makes a rotation look like a strange orbit.
    // The shallow source tail was already flattened to the glass anchor when
    // this presentation was built; subsequent attitude remains a pure turn.
    const transformedBounds = transformBounds(scene.bounds, modelMatrix);
    const near = Math.max(0.05, (eye.z - transformedBounds.max[2]) * 0.5);
    const far = Math.max(near * 4, eye.z - transformedBounds.min[2] + 2);
    const { projectionMatrix } = computeOffAxisProjection({
      eye,
      screenHalfWidth: screen.halfWidth,
      screenHalfHeight: screen.halfHeight,
      near,
      far,
    });
    return {
      modelMatrix,
      viewMatrix: computeEyeViewMatrix(eye),
      projectionMatrix,
    };
  }
  const pivotZ = scene.frontZ ?? 0;
  let touchTransform = createReliefInteractionMatrix({ interaction, frontZ: pivotZ });
  const deviceAttitude = sceneAttitudeMatrix({ trueWindow: false });
  const photoYaw = deviceYawMatrix();
  // The turn acts after the gravity attitude and shares its glass pivot, so a
  // phone that is both tipped and turned resolves to one rotation of the
  // picture about the plane that must stay put.
  const devicePose = deviceAttitude && photoYaw
    ? mat4.multiply(photoYaw, deviceAttitude)
    : (photoYaw || deviceAttitude);
  if (devicePose) {
    // Rotated about the glass so the correction pivots where the picture meets
    // the screen, which is the one plane that must stay put.
    //
    // The sign follows from the measurement: gravity swinging toward the
    // screen's right edge means the device was turned clockwise as the viewer
    // sees it, and the scene must turn the other way, which is a positive
    // rotation about +z in screen coordinates. Confirmed on hardware.
    let level = mat4.translate(mat4.identity(), [0, 0, pivotZ]);
    level = mat4.multiply(level, devicePose);
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

function rebuildPresentedGeometry({ upload = true } = {}) {
  if (!state.sourceScene || !state.sourceImageSize) return;
  if (state.trueWindow) {
    const vertexCount = state.sourceScene.positions.length / 3;
    const depthStride = Math.max(1, Math.floor(vertexCount / 100_000));
    state.trueWindowAnchorDistance = estimateCameraAxisDepthQuantile(
      state.sourceScene.positions,
      { stride: depthStride },
    );
    state.trueWindowFarDistance = estimateCameraAxisDepthQuantile(
      state.sourceScene.positions,
      { quantile: 0.98, stride: depthStride },
    );
    if (!(state.trueWindowAnchorDistance > 0)) {
      throw new Error('True Window could not find a valid camera-axis depth.');
    }
    if (!(state.sourceFovDeg > 0)) {
      throw new Error('True Window requires a vertical capture FOV.');
    }
    const clamped = clampCameraRayDepthFloor(
      state.sourceScene.positions,
      state.trueWindowAnchorDistance,
    );
    state.presentedScene = clamped.clampedCount > 0
      ? {
        ...state.sourceScene,
        positions: clamped.positions,
        bounds: clamped.bounds,
      }
      : state.sourceScene;
    state.baseDepthRange = null;
    state.fittedDepthRange = null;
    if (upload) renderer.updateGeometry(state.presentedScene);
    updateProjectionControls();
    sceneGeneration += 1;
    return;
  }
  const aspect = Math.max(canvas.clientWidth / Math.max(canvas.clientHeight, 1), 0.1);
  const screen = computeVirtualScreen(aspect);
  const { width: sourceWidth, height: sourceHeight } = state.sourceImageSize;
  state.presentedScene = createMobileReliefScene({
    scene: state.sourceScene,
    sourceAspect: sourceWidth / Math.max(sourceHeight, 1),
    screenWidth: screen.width,
    screenHeight: screen.height,
    baselineEyeZ: refreshViewingGeometry().baselineEyeZ,
    captureFovDeg: state.sourceFovDeg,
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
  if (!state.presentedScene.depthRangeIsFitted) {
    state.baseDepthRange = { ...state.presentedScene.sourceDepth };
  }
  if (upload) renderer.updateGeometry(state.presentedScene);
  sceneGeneration += 1;
}

function render() {
  renderer.resize(window.innerWidth, window.innerHeight);
  if (!state.presentedScene) {
    renderer.clear();
    return;
  }
  renderer.render(computeHeadCoupledMatrices(
    state.presentedScene,
    state.interaction,
    state.eyePose,
  ));
}

async function loadPublishedScene({ force = false, variant = state.variant } = {}) {
  if (state.loading) return;
  state.loading = true;
  const wasViewing = tracker.running || document.body.dataset.state === 'viewing';
  try {
    const { envelope, modelResponse, unchanged, servedVariant } = await fetchPublishedScenePair({
      knownRevision: state.revision,
      knownPublishedAt: state.publishedManifest?.publishedAt,
      force,
      variant,
    });
    if (!envelope.available) {
      state.revision = 0;
      state.publishedManifest = null;
      state.reducedAvailable = false;
      if (state.sourceScene?.origin === 'local-rgbde') {
        state.desktopUpdateAvailable = false;
        document.body.dataset.desktopUpdate = 'false';
        setStatus('No published desktop scene is available; the pasted image remains active.');
        return;
      }
      state.sourceScene = null;
      state.sourceImageSize = null;
      state.trueWindowAnchorDistance = null;
      state.trueWindowFarDistance = null;
      state.presentedScene = null;
      state.sourceFovDeg = null;
      state.localSourceBlob = null;
      state.sourceLensOrigin = null;
      updateProjectionControls();
      state.revision = 0;
      // The reason it cannot be pressed belongs on the button. The status line
      // below says the same thing, but a disabled primary action reads as a
      // fault in the page rather than as a step not yet taken.
      state.variant = 'full';
      state.reducedAvailable = false;
      tracker.stop({ emit: false });
      tilt.stop();
      clearSensorAttitude();
      state.tiltPermission = null;
      renderRate.reset();
      syncTrackingControls();
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
    const parsedGlb = parseGlb(modelBuffer);
    setStatus(`Decoding ${envelope.filename} texture…`);
    const image = await decodeTexture(parsedGlb.imageBlob);
    let captureFovDeg = Number(envelope.manifest?.captureFovDeg);
    if (!(captureFovDeg > 0 && captureFovDeg < 180)) {
      captureFovDeg = await requestVerticalFov();
      if (captureFovDeg === null) {
        image.close?.();
        throw new Error('Vertical FOV confirmation was cancelled.');
      }
    }
    const sourceManifest = { ...envelope.manifest, captureFovDeg };
    state.sourceScene = createSourceSceneFromGlb(parsedGlb, sourceManifest, image);
    state.trueWindowAnchorDistance = null;
    state.trueWindowFarDistance = null;
    // The bitmap is released as soon as it reaches the GPU, so its dimensions
    // are kept separately for the relief rebuilds that follow every resize.
    state.sourceImageSize = {
      width: state.sourceScene.sourceWidth,
      height: state.sourceScene.sourceHeight,
    };
    state.variant = servedVariant || variant;
    state.fittedDepthRange = null;
    state.baseDepthRange = null;
    state.reducedAvailable = Boolean(envelope.hasReduced);
    state.manifest = sourceManifest;
    state.publishedManifest = envelope.manifest;
    state.sourceFovDeg = captureFovDeg;
    state.localSourceBlob = null;
    state.sourceLensOrigin = 'published scene';
    resetProjectionInteraction();
    updateProjectionControls();
    state.depthSpan = Number.isFinite(envelope.manifest?.depthSpan)
      ? envelope.manifest.depthSpan
      : 1;
    state.disparityBlend = Number.isFinite(envelope.manifest?.disparityBlend)
      ? envelope.manifest.disparityBlend
      : DEFAULT_DISPARITY_BLEND;
    syncDebugControls();
    rebuildPresentedGeometry({ upload: false });
    renderer.setScene(state.presentedScene, image);
    sceneGeneration += 1;
    state.revision = envelope.revision;
    state.desktopUpdateAvailable = false;
    document.body.dataset.source = 'published-glb';
    document.body.dataset.desktopUpdate = 'false';
    syncTrackingControls();
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
    revealChromeForBlockingState();
    document.body.dataset.state = 'error';
    setStatus(error.message || 'Published scene could not be loaded.');
  } finally {
    state.loading = false;
  }
}

let flipGestureGuard = false;
let levellingGestureGuard = false;

function updateAttitudeFromSensors() {
  // Reference-relative device pitch is also a True Window orientation cue;
  // Hold level only decides whether partial model roll/horizon holding joins
  // it. The tracked eye stays in camera coordinates in both states. Discarding
  // attitude here when Hold was off froze glass elevation.
  if (!state.gravityReading) {
    state.attitude = null;
    return;
  }
  const up = upInDeviceFrame(state.gravityReading);
  if (!up) return;
  if (!state.gravityReference) {
    state.gravityReference = up;
    state.attitude = null;
    return;
  }
  const levelling = computeYawDecoupledLevelling(state.gravityReading, {
    reference: state.gravityReference,
    // Heading may only subtract the screen-up component from gravity roll/tip;
    // it is still forbidden from rotating the model or eye as yaw. True Window
    // retains pitch with Hold off, so it also needs this separation then.
    // Photo + Hold off renders no attitude and stays camera-only.
    screenYaw: screenYawForGravityAttitude(state.relativeYaw, {
      trueWindow: state.trueWindow,
      holdLevel: state.levelToGravity,
    }),
    rollGain: DEFAULT_LEVELLING_GAIN,
    tipGain: state.trueWindow ? TRUE_WINDOW_PITCH_GAIN : DEFAULT_LEVELLING_GAIN,
    tipMaxAngle: state.trueWindow ? TRUE_WINDOW_PITCH_MAX_RAD : undefined,
  });
  state.attitude = levelling ? toQuaternion(levelling) : null;
}

function captureGravityReference() {
  state.gravityReading = tilt.getSmoothedReading?.();
  state.gravityReference = upInDeviceFrame(state.gravityReading);
  state.attitude = null;
}

function captureHeadingReference() {
  state.heading = tilt.getHeading?.();
  state.headingReference = Number.isFinite(state.heading) ? state.heading : null;
  state.relativeYaw = 0;
}

function captureSensorReferences() {
  captureGravityReference();
  captureHeadingReference();
}

function clearGravityAttitude() {
  state.screenRoll = null;
  state.gravityReading = null;
  state.gravityReference = null;
  state.attitude = null;
}

function clearHeadingReference() {
  state.heading = null;
  state.headingReference = null;
  state.relativeYaw = 0;
}

function clearSensorAttitude() {
  clearGravityAttitude();
  clearHeadingReference();
}

const tilt = createTiltTracker({
  onRoll(roll, reading) {
    state.screenRoll = roll;
    state.gravityReading = reading;
    updateAttitudeFromSensors();
    requestRender();
  },
  onHeading(heading) {
    state.heading = heading;
    if (!Number.isFinite(state.headingReference)) {
      state.headingReference = heading;
      state.relativeYaw = 0;
    } else {
      state.relativeYaw = wrapAngle(heading - state.headingReference);
    }
    updateAttitudeFromSensors();
    requestRender();
  },
});

const touch = createTouchInteraction(canvas, {
  onChange(interaction) {
    state.interaction = interaction;
    if (state.trueWindow) {
      const scaleChanged = Math.abs(interaction.scale - state.windowFramingScale) > 1e-6;
      state.windowFramingScale = interaction.scale;
      if (!projectionInteractionProgrammatic && scaleChanged) {
        state.windowFramingAuto = false;
      }
      updateWindowFramingOutput();
    }
    // When the view returns to the whole image the relief goes back to the full
    // scene, so zooming out always undoes a refit.
    if (interaction.scale <= 1.01 && state.fittedDepthRange) {
      state.fittedDepthRange = null;
      rebuildPresentedGeometry();
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
  distanceScale: headDistanceScale,
  mirrorX: trackingMirrorX,
  xyGain: trackingXyGain,
  delegate: delegateOverride,
  onStatus({ code, message }) {
    document.body.dataset.tracking = code;
    setStatus(message);
  },
  onPose(pose) {
    state.eyePose = pose;
    if (state.trueWindowReferencePending || !(state.trueWindowReferenceEyeZ > 0)) {
      captureTrueWindowReferenceEye(pose);
      refreshAutoWindowFraming();
      updateProjectionControls();
    }
    updateEyeDistanceOutput();
    requestRender();
  },
});

const SETBACK_STEPS_MM = Object.freeze([0, 25, 50, 100, 200]);

function updateProjectionControls() {
  document.body.dataset.projection = state.trueWindow ? 'true-window' : 'photo';
  trueWindowButton.setAttribute('aria-pressed', String(state.trueWindow));
  trueWindowButton.textContent = `True Window ${state.trueWindow ? 'on' : 'off'}`;
  setbackButton.textContent = `Setback ${state.pushBackMm} mm`;
  setbackButton.disabled = !state.trueWindow;
  updateWindowFramingOutput();
  sourceFovOutput.textContent = state.sourceFovDeg > 0
    ? `${state.sourceFovDeg.toFixed(1)}°`
    : '—';
  const placement = currentSourceExactWindowPlacement();
  sourceLensOutput.textContent = placement
    ? `${placement.sourceFocalLength35mmEq.toFixed(1)} mm eq · Source exact`
    : '—';
  if (placement && document.activeElement !== sourceLensInput) {
    sourceLensInput.value = placement.sourceFocalLength35mmEq.toFixed(1);
  }
  const canRebuild = Boolean(
    state.localSourceBlob
    && state.sourceScene?.origin === 'local-rgbde'
    && !state.building,
  );
  rebuildSourceLensButton.disabled = !canRebuild;
  if (canRebuild) {
    const origin = state.sourceLensOrigin || 'current scene';
    sourceLensStatus.textContent = `Current value: ${origin}. Edit, then rebuild explicitly.`;
  } else if (state.sourceScene) {
    sourceLensStatus.textContent = state.building
      ? 'Depth rebuild in progress; the current scene stays visible.'
      : 'Published scenes have no source photo here. Paste it again to rebuild depth.';
  } else {
    sourceLensStatus.textContent = 'Paste or choose an image to rebuild its depth.';
  }
}

function syncTrackingControls() {
  const active = tracker.running;
  startButton.hidden = active;
  recenterButton.hidden = !active;
  startButton.disabled = active || !state.presentedScene;
  recenterButton.disabled = !active;
  stopButton.disabled = !active;
  if (!active) {
    startButton.textContent = state.presentedScene ? 'Start 3D' : 'Publish or paste';
  }
}

function updateScreenCalibrationOutput() {
  const geometry = state.geometry || refreshViewingGeometry();
  screenCalibrationOutput.textContent = `${screenMetrics.label} · ${geometry.screenHeightMm.toFixed(1)} mm canvas · ${geometry.worldUnitMm.toFixed(1)} mm/unit`;
}

function updateEyeDistanceOutput() {
  const metrics = tracker.getMetrics();
  const reported = metrics.headDistanceMm > 0 ? `${metrics.headDistanceMm.toFixed(0)} mm` : '—';
  const corrected = metrics.correctedHeadDistanceMm > 0
    ? `${metrics.correctedHeadDistanceMm.toFixed(0)} mm`
    : '—';
  eyeDistanceOutput.textContent = `Reported ${reported} · corrected ${corrected} · scale ${headDistanceScale.toFixed(3)}×`;
}

trueWindowButton.addEventListener('click', () => {
  state.trueWindow = !state.trueWindow;
  if (state.trueWindow) {
    if (!captureTrueWindowReferenceEye(state.eyePose)) {
      useBaselineTrueWindowReference({ awaitTrackedPose: tracker.running });
    }
  }
  state.fittedDepthRange = null;
  state.visibleFrontCorrection = 0;
  updateAttitudeFromSensors();
  resetProjectionInteraction();
  updateProjectionControls();
  if (state.sourceScene) rebuildPresentedGeometry();
  setStatus(state.trueWindow
    ? 'True Window on · source camera matched; the complete source is auto-fitted.'
    : 'True Window off · photo-aligned relief.');
  requestRender({ force: true });
});

resetViewButton.addEventListener('click', () => {
  state.pushBackMm = 0;
  state.fittedDepthRange = null;
  state.visibleFrontCorrection = 0;
  resetProjectionInteraction();
  updateProjectionControls();
  if (state.sourceScene) rebuildPresentedGeometry();
  setStatus(state.trueWindow
    ? 'Presentation reset · complete source auto-fitted; 1.00× remains the literal glass.'
    : 'Presentation reset. Physical and tracking calibrations were retained.');
  requestRender({ force: true });
});

openDetailsButton.addEventListener('click', () => {
  if (typeof detailsDialog.showModal === 'function') detailsDialog.showModal();
  else detailsDialog.setAttribute('open', '');
});

sourceLensInput.min = String(MIN_FOCAL_LENGTH_35MM);
sourceLensInput.max = String(MAX_FOCAL_LENGTH_35MM);
rebuildSourceLensButton.addEventListener('click', () => {
  try {
    const focalLength35mm = validateFocalLength35mm(sourceLensInput.value);
    if (focalLength35mm === null) {
      throw new Error('Enter a lens value before rebuilding depth.');
    }
    if (!state.localSourceBlob || state.sourceScene?.origin !== 'local-rgbde') {
      throw new Error('Paste or choose the source image again before rebuilding depth.');
    }
    if (detailsDialog.open && typeof detailsDialog.close === 'function') detailsDialog.close();
    setStatus(`Rebuilding depth at ${focalLength35mm.toFixed(1)} mm equivalent…`);
    void buildSceneFromImage(state.localSourceBlob, { focalLength35mm });
  } catch (error) {
    sourceLensStatus.textContent = error.message || 'Lens value could not be applied.';
    setStatus(sourceLensStatus.textContent);
  }
});

hideUiButton.addEventListener('click', () => chrome.explicitToggle());

setbackButton.addEventListener('click', () => {
  const currentIndex = SETBACK_STEPS_MM.indexOf(state.pushBackMm);
  state.pushBackMm = SETBACK_STEPS_MM[(currentIndex + 1) % SETBACK_STEPS_MM.length];
  updateProjectionControls();
  setStatus(`True Window setback ${state.pushBackMm} mm.`);
  requestRender({ force: true });
});

calibrateScreenButton.addEventListener('click', () => {
  try {
    const panelLongSideMm = Number(panelLongSideInput.value);
    if (!(panelLongSideMm >= 50 && panelLongSideMm <= 500)) {
      throw new Error('Enter an illuminated panel length from 50 to 500 mm.');
    }
    const mmPerCssPx = mmPerCssPxFromPanelLongSide({
      panelLongSideMm,
      screenWidth: window.screen?.width,
      screenHeight: window.screen?.height,
    });
    saveStoredNumber(window.localStorage, DEVICE_SIZE_STORAGE_KEY, mmPerCssPx);
    screenMetrics = resolveScreenMetrics({
      screenWidth: window.screen?.width,
      screenHeight: window.screen?.height,
      devicePixelRatio: window.devicePixelRatio,
      measuredMmPerCssPx: mmPerCssPx,
    });
    refreshTrackerGeometry({ preserveEye: true });
    refreshAutoWindowFraming();
    updateScreenCalibrationOutput();
    rebuildPresentedGeometry();
    setStatus('Physical screen size saved; the current eye position was preserved in millimetres.');
    requestRender({ force: true });
  } catch (error) {
    setStatus(error.message || 'Screen calibration could not be applied.');
  }
});

calibrateEyeDistanceButton.addEventListener('click', () => {
  const actualMm = Number(actualEyeDistanceInput.value);
  const metrics = tracker.getMetrics();
  if (!(actualMm >= 100 && actualMm <= 1500)) {
    setStatus('Enter an actual eye-to-glass distance from 100 to 1500 mm.');
    return;
  }
  if (!(metrics.headDistanceMm > 0)) {
    setStatus('Start 3D and wait for a stable metric distance before calibrating.');
    return;
  }
  headDistanceScale = distanceScaleFrom(metrics.headDistanceMm, actualMm);
  saveDistanceScale(window.localStorage, headDistanceScale);
  tracker.setDistanceScale(headDistanceScale);
  state.eyePose = null;
  useBaselineTrueWindowReference({ awaitTrackedPose: true });
  refreshAutoWindowFraming();
  updateEyeDistanceOutput();
  setStatus(`Eye distance calibrated to ${actualMm.toFixed(0)} mm · hold center while tracking recenters.`);
  requestRender({ force: true });
});

updateProjectionControls();
updateScreenCalibrationOutput();
updateEyeDistanceOutput();
syncTrackingControls();

function updateLevellingButton() {
  enableLevellingButton.hidden = false;
  enableLevellingButton.setAttribute('aria-pressed', String(state.levelToGravity));
  enableLevellingButton.textContent = `Hold level ${state.levelToGravity ? 'on' : 'off'}`;
  debugLevelInput.checked = state.levelToGravity;
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
  if (state.levelToGravity) {
    state.levelToGravity = false;
    // True Window pitch is posture conversion, not horizon holding. Sensor
    // heading remains diagnostic only; lateral looking comes from camera eye
    // tracking, so Hold affects only the partial model roll here.
    updateLevellingButton();
    setStatus('Hold level off · horizon hold disabled; True Window pitch and camera-eye parallax remain active.');
    requestRender({ force: true });
    return;
  }
  state.levelToGravity = true;
  state.tiltPermission = null;
  updateLevellingButton();
  const request = tilt.start();
  setStatus('Requesting motion access…');
  void request.then((permission) => {
    state.tiltPermission = permission;
    if (permission !== 'granted') {
      state.levelToGravity = false;
      clearGravityAttitude();
    }
    setStatus(permission === 'granted'
      ? 'Hold level ready · horizon holding enabled.'
      : 'Motion access was refused; Hold level remains off.');
    updateLevellingButton();
    requestRender({ force: true });
  });
});
updateLevellingButton();

function updateTrackingDirectionButton() {
  const reversed = trackingMirrorX;
  flipTrackingXButton.setAttribute('aria-pressed', String(reversed));
  // This button sits over the canvas, so a stray finger during a pinch can
  // toggle it, and the wrong setting then persists across sessions. Say so
  // loudly rather than leaving it to be discovered by the view feeling wrong.
  flipTrackingXButton.textContent = `Reverse tracking ${reversed ? 'on' : 'off'}`;
  flipTrackingXButton.title = trackingMirrorX
    ? 'Correct the unmirrored front-camera horizontal axis'
    : 'Use the uncorrected front-camera horizontal axis';
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
  useBaselineTrueWindowReference({ awaitTrackedPose: tracker.running });
  updateTrackingDirectionButton();
  setStatus('Left/right tracking direction changed · hold center while recalibrating.');
  requestRender({ force: true });
});
updateTrackingDirectionButton();

function recenterTracking() {
  state.eyePose = null;
  useBaselineTrueWindowReference({ awaitTrackedPose: true });
  tracker.recenter();
  if (tilt.running) {
    tilt.recenter();
    clearSensorAttitude();
  } else {
    captureSensorReferences();
  }
  requestRender({ force: true });
}

startButton.addEventListener('click', async () => {
  if (!state.presentedScene || tracker.running) return;
  startButton.disabled = true;
  useBaselineTrueWindowReference({ awaitTrackedPose: true });
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
    // Relative yaw is required in every projection mode and with Hold level
    // either on or off, so orientation sensing starts with the camera gesture.
    const tiltStarted = tilt.start();
    // Recorded independently of the camera, so its answer is never lost when
    // the camera fails and its promise is always consumed.
    void tiltStarted.then((permission) => {
      state.tiltPermission = permission;
      if (permission !== 'granted') {
        state.levelToGravity = false;
        clearGravityAttitude();
      }
      updateLevellingButton();
      requestRender({ force: true });
    });
    await trackingStarted;
    document.body.dataset.state = 'viewing';
    syncTrackingControls();
    renderRate.reset();
    requestRender({ force: true });
  } catch (error) {
    console.error(error);
    revealChromeForBlockingState();
    document.body.dataset.state = 'tracking-error';
    document.body.dataset.tracking = 'unavailable';
    syncTrackingControls();
    startButton.textContent = 'Retry camera';
    renderRate.reset();
    setStatus(`Camera tracking unavailable: ${error.message} Static touch view remains active.`);
  }
});

recenterButton.addEventListener('click', recenterTracking);

stopButton.addEventListener('click', () => {
  tracker.stop();
  tilt.stop();
  clearSensorAttitude();
  state.tiltPermission = null;
  renderRate.reset();
  state.eyePose = null;
  useBaselineTrueWindowReference();
  refreshAutoWindowFraming();
  syncTrackingControls();
  requestRender();
});

reloadButton.addEventListener('click', () => {
  sourceRequestGate.cancel();
  settleFovPrompt(null);
  finishBuildStatus();
  void loadPublishedScene({ force: true });
});

pasteImageButton.addEventListener('click', () => {
  setStatus('Reading clipboard');
  void readImageFromClipboard().then((result) => {
    if (result.ok) return buildSceneFromImage(result.file);
    const message = result.reason === 'unsupported'
      ? 'Direct clipboard reading is unavailable. Use Choose image or a keyboard paste.'
      : result.reason === 'denied'
        ? 'Clipboard access was not granted. Use Choose image or a keyboard paste.'
        : 'The clipboard does not contain an image. Use Choose image to continue.';
    setStatus(message);
    chooseImageButton.focus();
    return null;
  });
});

chooseImageButton.addEventListener('click', () => {
  if (detailsDialog.open && typeof detailsDialog.close === 'function') detailsDialog.close();
  imageFileInput.click();
});

imageFileInput.addEventListener('change', () => {
  const [file] = Array.from(imageFileInput.files || []);
  imageFileInput.value = '';
  if (file) void buildSceneFromImage(file);
});

window.addEventListener('paste', (event) => {
  const file = imageFromPasteEvent(event);
  if (!file) return;
  event.preventDefault();
  void buildSceneFromImage(file);
});

function handleViewportChange() {
  touch.cancelGesture();
  chrome.cancelGesture();
  const nextOrientation = classifyViewport(window.innerWidth, window.innerHeight);
  const orientationChanged = nextOrientation !== state.orientation;
  if (orientationChanged) {
    state.orientation = nextOrientation;
    document.body.dataset.orientation = nextOrientation;
    // Gravity and DeviceOrientation are reported in device/screen coordinates.
    // Keeping their old filtered samples and Hold-level references across a
    // quarter turn leaves the correction saturated until the user toggles Hold
    // level. Re-arm only the sensor samples/reference; permissions, listeners,
    // the user's enabled state, camera tracking, and touch framing all survive.
    if (tilt.running) {
      // Do not capture a reference while the hand is still completing the
      // quarter turn. Events remain subscribed but are ignored briefly; the
      // first post-settle samples establish the new screen-coordinate frame.
      tilt.recenter({ settleMs: DEFAULT_ORIENTATION_SETTLE_MS });
      clearSensorAttitude();
      setStatus(`Device pose adapting to ${nextOrientation}…`);
    }
  }
  refreshTrackerGeometry({ preserveEye: true });
  refreshAutoWindowFraming();
  updateScreenCalibrationOutput();
  rebuildPresentedGeometry();
  requestRender({ force: true });
}

window.addEventListener('resize', handleViewportChange);
window.addEventListener('orientationchange', () => requestAnimationFrame(handleViewportChange));
window.visualViewport?.addEventListener('resize', handleViewportChange);
window.addEventListener('pagehide', () => {
  sourceRequestGate.cancel();
  settleFovPrompt(null);
  window.clearInterval(state.buildTimer);
  window.clearInterval(state.pollTimer);
  window.clearTimeout(state.refitHandle);
  rejectWorkerJobs(new MobileDepthRequestAborted());
  rgbdeWorker?.terminate();
  rgbdeWorker = null;
  tilt.stop();
  tracker.stop({ emit: false });
  renderer.destroy();
  state.presentedScene = null;
  state.sourceScene = null;
  state.localSourceBlob = null;
  renderRate.reset();
  touch.destroy();
}, { once: true });

async function pollPublishedScene() {
  if (state.sourceScene?.origin !== 'local-rgbde' && !state.building) {
    await loadPublishedScene();
    return;
  }
  try {
    const envelope = await fetchPublishedSceneManifest();
    const available = Boolean(envelope.available && (
      envelope.revision !== state.revision
      || envelope.manifest?.publishedAt !== state.publishedManifest?.publishedAt
    ));
    state.desktopUpdateAvailable = available;
    document.body.dataset.desktopUpdate = String(available);
    if (envelope.available) {
      state.revision = envelope.revision;
      state.publishedManifest = envelope.manifest;
      state.reducedAvailable = Boolean(envelope.hasReduced);
    }
  } catch {
    // Poll failure must not replace or obscure a successfully built local scene.
  }
}

// The three presentation variables that can only be settled by looking at a
// real device: how far the viewer actually holds it, how thick the miniature
// should be, and how much of the depth budget the near subject should take.
function syncDebugControls() {
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

{
  debugDistanceInput.addEventListener('input', () => {
    viewingDistanceMm = Number(debugDistanceInput.value);
    saveStoredNumber(window.localStorage, VIEWING_DISTANCE_STORAGE_KEY, viewingDistanceMm);
    const geometry = refreshViewingGeometry();
    tracker.setViewingGeometry({
      worldUnitMm: geometry.worldUnitMm,
      baselineEyeZ: geometry.baselineEyeZ,
    });
    if (!tracker.running || !state.eyePose) {
      useBaselineTrueWindowReference({ awaitTrackedPose: tracker.running });
    }
    refreshAutoWindowFraming();
    syncDebugControls();
    rebuildPresentedGeometry();
    requestRender({ force: true });
  });
  debugSpanInput.addEventListener('input', () => {
    state.depthSpan = Number(debugSpanInput.value);
    syncDebugControls();
    rebuildPresentedGeometry();
    requestRender({ force: true });
  });
  debugBlendInput.addEventListener('input', () => {
    state.disparityBlend = Number(debugBlendInput.value);
    syncDebugControls();
    rebuildPresentedGeometry();
    requestRender({ force: true });
  });
  debugLevelInput.addEventListener('change', async () => {
    state.levelToGravity = debugLevelInput.checked;
    if (state.levelToGravity) {
      const permission = await tilt.start();
      if (permission !== 'granted') {
        state.levelToGravity = false;
        setStatus('Motion access was refused; Hold level remains off.');
      }
    }
    updateLevellingButton();
    syncDebugControls();
    requestRender({ force: true });
  });
  debugRefitInput.addEventListener('change', () => {
    state.refitDepthToView = debugRefitInput.checked;
    if (!state.refitDepthToView && state.fittedDepthRange) {
      state.fittedDepthRange = null;
      rebuildPresentedGeometry();
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
state.pollTimer = window.setInterval(() => void pollPublishedScene(), 3000);
