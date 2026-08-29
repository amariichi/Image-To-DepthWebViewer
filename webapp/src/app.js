import {
  decodeRgbdeFile,
  findBestMeshSize,
  generatePerspectiveMesh,
  DEFAULT_CENTER_Z,
} from './geometry.js';
import { computeDeformedBounds, createDeformedPositions } from './mesh-evaluator.js';
import { createRenderer, mat4 } from './rendering.js';
import WebXRManager from './webxr.js';
import XRHintOverlay from './xr-hints.js';
import {
  DEFAULT_TEXTURE_MIME_TYPE,
  MOBILE_TEXTURE_MIME_TYPE,
  createGlbBlob,
} from './gltf-exporter.js';
import {
  createMobileSceneManifest,
  mobileDepthSpanForMagnification,
  publishMobileScene,
} from './mobile-scene-client.js';
import {
  MOBILE_PUBLISH_PROFILES,
  createMobilePublishMesh,
  fitMobileTextureSize,
} from './mobile-publish-mesh.js';

const sourceInput = document.getElementById('source-input');
const generateButton = document.getElementById('generate-depth');
const saveButton = document.getElementById('save-rgbde');
const saveGltfButton = document.getElementById('save-gltf');
const publishMobileButton = document.getElementById('publish-mobile');
const openMobileImageButton = document.getElementById('open-mobile-image');
// What the host is holding for the editor, or null. Refreshed rather than
// polled: the moment that matters is coming back to this machine.
let mobileSourceStatus = null;
// The revision already open here. Opening resets depth shaping, FOV and
// placement with no undo, so re-opening the identical image can only cost
// work; the button offers itself again only once the phone has made something
// new. Zero is never a real revision, so nothing is open to begin with.
let openedMobileRevision = 0;
// The phone polls this host for a published scene every three seconds; this is
// the same exchange in the other direction, so it keeps the same interval.
const MOBILE_SOURCE_POLL_MS = 3000;
let mobileSourcePollTimer = null;
const canvas = document.getElementById('glCanvas');
const toggleButton = document.getElementById('toggle-ui');
const mirrorToggleButton = document.getElementById('toggle-ui-mirror');
const panel = document.getElementById('control-panel');
const fileInput = document.getElementById('file-input');
const openDialogButton = document.getElementById('open-dialog');
const geomFovInput = document.getElementById('geom-fov');
const meshQualityInput = document.getElementById('mesh-quality');
const displayModeInput = document.getElementById('display-mode');
const enterVrButton = document.getElementById('enter-vr');
const enterLookingGlassButton = document.getElementById('enter-looking-glass');
const showXrHintsInput = document.getElementById('show-xr-hints');
const stereoSeparationInput = document.getElementById('stereo-separation');
const swapEyesInput = document.getElementById('swap-eyes');
const magnificationInput = document.getElementById('magnification');
const zOffsetInput = document.getElementById('z-offset');
const farClipInput = document.getElementById('far-clip');
const depthModeInput = document.getElementById('depth-mode');
const logPowerInput = document.getElementById('log-power');
const fovInput = document.getElementById('fov');
const dropHint = document.getElementById('drop-hint');
const statusBox = document.getElementById('status');
const mirrorPanel = document.getElementById('control-panel-mirror');

// Same origin by default, so the request carries the page's own scheme and
// host. Naming the backend directly made this a cross-origin plain-text
// call from an HTTPS page, which each browser decides about differently.
const API_BASE = window.__RGBDE_API_BASE__ ?? '';

const bindings = {
  magnificationValue: document.querySelector('[data-bind="magnificationValue"]'),
  zOffsetValue: document.querySelector('[data-bind="zOffsetValue"]'),
  farClipValue: document.querySelector('[data-bind="farClipValue"]'),
  depthMode: document.querySelector('[data-bind="depthMode"]'),
  logPowerValue: document.querySelector('[data-bind="logPowerValue"]'),
  geomFovValue: document.querySelector('[data-bind="geomFovValue"]'),
  fovValue: document.querySelector('[data-bind="fovValue"]'),
  stereoValue: document.querySelector('[data-bind="stereoValue"]'),
  sourceFile: document.querySelector('[data-bind="sourceFile"]'),
  backendStatus: document.querySelector('[data-bind="backendStatus"]'),
  xrStatus: document.querySelector('[data-bind="xrStatus"]'),
};

const mirrorBindings = new Map();
const syncControls = new Map();
const mirrorControls = new Map();

const MAX_Z_OFFSET = 5;
const MIN_SCALE = 0.05;
const MAX_SCALE = 25;
const DESIRED_NEAR = -2.0;
// The monitor path puts the model two units in front of a camera at the origin.
// A Looking Glass shows a hologram volume `targetDiam` deep, centred on the
// reference-space origin, so the same placement leaves the model behind that
// volume and it has to be dragged forward by hand every session. Landing the
// nearest surface on the front face of the volume instead lets the model recede
// into it, which is where a depth relief belongs: nothing pops out past the
// frame, where a Looking Glass clips it. Anchoring on the focal plane itself
// overshot by roughly half the volume on a real device.
// Where the model's nearest surface sits in the Looking Glass reference space.
// The monitor path uses DESIRED_NEAR, which left the model behind the hologram
// volume and had to be dragged forward by hand every session. Anchoring 2.0
// forward of that overshot by a reported 1.3 to 1.5, which puts the wanted
// position half a unit forward, and that is this value. It is deliberately not
// derived from `targetDiam`: that is a framing control the viewer adjusts per
// scene, and it must not silently move the model in depth as well. The Z Offset
// slider still applies on top.
const LOOKING_GLASS_MODEL_FRONT_Z = -1.5;
// Where the hologram volume sits in depth is a property of the display, not of
// the picture: two very different scenes were both settled at about -0.575 on a
// Looking Glass Go. Its height and size are not, because a perspective mesh is
// `rayDirection * depth`, so a scene with distant sky at the top spreads far
// wider above the axis than below it. Those two are therefore derived from the
// model's own bounds rather than fixed.
const LOOKING_GLASS_TARGET_Z = -0.575;
// The library assumes a standing viewer and looks at 1.6 above the floor, which
// leaves a model sitting near the origin low in the frame. Two very different
// scenes were settled at 0.11 and 0.92 on a Looking Glass Go, so the right value
// is per-scene; zero is simply a far better starting point than 1.6.
//
// No formula is offered for it, or for `targetDiam`. Deriving them from the
// model's bounds was tried and disagreed with both measurements in magnitude
// and sign, because the bounding box of a perspective reconstruction is
// dominated by its far cone rather than by the subject -- the same reason the
// mobile relief fits on UVs instead of on XYZ bounds.
const LOOKING_GLASS_TARGET_Y = 0;
const MAG_MIN = 0.1;
const MAG_MAX = 100;
// One is the identity: `shapeDepth` computes `minDepth + magnification *
// (shaped - minDepth)`, so this is the scene at its own metric depth. The
// previous 0.5 halved every scene's depth by default for no stated reason.
const MAG_DEFAULT = 1;
const FAR_MAX = 1000;
const FAR_MIN = 0.2;
const FAR_AUTO_EXPANSION = 10;
const GEOM_FOV_MIN = 15;
const GEOM_FOV_MAX = 120;
const GEOM_FOV_DEFAULT = 32;
const MESH_TARGET_BASE = 250000;
const MESH_QUALITY_DEFAULT = 1;
const MESH_QUALITY_OPTIONS = new Set([1, 2, 4]);
const FOV_MIN = 15;
const FOV_MAX = 120;
const FOV_DEFAULT = 60;
const GENERATE_LABEL_DEFAULT = 'Generate Depth';
const GENERATE_LABEL_BUSY = 'Generating…';
const SAVE_LABEL_GENERATED = 'Save RGBDE';
const SAVE_LABEL_EXISTING = 'Download RGBDE';
const STEREO_MIN = 0;
const STEREO_MAX = 0.2;
const STEREO_DEFAULT = 0.065;
const STEREO_CONVERGENCE_MIN = 0.25;
const BACKEND_TIMEOUT_MS = 7000;
const POINTER_ROTATION_SENSITIVITY = (Math.PI / 180) * 0.04;
const POINTER_MAX_ANGLE = Math.PI / 6;
const XR_TRANSLATION_PIXEL_SCALE = 1500;
const XR_STICK_DEADZONE = 0.08;
const XR_ROTATION_PIXEL_SCALE = 2000;
const XR_TRANSLATION_Z_SCALE = 5;
const XR_TRIGGER_SCALE_COEF = 1200;
const XR_TRIGGER_Z_DEADZONE = 0.0005;
const XR_FOV_DELTA_PER_FRAME = 0.2;
const XR_MAG_DELTA_PER_FRAME = 0.02;
const XR_FAR_DELTA_PER_SEC = 50;

let renderer;
try {
  renderer = createRenderer(canvas);
} catch (error) {
  showStatus(error.message, 0);
  throw error;
}

const xrHints = new XRHintOverlay(renderer.gl);
let xrHintsEnabled = true;
let xrManager = null;

const xrLeftControllerState = {
  rotating: false,
  dragging: false,
  lastEuler: null,
  lastPosition: null,
  inputSource: null,
  triggerHeld: false,
  gripHeld: false,
  lastRotatePosition: null,
  showingOrbit: false,
  farAdjust: 0,
};

function resetLeftControllerState(options = {}) {
  const { keepSource = false } = options;
  xrLeftControllerState.rotating = false;
  xrLeftControllerState.dragging = false;
  xrLeftControllerState.lastEuler = null;
  xrLeftControllerState.lastPosition = null;
  xrLeftControllerState.lastRotatePosition = null;
  xrLeftControllerState.triggerHeld = false;
  xrLeftControllerState.gripHeld = false;
  xrLeftControllerState.showingOrbit = false;
  xrLeftControllerState.farAdjust = 0;
  if (!keepSource) {
    xrLeftControllerState.inputSource = null;
  }
}

function showXrHint(label, value = null) {
  if (!xrHintsEnabled || !xrHints || !state.xr.active || state.xr.mode !== 'vr') {
    return;
  }
  xrHints.showAction(label, value);
}

function updateXRDebug(payload) {
  if (typeof window === 'undefined') {
    return;
  }
  window.__xrDebug = {
    timestamp: performance.now(),
    ...payload,
  };
}

function selectPreferredInputSource(sources) {
  if (!sources || sources.length === 0) {
    return null;
  }
  const priority = ['left', 'none', 'right'];
  for (const handedness of priority) {
    const match = sources.find((source) => source && source.handedness === handedness);
    if (match) {
      return match;
    }
  }
  return sources[0] || null;
}

function isSameInputSource(a, b) {
  return Boolean(a && b && a === b);
}

function assignActiveInputSource(source, { reason } = {}) {
  if (!source) {
    return;
  }
  if (!isSameInputSource(xrLeftControllerState.inputSource, source)) {
    xrLeftControllerState.inputSource = source;
    xrLeftControllerState.lastEuler = null;
    xrLeftControllerState.lastPosition = null;
  }
  updateXRDebug({
    note: reason || 'active input source assigned',
    handedness: source.handedness,
    hasGamepad: Boolean(source.gamepad),
  });
}

const state = {
  rgbde: null,
  mesh: null,
  is360: false,
  options: {
    magnification: MAG_DEFAULT,
    farClip: FAR_MAX,
    mode: 'linear',
    logPower: 1,
  },
  meshConfig: {
    meshX: 0,
    meshY: 0,
    geomFov: GEOM_FOV_DEFAULT,
    defaultGeomFov: GEOM_FOV_DEFAULT,
    qualityMultiplier: MESH_QUALITY_DEFAULT,
  },
  camera: {
    fov: FOV_DEFAULT,
  },
  stereo: {
    mode: 'mono',
    separation: STEREO_DEFAULT,
    swapEyes: false,
  },
  controls: {
    rotationX: 0,
    rotationY: 0,
    translationX: 0,
    translationY: 0,
    translationZ: 0,
    scale: 1,
  },
  interaction: {
    dragging: false,
    rotating: false,
    lastX: 0,
    lastY: 0,
  },
  lookingGlassFrameStale: true,
  centerZ: DEFAULT_CENTER_Z,
  initialScale: 1.0,
  autoTranslationZ: 0.0,
  pivotZ: 0.0,
  displayBounds: null,
  backend: {
    available: false,
    device: null,
    checking: false,
    note: null,
  },
  xr: {
    supported: false,
    active: false,
    mode: null,
    status: 'WebXR: checking…',
    lookingGlassReady: false,
    lookingGlassError: null,
  },
  asset: {
    blob: null,
    filename: null,
    source: null,
  },
  processing: false,
  uiHidden: false,
  sourceLabel: 'No file selected',
  loadRequestId: 0,
  render: {
    pending: false,
    modelMatrixDirty: true,
    modelMatrix: mat4.identity(),
  },
};

function init() {
  attachUIListeners();
  attachPointerListeners();
  attachDropListeners();
  window.addEventListener('resize', resizeCanvas);
  saveButton.disabled = true;
  if (saveGltfButton) {
    saveGltfButton.disabled = true;
  }
  if (publishMobileButton) {
    publishMobileButton.disabled = true;
  }
  generateButton.disabled = false;
  generateButton.textContent = GENERATE_LABEL_DEFAULT;
  updateSaveButtonState();
  setReconstructionFov(state.meshConfig.geomFov, { rebuild: false });
  initMirrorPanel();
  setupXR();
  setDisplayMode(state.stereo.mode);
  setUiHidden(false);
  stereoSeparationInput.value = state.stereo.separation.toFixed(3);
  swapEyesInput.checked = state.stereo.swapEyes;
  setSourceLabel(state.sourceLabel);
  if (meshQualityInput) {
    meshQualityInput.value = String(state.meshConfig.qualityMultiplier);
  }
  updateBinding('stereoValue', state.stereo.separation.toFixed(3));
  updateBinding('xrStatus', state.xr.status);
  checkBackend();
  resetView();
  resizeCanvas();
  requestRender();
}

function resizeCanvas() {
  renderer.resize(window.innerWidth, window.innerHeight);
  requestRender();
}

function invalidateModelMatrix() {
  state.render.modelMatrixDirty = true;
}

function requestRender() {
  if (state.xr.active || state.render.pending) {
    return;
  }
  state.render.pending = true;
  requestAnimationFrame(renderFrame);
}

function renderFrame() {
  state.render.pending = false;
  renderScene();
}

async function handleFiles(input, meta = {}) {
  if (!input) return false;
  let file = null;
  if (input instanceof File) {
    file = input;
  } else if (input instanceof FileList) {
    file = input.length > 0 ? input[0] : null;
  } else if (Array.isArray(input)) {
    file = input.length > 0 ? input[0] : null;
  }
  if (!file) return false;
  const requestId = ++state.loadRequestId;
  try {
    showStatus('Loading…');
    const data = await decodeRgbdeFile(file);
    if (requestId !== state.loadRequestId) {
      return false;
    }
    state.rgbde = data;
    state.is360 = /\.360\./i.test(file.name);
    const { width, height } = data;
    const meshSize = findBestMeshSize(width, height, getMeshTarget());
    if (!meshSize.meshX || !meshSize.meshY) {
      throw new Error('Unable to determine mesh density for this image.');
    }
    if (state.is360) {
      showStatus('360° RGBDE files are displayed using planar reconstruction (spherical mode not yet implemented).', 4000);
    }
    state.meshConfig.meshX = meshSize.meshX;
    state.meshConfig.meshY = meshSize.meshY;
    const metadataGeomFov = getMetadataVerticalFov(data.metadata);
    const currentGeomFov = clamp(
      metadataGeomFov ?? state.meshConfig.geomFov,
      GEOM_FOV_MIN,
      GEOM_FOV_MAX,
    );
    state.meshConfig.defaultGeomFov = currentGeomFov;
    setReconstructionFov(currentGeomFov, { rebuild: false });
    const mesh = generatePerspectiveMesh({
      depth: data.depth,
      width,
      height,
      meshX: meshSize.meshX,
      meshY: meshSize.meshY,
      depthMin: data.depthStats.min,
      depthMax: data.depthStats.max,
      centerZ: state.centerZ,
      fovDegrees: currentGeomFov,
    });
    state.mesh = mesh;
    renderer.updateGeometry(mesh);
    renderer.setDepthOptions(mesh, state.options);
    renderer.setTexture(data.textureImage);
    updateGlbButtonState();
    state.baseBounds = computeBaseBounds(mesh);
    state.initialScale = calculateInitialScale(state.baseBounds);

    state.options.magnification = MAG_DEFAULT;
    state.options.mode = 'linear';
    state.options.logPower = 1;
    const depthMax = Math.max(data.depthStats.max || 0, FAR_MIN);
    const baseFar = Math.ceil(depthMax);
    const expandedFar = Math.ceil(baseFar * FAR_AUTO_EXPANSION);
    const suggestedFar = Math.min(FAR_MAX, Math.max(FAR_MIN, expandedFar));
    state.options.farClip = Math.max(suggestedFar, FAR_MIN);
    farClipInput.value = String(farClipToSlider(state.options.farClip));
    updateBinding('farClipValue', formatFarClip(state.options.farClip));

    const sliderPosition = magnificationToSlider(state.options.magnification);
    magnificationInput.value = String(sliderPosition);
    updateBinding('magnificationValue', state.options.magnification.toFixed(2));

    updateDepthTransform({ resetTranslation: true });
    applyInitialView();
    resetView();
    setCurrentAsset(file, meta.sourceType || 'rgbde');
    const metadataNote = metadataGeomFov !== null
      ? `; Geometry FOV ${Math.round(currentGeomFov)}° from metadata`
      : '';
    showStatus(`Loaded ${file.name} (${width}×${height})${metadataNote}`);
    return true;
  } catch (error) {
    if (requestId !== state.loadRequestId) {
      return false;
    }
    console.error(error);
    const message = error.message || 'Failed to load RGBDE file.';
    if (/RGBDE PNG must have even width/i.test(message) || /Unable to determine mesh density/i.test(message)) {
      showStatus('This file is not an RGBDE PNG. Use Generate Depth for raw images.', 5000);
    } else {
      showStatus(message, 4000);
    }
    if (!state.asset.blob) {
      saveButton.disabled = true;
    }
    return false;
  }
}

function setCurrentAsset(blob, sourceType) {
  state.asset.blob = blob;
  state.asset.filename = blob && blob.name ? blob.name : 'output_RGBDE.png';
  state.asset.source = sourceType;
  // A different picture wants its own Looking Glass framing.
  state.lookingGlassFrameStale = true;
  updateSaveButtonState();
}

function setSourceLabel(text) {
  const label = text && text.trim() ? text.trim() : 'No file selected';
  state.sourceLabel = label;
  updateBinding('sourceFile', label);
}

function updateSaveButtonState() {
  if (!state.asset.blob) {
    saveButton.disabled = true;
    saveButton.textContent = SAVE_LABEL_GENERATED;
    updateGlbButtonState();
    return;
  }
  saveButton.disabled = false;
  if (state.asset.source === 'generated') {
    saveButton.textContent = SAVE_LABEL_GENERATED;
  } else {
    saveButton.textContent = SAVE_LABEL_EXISTING;
  }
  updateGlbButtonState();
}

function updateGlbButtonState() {
  const meshReady = Boolean(state.mesh && state.rgbde);
  if (saveGltfButton) {
    saveGltfButton.disabled = !meshReady;
  }
  if (publishMobileButton) {
    publishMobileButton.disabled = !meshReady;
  }
  syncMirrorControls();
}

function saveCurrentAsset() {
  if (!state.asset.blob) return;
  const url = URL.createObjectURL(state.asset.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = state.asset.filename || 'output_RGBDE.png';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function getExportBaseName() {
  if (state.asset && state.asset.filename) {
    const withoutExtension = state.asset.filename.replace(/\.[^.]+$/, '');
    const sanitized = withoutExtension.replace(/_RGBDE$/i, '');
    return sanitized || 'depth_export';
  }
  return 'depth_export';
}

function createMobileTextureImageData(imageData, budget = MOBILE_PUBLISH_PROFILES.full) {
  const fitted = fitMobileTextureSize(imageData.width, imageData.height, {
    maxDimension: budget.maxTextureDimension,
    maxPixels: budget.maxTexturePixels,
  });
  if (fitted.width === imageData.width && fitted.height === imageData.height) return imageData;
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = imageData.width;
  sourceCanvas.height = imageData.height;
  const sourceContext = sourceCanvas.getContext('2d');
  const targetCanvas = document.createElement('canvas');
  targetCanvas.width = fitted.width;
  targetCanvas.height = fitted.height;
  const targetContext = targetCanvas.getContext('2d');
  if (!sourceContext || !targetContext) {
    throw new Error('Canvas 2D is unavailable for mobile texture optimization.');
  }
  sourceContext.putImageData(imageData, 0, 0);
  targetContext.drawImage(sourceCanvas, 0, 0, fitted.width, fitted.height);
  return targetContext.getImageData(0, 0, fitted.width, fitted.height);
}

async function createCurrentGlb({
  modelMatrix,
  mobileOptimized = false,
  mobileProfile = MOBILE_PUBLISH_PROFILES.full,
} = {}) {
  if (!state.mesh) {
    throw new Error('No mesh available to export.');
  }
  if (!state.rgbde || !state.rgbde.textureImage) {
    throw new Error('Texture data is unavailable for export.');
  }
  const baseName = getExportBaseName();
  const textureFileName = `${baseName || 'depth_export'}.png`;
  // Depth Magnification linearly scales the depth range, and the mobile
  // manifest already carries that intent as its relief span. Applying it to the
  // published geometry as well would count it twice, and the second count is
  // not neutral: squeezing the source range toward the near plane also shifts
  // the mobile disparity mapping, so the subject ends up with a smaller share
  // of a smaller budget. Far clipping and any log shaping still apply.
  const exportOptions = mobileOptimized
    ? { ...state.options, magnification: 1 }
    : state.options;
  const deformedPositions = createDeformedPositions(state.mesh, exportOptions);
  const mesh = mobileOptimized
    ? createMobilePublishMesh(
      { ...state.mesh, positions: deformedPositions },
      { maxVertices: mobileProfile.maxVertices },
    )
    : { ...state.mesh, positions: deformedPositions };
  const textureImage = mobileOptimized
    ? createMobileTextureImageData(state.rgbde.textureImage, mobileProfile)
    : state.rgbde.textureImage;
  const blob = await createGlbBlob({
    mesh,
    modelMatrix,
    meshName: baseName,
    includeUVs: Boolean(mesh.uvs),
    includeNormals: !mobileOptimized,
    // The texture dominates what a phone must download and hold, so the mobile
    // profile ships JPEG. Desktop glTF exports stay lossless PNG.
    textureMimeType: mobileOptimized ? MOBILE_TEXTURE_MIME_TYPE : DEFAULT_TEXTURE_MIME_TYPE,
    texture: {
      imageData: textureImage,
      fileName: textureFileName,
    },
  });
  return {
    baseName,
    blob,
    filename: `${baseName || 'depth_export'}.glb`,
    profile: {
      vertexCount: mesh.positions.length / 3,
      textureWidth: textureImage.width,
      textureHeight: textureImage.height,
    },
  };
}

async function saveCurrentMeshAsGlb() {
  const buttonRestore = saveGltfButton ? saveGltfButton.disabled : null;
  if (saveGltfButton) {
    saveGltfButton.disabled = true;
  }
  try {
    showStatus('Preparing glTF export…', 0);
    const { blob, filename } = await createCurrentGlb({ modelMatrix: computeModelMatrix() });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showStatus(`Exported ${filename}`, 3000);
  } catch (error) {
    console.error(error);
    const message = error && error.message ? error.message : 'Failed to export glTF.';
    showStatus(message, 5000);
  } finally {
    if (saveGltfButton && buttonRestore !== null) {
      saveGltfButton.disabled = buttonRestore;
    } else if (saveGltfButton) {
      saveGltfButton.disabled = false;
    }
  }
}

async function publishCurrentMeshToMobile() {
  const buttonRestore = publishMobileButton ? publishMobileButton.disabled : null;
  if (publishMobileButton) {
    publishMobileButton.disabled = true;
  }
  syncMirrorControls();
  try {
    showStatus('Preparing mobile scene…', 0);
    // Omitting modelMatrix keeps the GLB node transform-free. Mobile placement is
    // computed independently from the desktop inspection camera and auto-fit state.
    const { blob, filename, profile } = await createCurrentGlb({ mobileOptimized: true });
    showStatus('Preparing mobile fallback scene…', 0);
    const fallback = await createCurrentGlb({
      mobileOptimized: true,
      mobileProfile: MOBILE_PUBLISH_PROFILES.reduced,
    });
    const manifest = createMobileSceneManifest({
      sourceName: state.asset.filename,
      depthSpan: mobileDepthSpanForMagnification(state.options.magnification),
      // The capture field of view lets the mobile viewer report how much the
      // relief is exaggerated relative to the scene's real proportions. It is
      // reporting only; the presentation itself never depends on it.
      captureFovDeg: state.meshConfig.geomFov,
    });
    const result = await publishMobileScene({
      blob,
      reducedBlob: fallback.blob,
      filename,
      manifest,
    });
    showStatus(
      `Published optimized ${filename} to mobile (revision ${result.revision}, ${profile.vertexCount.toLocaleString()} vertices, ${profile.textureWidth}×${profile.textureHeight}, ${(blob.size / (1024 * 1024)).toFixed(1)} MB; fallback ${(fallback.blob.size / (1024 * 1024)).toFixed(1)} MB).`,
      5500,
    );
  } catch (error) {
    console.error(error);
    const message = error && error.message ? error.message : 'Failed to publish mobile scene.';
    showStatus(message, 5000);
  } finally {
    if (publishMobileButton && buttonRestore !== null) {
      publishMobileButton.disabled = buttonRestore;
    }
    updateGlbButtonState();
  }
}

/**
 * Open the depth image this machine last generated for the phone.
 *
 * Nothing travels from the phone. Inference already runs here, so the RGBDE
 * passed through this host on its way out and a copy was kept; the phone never
 * uploads bytes this machine produced, which matters on a metered connection.
 *
 * It is a pull rather than a push on purpose: a scene being worked on here is
 * never replaced because someone picked up the phone.
 */
function describeMobileSource(status) {
  if (!status) return null;
  const when = Number.isFinite(status.createdAt)
    ? new Date(status.createdAt * 1000).toLocaleTimeString()
    : null;
  const lens = Number.isFinite(status.focalLength35mm)
    ? `${Math.round(status.focalLength35mm)} mm`
    : null;
  return [status.filename, lens, when].filter(Boolean).join(' · ');
}

async function readMobileSourceStatus() {
  try {
    const response = await fetch('/viewer-api/mobile-source', { cache: 'no-store' });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload && payload.available ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Watch for something new only while there is nothing to offer.
 *
 * A disabled button is the state where a change would go unseen: the phone can
 * produce a scene at any moment and nothing here would say so. Once the button
 * is offering one it has already said everything it can, and what is finally
 * opened is re-read at that moment anyway, so watching past that point buys
 * nothing. A hidden tab is not watched either.
 */
function updateMobileSourceWatch() {
  const shouldWatch = Boolean(openMobileImageButton)
    && openMobileImageButton.disabled
    && !document.hidden;
  if (shouldWatch && mobileSourcePollTimer === null) {
    mobileSourcePollTimer = window.setInterval(() => {
      void refreshMobileSourceButton();
    }, MOBILE_SOURCE_POLL_MS);
  } else if (!shouldWatch && mobileSourcePollTimer !== null) {
    window.clearInterval(mobileSourcePollTimer);
    mobileSourcePollTimer = null;
  }
}

async function refreshMobileSourceButton() {
  if (!openMobileImageButton) return;
  mobileSourceStatus = await readMobileSourceStatus();
  const isNew = Boolean(mobileSourceStatus)
    && mobileSourceStatus.revision !== openedMobileRevision;
  openMobileImageButton.disabled = !isNew;
  if (!mobileSourceStatus) {
    openMobileImageButton.title = 'Nothing has been generated for the phone yet.';
  } else if (isNew) {
    openMobileImageButton.title =
      `Open the depth image last generated for the phone (${describeMobileSource(mobileSourceStatus)})`;
  } else {
    openMobileImageButton.title =
      `Already open here (${describeMobileSource(mobileSourceStatus)}). `
      + 'Generate another on the phone to bring one across.';
  }
  updateMobileSourceWatch();
}

async function openMobileImage() {
  const restore = openMobileImageButton ? openMobileImageButton.disabled : null;
  if (openMobileImageButton) openMobileImageButton.disabled = true;
  try {
    // Read the status again first, so the name and lens reported are the ones
    // actually about to be opened rather than whatever was there on arrival.
    const status = await readMobileSourceStatus();
    if (!status) {
      showStatus('Nothing has been generated for the phone yet.', 4000);
      return;
    }
    showStatus('Opening the phone\u2019s depth image…', 0);
    const response = await fetch('/viewer-api/mobile-source/image', { cache: 'no-store' });
    if (!response.ok) throw new Error(`The host answered ${response.status}.`);
    const blob = await response.blob();
    if (blob.size === 0) throw new Error('The stored image is empty.');
    const file = new File([blob], status.filename || 'mobile_RGBDE.png', { type: 'image/png' });
    const loaded = await handleFiles(file, { sourceType: 'generated' });
    if (loaded) openedMobileRevision = status.revision;
    showStatus(
      loaded ? `Opened ${describeMobileSource(status)}` : 'That image could not be read.',
      loaded ? 4000 : 5000,
    );
  } catch (error) {
    console.error(error);
    showStatus(error && error.message ? error.message : 'Could not open the phone image.', 5000);
  } finally {
    if (openMobileImageButton && restore !== null) openMobileImageButton.disabled = restore;
    void refreshMobileSourceButton();
  }
}

function setProcessing(isProcessing) {
  state.processing = isProcessing;
  generateButton.disabled = Boolean(isProcessing);
  generateButton.textContent = isProcessing ? GENERATE_LABEL_BUSY : GENERATE_LABEL_DEFAULT;
}

async function generateFromSource(sourceFile) {
  setProcessing(true);
  state.backend.note = null;
  updateBackendStatus();
  let shouldClearSelection = false;
  try {
    showStatus(`Generating Depth for ${sourceFile.name}…`, 0);
    const result = await requestDepthGeneration(sourceFile);
    const loaded = await handleFiles(result.file, { sourceType: 'generated' });
    if (loaded) {
      showStatus(`Generated ${result.filename}`, 4000);
      shouldClearSelection = true;
      updateBackendStatus();
    }
  } catch (error) {
    console.error(error);
    showStatus(error.message || 'Depth generation failed.', 5000);
    if (error.message && /unreachable/i.test(error.message)) {
      state.backend.available = false;
    }
    state.backend.note = `selected ${sourceFile.name}`;
    updateBackendStatus();
  } finally {
    setProcessing(false);
    if (shouldClearSelection) {
      sourceInput.value = '';
      setSourceLabel('No file selected');
    }
  }
}

async function requestDepthGeneration(file) {
  const form = new FormData();
  form.append('image', file, file.name);
  let response;
  try {
    response = await fetch(`${API_BASE}/api/process`, {
      method: 'POST',
      body: form,
    });
  } catch {
    throw new Error('Depth service unreachable. Check that the backend is running.');
  }
  if (!response.ok) {
    let message = 'Depth generation failed.';
    const contentType = response.headers.get('content-type') || '';
    try {
      if (contentType.includes('application/json')) {
        const payload = await response.json();
        message = payload.detail || message;
      } else {
        const text = await response.text();
        message = text || message;
      }
    } catch (error) {
      console.warn('Failed to parse error payload', error);
    }
    throw new Error(message);
  }

  const arrayBuffer = await response.arrayBuffer();
  const blob = new Blob([arrayBuffer], { type: 'image/png' });
  const encodedName = response.headers.get('X-RGBDE-Filename-Encoded');
  const headerName = response.headers.get('X-RGBDE-Filename');
  const defaultName = `${file.name.replace(/\.[^.]+$/, '')}_RGBDE.png`;
  let filename = defaultName;
  if (encodedName) {
    try {
      filename = decodeURIComponent(encodedName);
    } catch (error) {
      console.warn('Failed to decode filename header', error);
      filename = headerName || defaultName;
    }
  } else if (headerName) {
    filename = headerName;
  }
  const generatedFile = new File([blob], filename, { type: 'image/png' });
  return { blob, file: generatedFile, filename };
}

async function checkBackend() {
  if (state.backend.checking) {
    return;
  }
  state.backend.checking = true;
  updateBackendStatus();
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timeoutId = null;
  if (controller) {
    timeoutId = setTimeout(() => {
      controller.abort();
    }, BACKEND_TIMEOUT_MS);
  }
  try {
    const response = await fetch(`${API_BASE}/api/status`, {
      cache: 'no-store',
      signal: controller ? controller.signal : undefined,
    });
    if (!response.ok) {
      throw new Error('Status check failed');
    }
    const data = await response.json();
    state.backend.available = true;
    state.backend.device = data.device || 'unknown';
    state.backend.note = null;
  } catch (error) {
    console.warn('Backend status check failed', error);
    state.backend.available = false;
    state.backend.device = null;
    if (error && error.name === 'AbortError') {
      state.backend.note = 'status check timed out';
    }
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    state.backend.checking = false;
    if (!state.backend.available && state.backend.note && state.backend.note.startsWith('selected ')) {
      state.backend.note = null;
    }
    updateBackendStatus();
    setProcessing(false);
    if (!state.backend.available) {
      showStatus('Depth service not reachable. RGBDE generation disabled.', 4000);
    }
  }
}

function updateBackendStatus() {
  let label;
  if (state.backend.checking) {
    label = 'Depth service: checking…';
  } else if (!state.backend.available) {
    label = 'Depth service: offline';
  } else {
    const device = state.backend.device ? ` (${state.backend.device})` : '';
    label = `Depth service: online${device}`;
  }
  if (state.backend.note) {
    label = `${label} – ${state.backend.note}`;
  }
  updateBinding('backendStatus', label);
}

function updateDepthTransform(options = {}) {
  if (!state.mesh) return;
  const clampedFar = Math.min(Math.max(state.options.farClip || FAR_MAX, FAR_MIN), FAR_MAX);
  if (clampedFar !== state.options.farClip) {
    state.options.farClip = clampedFar;
    farClipInput.value = String(farClipToSlider(clampedFar));
    updateBinding('farClipValue', formatFarClip(clampedFar));
  }
  renderer.setDepthOptions(state.mesh, state.options);
  const bounds = computeDeformedBounds(state.mesh, state.options);
  refreshAutoFit({ bounds, resetTranslation: Boolean(options.resetTranslation) });
  requestRender();
}

function attachUIListeners() {
  openDialogButton.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (event) => {
    handleFiles(event.target.files);
    event.target.value = '';
  });

  panel.addEventListener('scroll', syncMirrorScroll);

  displayModeInput.addEventListener('change', (event) => {
    const mode = event.target.value === 'sbs' ? 'sbs' : 'mono';
    setDisplayMode(mode);
  });

  stereoSeparationInput.addEventListener('input', (event) => {
    const value = clamp(Number(event.target.value), STEREO_MIN, STEREO_MAX);
    state.stereo.separation = value;
    updateBinding('stereoValue', value.toFixed(3));
    syncMirrorControls();
    requestRender();
  });

  swapEyesInput.addEventListener('change', (event) => {
    state.stereo.swapEyes = Boolean(event.target.checked);
    syncMirrorControls();
    requestRender();
  });

  sourceInput.addEventListener('change', () => {
    if (sourceInput.files && sourceInput.files[0]) {
      const name = sourceInput.files[0].name;
      state.backend.note = `selected ${name}`;
      setSourceLabel(name);
    } else {
      state.backend.note = null;
      setSourceLabel('No file selected');
    }
    updateBackendStatus();
    syncMirrorControls();
  });

  generateButton.addEventListener('click', async () => {
    if (state.processing) return;
    if (!state.backend.available) {
      showStatus('Depth service unavailable. Attempting to reconnect…', 4000);
      await checkBackend();
      return;
    }
    const sourceFile = sourceInput.files && sourceInput.files[0];
    if (!sourceFile) {
      sourceInput.click();
      return;
    }
    await generateFromSource(sourceFile);
  });

  saveButton.addEventListener('click', saveCurrentAsset);
  if (saveGltfButton) {
    saveGltfButton.addEventListener('click', () => {
      void saveCurrentMeshAsGlb();
    });
  }
  if (publishMobileButton) {
    publishMobileButton.addEventListener('click', () => {
      void publishCurrentMeshToMobile();
    });
  }
  if (openMobileImageButton) {
    openMobileImageButton.addEventListener('click', () => {
      void openMobileImage();
    });
    // The moment worth re-checking is coming back to this machine after using
    // the phone, so listen for that instead of polling a local endpoint.
    window.addEventListener('focus', () => {
      void refreshMobileSourceButton();
    });
    // A background tab is not worth polling, and coming back to one is worth
    // checking immediately rather than waiting out an interval.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) updateMobileSourceWatch();
      else void refreshMobileSourceButton();
    });
    void refreshMobileSourceButton();
  }
  toggleButton.addEventListener('click', () => {
    setUiHidden(!state.uiHidden);
  });
  if (mirrorToggleButton) {
    mirrorToggleButton.addEventListener('click', () => {
      setUiHidden(!state.uiHidden);
    });
  }

  magnificationInput.addEventListener('input', (event) => {
    const sliderValue = Number(event.target.value);
    const mag = sliderToMagnification(sliderValue);
    state.options.magnification = mag;
    updateBinding('magnificationValue', mag.toFixed(2));
    updateDepthTransform();
    syncMirrorControls();
  });

  geomFovInput.addEventListener('input', (event) => {
    const value = Number(event.target.value);
    setReconstructionFov(value, { rebuild: true, preserveView: true });
    syncMirrorControls();
  });

  if (meshQualityInput) {
    meshQualityInput.addEventListener('change', (event) => {
      setMeshQuality(event.target.value, { rebuild: true });
      syncMirrorControls();
    });
  }

  fovInput.addEventListener('input', (event) => {
    const value = Number(event.target.value);
    const clamped = clamp(value, FOV_MIN, FOV_MAX);
    if (clamped !== value) {
      event.target.value = String(clamped);
    }
    state.camera.fov = clamped;
    updateBinding('fovValue', Math.round(clamped).toString());
    syncMirrorControls();
    requestRender();
  });

  zOffsetInput.addEventListener('input', (event) => {
    const value = Number(event.target.value);
    const clamped = clamp(value, -MAX_Z_OFFSET, MAX_Z_OFFSET);
    if (clamped !== value) {
      event.target.value = clamped.toFixed(2);
    }
    state.controls.translationZ = clamped;
    updateBinding('zOffsetValue', clamped.toFixed(2));
    syncMirrorControls();
    invalidateModelMatrix();
    requestRender();
  });

  farClipInput.addEventListener('input', (event) => {
    const sliderValue = Number(event.target.value);
    const far = Math.max(sliderToFarClip(sliderValue), FAR_MIN);
    state.options.farClip = far;
    updateBinding('farClipValue', formatFarClip(far));
    updateDepthTransform();
    syncMirrorControls();
  });

  depthModeInput.addEventListener('change', (event) => {
    state.options.mode = event.target.checked ? 'log' : 'linear';
    updateBinding('depthMode', state.options.mode === 'log' ? 'Log' : 'Linear');
    logPowerInput.disabled = state.options.mode !== 'log';
    updateDepthTransform();
    syncMirrorControls();
  });

  logPowerInput.addEventListener('input', (event) => {
    const value = Number(event.target.value);
    state.options.logPower = Math.max(0.1, value);
    updateBinding('logPowerValue', state.options.logPower.toFixed(2));
    if (state.options.mode === 'log') {
      updateDepthTransform();
    }
    syncMirrorControls();
  });
}

function applyRotationDelta(dx, dy) {
  state.controls.rotationY = clamp(
    state.controls.rotationY + dx * POINTER_ROTATION_SENSITIVITY,
    -POINTER_MAX_ANGLE,
    POINTER_MAX_ANGLE,
  );
  state.controls.rotationX = clamp(
    state.controls.rotationX + dy * POINTER_ROTATION_SENSITIVITY,
    -POINTER_MAX_ANGLE,
    POINTER_MAX_ANGLE,
  );
  invalidateModelMatrix();
  requestRender();
}

function applyTranslationDelta(dx, dy) {
  const sizeFactor = state.baseBounds ? Math.max(state.baseBounds.sizeX, state.baseBounds.sizeY, 0.1) : 1;
  const movementScale = Math.min(sizeFactor + 0.3, 10);
  const factor = 0.0003 * movementScale * (state.controls.scale + 0.2);
  const prevX = state.controls.translationX;
  const prevY = state.controls.translationY;
  state.controls.translationX += dx * factor;
  state.controls.translationY -= dy * factor;
  const changed = prevX !== state.controls.translationX || prevY !== state.controls.translationY;
  if (changed) {
    invalidateModelMatrix();
    requestRender();
  }
  return changed;
}

function applyTranslationZDelta(delta) {
  if (!Number.isFinite(delta) || delta === 0) {
    return;
  }
  const next = clamp(state.controls.translationZ + delta, -MAX_Z_OFFSET, MAX_Z_OFFSET);
  if (next === state.controls.translationZ) {
    return;
  }
  state.controls.translationZ = next;
  invalidateModelMatrix();
  if (zOffsetInput) {
    zOffsetInput.value = next.toFixed(2);
  }
  updateBinding('zOffsetValue', next.toFixed(2));
  syncMirrorControls();
  requestRender();
}

function applyScaleFactor(factor) {
  if (!Number.isFinite(factor) || factor === 0) {
    return false;
  }
  const next = clamp(state.controls.scale * factor, MIN_SCALE, MAX_SCALE);
  if (next === state.controls.scale) {
    return false;
  }
  state.controls.scale = next;
  invalidateModelMatrix();
  requestRender();
  return true;
}

function applyScaleDelta(deltaMeters) {
  if (!Number.isFinite(deltaMeters) || Math.abs(deltaMeters) <= XR_TRIGGER_Z_DEADZONE) {
    return false;
  }
  const factor = Math.exp(-deltaMeters * XR_TRIGGER_SCALE_COEF * 0.001);
  return applyScaleFactor(factor);
}

function applyFovDelta(delta) {
  if (!Number.isFinite(delta) || delta === 0) {
    return false;
  }
  const current = state.meshConfig.geomFov ?? GEOM_FOV_DEFAULT;
  const next = clamp(current + delta, GEOM_FOV_MIN, GEOM_FOV_MAX);
  if (next === current) {
    return false;
  }
  setReconstructionFov(next, { rebuild: true, preserveView: true });
  syncMirrorControls();
  return true;
}

function applyMagnificationDelta(deltaFraction) {
  if (!Number.isFinite(deltaFraction) || deltaFraction === 0) {
    return false;
  }
  const current = state.options.magnification;
  const next = clamp(current * (1 + deltaFraction), MAG_MIN, MAG_MAX);
  if (next === current) {
    return false;
  }
  state.options.magnification = next;
  if (magnificationInput) {
    magnificationInput.value = String(Math.round(magnificationToSlider(next)));
  }
  updateBinding('magnificationValue', next.toFixed(2));
  updateDepthTransform();
  syncMirrorControls();
  return true;
}

function computeFarAdjust(gamepad) {
  if (!gamepad || !Array.isArray(gamepad.buttons)) {
    return 0;
  }
  const xButton = gamepad.buttons[4] || { pressed: false, value: 0 };
  const yButton = gamepad.buttons[5] || { pressed: false, value: 0 };
  const decrement = xButton.pressed || (xButton.value ?? 0) > 0.5 ? 1 : 0;
  const increment = yButton.pressed || (yButton.value ?? 0) > 0.5 ? 1 : 0;
  return increment - decrement;
}

function applyFarClipDelta(delta) {
  if (!Number.isFinite(delta) || delta === 0) {
    return false;
  }
  const current = state.options.farClip;
  const next = clamp(current + delta, FAR_MIN, FAR_MAX);
  if (next === current) {
    return false;
  }
  state.options.farClip = next;
  updateBinding('farClipValue', formatFarClip(next));
  if (farClipInput) {
    farClipInput.value = String(farClipToSlider(next));
  }
  updateDepthTransform();
  syncMirrorControls();
  showXrHint('Far Clip', formatFarClip(next));
  return true;
}

function getDominantStick(gamepad) {
  if (!gamepad || !Array.isArray(gamepad.axes) || gamepad.axes.length === 0) {
    return { x: 0, y: 0, pair: -1 };
  }
  const axes = gamepad.axes;
  const pairs = [];
  if (axes.length >= 2) {
    pairs.push({ x: axes[0], y: axes[1], pair: 0 });
  }
  if (axes.length >= 4) {
    pairs.push({ x: axes[2], y: axes[3], pair: 1 });
  }
  if (pairs.length === 0) {
    return { x: 0, y: 0, pair: -1 };
  }
  let best = pairs[0];
  let bestMagnitude = Math.abs(best.x) + Math.abs(best.y);
  for (let index = 1; index < pairs.length; index += 1) {
    const candidate = pairs[index];
    const magnitude = Math.abs(candidate.x) + Math.abs(candidate.y);
    if (magnitude > bestMagnitude) {
      best = candidate;
      bestMagnitude = magnitude;
    }
  }
  return best;
}

function applyWheelDelta(deltaY) {
  if (!deltaY) {
    return;
  }
  const factor = Math.exp(-deltaY * 0.001);
  state.controls.scale = clamp(state.controls.scale * factor, MIN_SCALE, MAX_SCALE);
  invalidateModelMatrix();
  requestRender();
}

function attachPointerListeners() {
  canvas.addEventListener('mousedown', (event) => {
    if (event.button === 0) {
      state.interaction.rotating = true;
      state.interaction.lastX = event.clientX;
      state.interaction.lastY = event.clientY;
    } else if (event.button === 2) {
      state.interaction.dragging = true;
      state.interaction.lastX = event.clientX;
      state.interaction.lastY = event.clientY;
    }
  });

  window.addEventListener('mouseup', (event) => {
    if (event.button === 0) {
      state.interaction.rotating = false;
    }
    if (event.button === 2) {
      state.interaction.dragging = false;
    }
  });

  window.addEventListener('mousemove', (event) => {
    if (state.interaction.rotating) {
      const dx = event.clientX - state.interaction.lastX;
      const dy = event.clientY - state.interaction.lastY;
      applyRotationDelta(dx, dy);
      state.interaction.lastX = event.clientX;
      state.interaction.lastY = event.clientY;
    }
    if (state.interaction.dragging) {
      const dx = event.clientX - state.interaction.lastX;
      const dy = event.clientY - state.interaction.lastY;
      applyTranslationDelta(dx, dy);
      state.interaction.lastX = event.clientX;
      state.interaction.lastY = event.clientY;
    }
  }, { passive: true });

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    applyWheelDelta(event.deltaY);
  }, { passive: false });

  canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });

  canvas.addEventListener('dblclick', () => {
    setReconstructionFov(state.meshConfig.defaultGeomFov ?? GEOM_FOV_DEFAULT, {
      rebuild: true,
      preserveView: false,
    });
    resetView();
    state.controls.scale = state.initialScale;
    state.controls.translationZ = 0;
    zOffsetInput.value = '0.00';
    updateBinding('zOffsetValue', '0.00');
    updateDepthTransform({ resetTranslation: true });
  });
}

function handleXRInputSourcesChange(event) {
  const session = event?.session || window.xrManager?.session || null;
  const added = Array.isArray(event?.added) ? event.added : event?.added ? Array.from(event.added) : [];
  const removed = Array.isArray(event?.removed) ? event.removed : event?.removed ? Array.from(event.removed) : [];
  const sessionSources = session ? Array.from(session.inputSources || []) : [];

  if (removed.includes(xrLeftControllerState.inputSource)) {
    resetLeftControllerState({ keepSource: false });
  }

  const preferred = selectPreferredInputSource(added) || selectPreferredInputSource(sessionSources);
  if (!preferred) {
    if (!sessionSources.length) {
      resetLeftControllerState();
    }
    updateXRDebug({
      note: 'inputsourceschange with no preferred source',
      added: added.map((source) => ({
        handedness: source.handedness,
        hasGamepad: Boolean(source.gamepad),
      })),
      removed: removed.map((source) => ({
        handedness: source.handedness,
      })),
      sources: sessionSources.map((source) => ({
        handedness: source.handedness,
        hasGamepad: Boolean(source.gamepad),
      })),
    });
    return;
  }
  assignActiveInputSource(preferred, { reason: 'inputsourceschange' });
}

function handleXRSelectStart(event) {
  const { inputSource } = event || {};
  if (inputSource) {
    assignActiveInputSource(inputSource, { reason: 'selectstart' });
  }
  xrLeftControllerState.triggerHeld = true;
  updateXRDebug({
    note: 'selectstart event',
    triggerHeld: true,
  });
}

function handleXRSelectEnd(event) {
  if (event?.inputSource && !isSameInputSource(event.inputSource, xrLeftControllerState.inputSource)) {
    return;
  }
  xrLeftControllerState.triggerHeld = false;
  xrLeftControllerState.rotating = false;
  xrLeftControllerState.lastRotatePosition = null;
  updateXRDebug({
    note: 'selectend event',
    triggerHeld: false,
  });
}

function handleXRSqueezeStart(event) {
  const { inputSource } = event || {};
  if (inputSource) {
    assignActiveInputSource(inputSource, { reason: 'squeezestart' });
  }
  xrLeftControllerState.gripHeld = true;
  updateXRDebug({
    note: 'squeezestart event',
    gripHeld: true,
  });
}

function handleXRSqueezeEnd(event) {
  if (event?.inputSource && !isSameInputSource(event.inputSource, xrLeftControllerState.inputSource)) {
    return;
  }
  xrLeftControllerState.gripHeld = false;
  xrLeftControllerState.dragging = false;
  updateXRDebug({
    note: 'squeezeend event',
    gripHeld: false,
  });
}

function handleXRInput({ frame, session, referenceSpace, deltaTime = 0 }) {
  if (!session || !referenceSpace) {
    return;
  }

  if (xrHintsEnabled && deltaTime > 0) {
    xrHints.update(deltaTime);
  }

  const sources = Array.from(session.inputSources || []);
  if (xrLeftControllerState.inputSource && !sources.includes(xrLeftControllerState.inputSource)) {
    xrLeftControllerState.inputSource = null;
  }

  if (!xrLeftControllerState.inputSource) {
    const preferred = selectPreferredInputSource(sources);
    if (preferred) {
      assignActiveInputSource(preferred, { reason: 'frame-select' });
    }
  }

  const activeSource = xrLeftControllerState.inputSource;

  if (!activeSource) {
    resetLeftControllerState();
    updateXRDebug({
      note: 'no usable input source',
      sources: sources.map((source) => ({
        handedness: source.handedness,
        hasGamepad: Boolean(source.gamepad),
      })),
    });
    return;
  }

  const poseSpace = activeSource.gripSpace || activeSource.targetRaySpace;
  if (!poseSpace) {
    resetLeftControllerState({ keepSource: true });
    updateXRDebug({
      note: 'no pose space',
      handedness: activeSource.handedness,
    });
    return;
  }

  const pose = frame.getPose(poseSpace, referenceSpace);
  if (!pose) {
    resetLeftControllerState({ keepSource: true });
    updateXRDebug({
      note: 'no pose',
      handedness: activeSource.handedness,
    });
    return;
  }

  const { orientation, position } = pose.transform;
  const { gamepad } = activeSource;

  const triggerPressed = xrLeftControllerState.triggerHeld || Boolean(gamepad && gamepad.buttons && gamepad.buttons[0]?.pressed);
  const gripPressed = xrLeftControllerState.gripHeld || Boolean(gamepad && gamepad.buttons && gamepad.buttons[1]?.pressed);

  const euler = orientation ? quaternionToEuler(orientation) : null;
  if (euler && !xrLeftControllerState.lastEuler) {
    xrLeftControllerState.lastEuler = euler;
  }

  if (!triggerPressed) {
    xrLeftControllerState.rotating = false;
    xrLeftControllerState.lastRotatePosition = null;
    if (xrLeftControllerState.showingOrbit) {
      xrLeftControllerState.showingOrbit = false;
    }
  }

  const currentPosition = position ? { x: position.x, y: position.y, z: position.z } : null;

  if (triggerPressed) {
    let rotationHandled = false;
    if (currentPosition) {
      if (xrLeftControllerState.lastRotatePosition) {
        const dxMeters = currentPosition.x - xrLeftControllerState.lastRotatePosition.x;
        const dyMeters = currentPosition.y - xrLeftControllerState.lastRotatePosition.y;
        const dzMeters = currentPosition.z - xrLeftControllerState.lastRotatePosition.z;
        const dx = dxMeters * XR_ROTATION_PIXEL_SCALE;
        const dy = -dyMeters * XR_ROTATION_PIXEL_SCALE;
        if (Number.isFinite(dx) && Number.isFinite(dy)) {
          applyRotationDelta(dx, dy);
          rotationHandled = Math.abs(dx) > 0.0001 || Math.abs(dy) > 0.0001;
        }
        if (Number.isFinite(dzMeters)) {
          if (applyScaleDelta(dzMeters)) {
            showXrHint('Zoom', `${state.controls.scale.toFixed(2)}×`);
          }
        }
      }
      xrLeftControllerState.lastRotatePosition = currentPosition;
      xrLeftControllerState.rotating = rotationHandled || xrLeftControllerState.rotating;
    }

    if (!rotationHandled && euler) {
      if (!xrLeftControllerState.rotating || !xrLeftControllerState.lastEuler) {
        xrLeftControllerState.rotating = true;
      } else {
        const deltaYaw = normalizeAngle(euler.yaw - xrLeftControllerState.lastEuler.yaw);
        const deltaPitch = euler.pitch - xrLeftControllerState.lastEuler.pitch;
        if (Number.isFinite(deltaYaw) && Number.isFinite(deltaPitch)) {
          const dx = deltaYaw / POINTER_ROTATION_SENSITIVITY;
          const dy = deltaPitch / POINTER_ROTATION_SENSITIVITY;
          applyRotationDelta(dx, dy);
          rotationHandled = Math.abs(dx) > 0.0001 || Math.abs(dy) > 0.0001;
        }
      }
    }

    if (rotationHandled) {
      xrLeftControllerState.rotating = true;
      if (!xrLeftControllerState.showingOrbit) {
        showXrHint('Orbit / Zoom');
        xrLeftControllerState.showingOrbit = true;
      }
    }
  }

  if (euler) {
    xrLeftControllerState.lastEuler = euler;
  }

  if (currentPosition) {
    if (gripPressed) {
      if (!xrLeftControllerState.dragging || !xrLeftControllerState.lastPosition) {
        xrLeftControllerState.dragging = true;
      } else {
        const dxMeters = currentPosition.x - xrLeftControllerState.lastPosition.x;
        const dyMeters = currentPosition.y - xrLeftControllerState.lastPosition.y;
        const dzMeters = currentPosition.z - xrLeftControllerState.lastPosition.z;
        const dx = dxMeters * XR_TRANSLATION_PIXEL_SCALE;
        const dy = -dyMeters * XR_TRANSLATION_PIXEL_SCALE;
        if (Number.isFinite(dx) && Number.isFinite(dy)) {
          if (applyTranslationDelta(dx, dy)) {
            showXrHint('Pan');
          }
        }
        if (Number.isFinite(dzMeters) && Math.abs(dzMeters) > 0.00001) {
          const dz = dzMeters * XR_TRANSLATION_Z_SCALE;
          applyTranslationZDelta(dz);
        }
      }
      xrLeftControllerState.lastPosition = currentPosition;
    } else {
      xrLeftControllerState.dragging = false;
      xrLeftControllerState.lastPosition = currentPosition;
    }
  } else {
    xrLeftControllerState.dragging = false;
    xrLeftControllerState.lastPosition = null;
  }

  const stick = getDominantStick(gamepad);
  if (Math.abs(stick.x) > XR_STICK_DEADZONE) {
    if (applyFovDelta(stick.x * XR_FOV_DELTA_PER_FRAME)) {
      showXrHint('Geometry FOV', `${state.meshConfig.geomFov.toFixed(0)}°`);
    }
  }
  if (Math.abs(stick.y) > XR_STICK_DEADZONE) {
    if (applyMagnificationDelta(-stick.y * XR_MAG_DELTA_PER_FRAME)) {
      showXrHint('Depth Magnification', `${state.options.magnification.toFixed(2)}×`);
    }
  }

  xrLeftControllerState.farAdjust = computeFarAdjust(gamepad);
  if (deltaTime > 0 && xrLeftControllerState.farAdjust !== 0) {
    applyFarClipDelta(xrLeftControllerState.farAdjust * XR_FAR_DELTA_PER_SEC * deltaTime);
  }

  updateXRDebug({
    handedness: activeSource.handedness,
    hasGamepad: Boolean(gamepad),
    buttons: gamepad ? gamepad.buttons.map((button) => ({
      value: button.value,
      pressed: button.pressed,
    })) : null,
    axes: gamepad ? [...gamepad.axes] : null,
    triggerPressed,
    gripPressed,
    stickX: stick.x,
    stickY: stick.y,
    stickPair: stick.pair,
    rotation: { ...xrLeftControllerState.lastEuler },
    position: xrLeftControllerState.lastPosition ? { ...xrLeftControllerState.lastPosition } : null,
    rotating: xrLeftControllerState.rotating,
    dragging: xrLeftControllerState.dragging,
    triggerHeld: xrLeftControllerState.triggerHeld,
    gripHeld: xrLeftControllerState.gripHeld,
    sourceCount: sources.length,
    geomFov: state.meshConfig.geomFov,
    magnification: state.options.magnification,
    scale: state.controls.scale,
    translation: {
      x: state.controls.translationX,
      y: state.controls.translationY,
      z: state.controls.translationZ,
    },
    farClip: state.options.farClip,
    farAdjust: xrLeftControllerState.farAdjust,
  });
}

function quaternionToEuler(q) {
  if (!q) {
    return null;
  }
  const { x, y, z, w } = q;
  const sinrCosp = 2 * (w * x + y * z);
  const cosrCosp = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinrCosp, cosrCosp);

  const sinp = 2 * (w * y - z * x);
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);

  const sinyCosp = 2 * (w * z + x * y);
  const cosyCosp = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(sinyCosp, cosyCosp);

  return { roll, pitch, yaw };
}

function normalizeAngle(angle) {
  if (!Number.isFinite(angle)) {
    return 0;
  }
  const twoPi = Math.PI * 2;
  let value = angle;
  while (value <= -Math.PI) {
    value += twoPi;
  }
  while (value > Math.PI) {
    value -= twoPi;
  }
  return value;
}

function attachDropListeners() {
  ['dragenter', 'dragover'].forEach((type) => {
    window.addEventListener(type, (event) => {
      event.preventDefault();
      dropHint.classList.remove('hidden');
    });
  });

  ['dragleave', 'drop'].forEach((type) => {
    window.addEventListener(type, (event) => {
      event.preventDefault();
      dropHint.classList.add('hidden');
      if (type === 'drop') {
        handleFiles(event.dataTransfer.files);
      }
    });
  });
}

function resetView() {
  state.controls.rotationX = 0;
  state.controls.rotationY = 0;
  state.controls.translationX = 0;
  state.controls.translationY = 0;
  state.controls.translationZ = 0;
  state.controls.scale = state.initialScale;
  state.options.magnification = MAG_DEFAULT;
  state.options.mode = 'linear';
  state.options.logPower = 1;
  state.options.farClip = FAR_MAX;
  state.camera.fov = FOV_DEFAULT;
  magnificationInput.value = String(magnificationToSlider(state.options.magnification));
  depthModeInput.checked = false;
  logPowerInput.value = '1';
  logPowerInput.disabled = true;
  zOffsetInput.value = '0.00';
  fovInput.value = String(FOV_DEFAULT);
  updateBinding('magnificationValue', state.options.magnification.toFixed(2));
  updateBinding('zOffsetValue', '0.00');
  updateBinding('depthMode', 'Linear');
  updateBinding('logPowerValue', '1.00');
  farClipInput.value = String(farClipToSlider(state.options.farClip));
  updateBinding('farClipValue', formatFarClip(state.options.farClip));
  updateBinding('fovValue', String(Math.round(state.camera.fov)));
}

function initMirrorPanel() {
  if (!mirrorPanel) return;
  mirrorPanel.innerHTML = panel.innerHTML;
  mirrorBindings.clear();
  syncControls.clear();
  mirrorControls.clear();

  panel.querySelectorAll('[data-sync]').forEach((node) => {
    const key = node.dataset.sync;
    if (key) {
      syncControls.set(key, node);
    }
  });

  mirrorPanel.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
  mirrorPanel.querySelectorAll('label[for]').forEach((node) => node.removeAttribute('for'));
  mirrorPanel.querySelectorAll('[data-bind]').forEach((node) => {
    const key = node.getAttribute('data-bind');
    if (key) {
      mirrorBindings.set(key, node);
    }
  });
  mirrorPanel.querySelectorAll('[data-sync]').forEach((node) => {
    const key = node.dataset.sync;
    if (key) {
      mirrorControls.set(key, node);
    }
  });
  mirrorPanel.querySelectorAll('input, select, button, textarea').forEach((node) => {
    node.setAttribute('tabindex', '-1');
    node.setAttribute('aria-hidden', 'true');
  });
  syncMirrorControls();
}

function setDisplayMode(mode) {
  const stereoMode = mode === 'sbs' ? 'sbs' : 'mono';
  state.stereo.mode = stereoMode;
  displayModeInput.value = stereoMode;
  const isStereo = stereoMode === 'sbs';
  document.body.classList.toggle('sbs-active', isStereo);
  stereoSeparationInput.disabled = !isStereo;
  stereoSeparationInput.value = state.stereo.separation.toFixed(3);
  swapEyesInput.disabled = !isStereo;
  swapEyesInput.checked = state.stereo.swapEyes;
  syncMirrorControls();
  syncMirrorScroll();
  updateMirrorVisibility();
  requestRender();
}

function setupXR() {
  if (!enterVrButton || !enterLookingGlassButton) {
    return;
  }
  if (showXrHintsInput) {
    xrHintsEnabled = showXrHintsInput.checked;
    showXrHintsInput.addEventListener('change', (event) => {
      xrHintsEnabled = event.target.checked;
      if (!xrHintsEnabled) {
        xrHints.onSessionEnd();
      } else if (state.xr.active && state.xr.mode === 'vr') {
        xrHints.onSessionStart();
      }
    });
  }
  xrManager = new WebXRManager({
    renderer,
    canvas,
    getModelMatrix: () => computeModelMatrix(),
    onStatus: (label) => {
      state.xr.status = label;
      updateBinding('xrStatus', label);
    },
    onStateChange: (updates) => {
      const prevActive = state.xr.active;
      const prevMode = state.xr.mode;
      state.xr = { ...state.xr, ...updates };
      if (state.xr.mode !== prevMode) {
        // Looking Glass places the model relative to its hologram volume.
        invalidateModelMatrix();
        if (state.xr.mode === 'looking-glass') {
          showStatus(
            `Looking Glass: model front at z ${LOOKING_GLASS_MODEL_FRONT_Z.toFixed(2)}; frame ${describeLookingGlassFrame()}`,
            5000,
          );
        }
      }
      if (!state.xr.supported && !state.xr.active) {
        state.xr.status = 'WebXR unavailable';
        updateBinding('xrStatus', state.xr.status);
      }
      updateXRButtons();
      if (state.xr.active) {
        setUiHidden(true);
        if (state.xr.mode === 'vr' && xrHintsEnabled && (!prevActive || prevMode !== 'vr')) {
          xrHints.onSessionStart();
        }
        if (state.xr.mode !== 'vr') {
          xrHints.onSessionEnd();
        }
      } else {
        setUiHidden(false);
        resetLeftControllerState();
        updateXRDebug({ note: 'xr session inactive' });
        xrHints.onSessionEnd();
        requestRender();
      }
    },
    onInputFrame: (payload) => {
      handleXRInput(payload);
    },
    onInputSourcesChange: handleXRInputSourcesChange,
    onSelectStart: handleXRSelectStart,
    onSelectEnd: handleXRSelectEnd,
    onSqueezeStart: handleXRSqueezeStart,
    onSqueezeEnd: handleXRSqueezeEnd,
    onAfterViewRender: ({ viewMatrix, projectionMatrix, viewport, position, orientation }) => {
      if (!xrHintsEnabled || state.xr.mode !== 'vr') {
        return;
      }
      xrHints.draw({ viewMatrix, projectionMatrix, viewport, position, orientation });
    },
  });

  if (typeof window !== 'undefined') {
    window.xrManager = xrManager;
  }

  enterVrButton.addEventListener('click', () => {
    if (state.xr.active && state.xr.mode === 'vr') {
      xrManager.exit();
    } else {
      handleEnterVr();
    }
  });

  // Fetching the Looking Glass bundle inside the click handler spends the user
  // activation its display window needs, which is why the first attempt always
  // failed and the second always worked. Warming it beforehand costs nothing and
  // has no global effect until the polyfill is actually constructed.
  const warmLookingGlass = () => { void xrManager.preloadLookingGlassModule(); };
  enterLookingGlassButton.addEventListener('pointerenter', warmLookingGlass, { once: true });
  enterLookingGlassButton.addEventListener('pointerdown', warmLookingGlass, { once: true });

  enterLookingGlassButton.addEventListener('click', () => {
    if (state.xr.active && state.xr.mode === 'looking-glass') {
      xrManager.exit();
    } else {
      handleEnterLookingGlass();
    }
  });

  xrManager.detectSupport().finally(() => {
    updateXRButtons();
  });
}

function updateXRButtons() {
  if (!enterVrButton || !enterLookingGlassButton) return;
  const active = state.xr.active;
  const mode = state.xr.mode;

  if (active && mode === 'vr') {
    enterVrButton.textContent = 'Exit VR Session';
    enterVrButton.disabled = false;
    enterLookingGlassButton.disabled = true;
  } else {
    enterVrButton.textContent = 'Enter VR';
    enterLookingGlassButton.disabled = false;
  }

  if (active && mode === 'looking-glass') {
    enterLookingGlassButton.textContent = 'Exit Looking Glass';
    enterLookingGlassButton.disabled = false;
    enterVrButton.disabled = true;
  } else {
    enterLookingGlassButton.textContent = 'Enter Looking Glass';
    if (!active) {
      enterVrButton.disabled = !state.xr.supported;
    }
  }

  if (!active && !state.xr.supported) {
    enterVrButton.disabled = true;
  }

  if (state.xr.lookingGlassError) {
    updateBinding('xrStatus', `Looking Glass error: ${state.xr.lookingGlassError}`);
  }
}

async function handleEnterVr() {
  if (!xrManager) return;
  const success = await xrManager.enterVR();
  if (!success) {
    showStatus('Unable to start VR session.', 4000);
  }
}

// Where content sits inside a Looking Glass frame is the display's own business,
// not the model's: the polyfill frames a volume of `targetDiam` around
// `targetX/Y/Z` and renders it with `fovy`. Nudging the model instead only moves
// it within a frame that is already fixed, which is why hand-tuned model offsets
// had no visible effect. These are exposed on the URL so the framing can be
// settled against real hardware, for example
// `?lgTargetY=-0.5&lgTargetDiam=4`.
const LOOKING_GLASS_CONFIG_KEYS = ['targetX', 'targetY', 'targetZ', 'targetDiam', 'fovy'];
// The library's own default size, restated here so that resetting the frame for
// a new picture restores every value the viewer may have moved, not just the
// ones this project overrides.
const LOOKING_GLASS_TARGET_DIAM = 2;

function lookingGlassFrameDefaults() {
  return {
    targetX: 0,
    targetY: LOOKING_GLASS_TARGET_Y,
    targetZ: LOOKING_GLASS_TARGET_Z,
    targetDiam: LOOKING_GLASS_TARGET_DIAM,
  };
}

function lookingGlassConfigFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const config = {};
  for (const key of LOOKING_GLASS_CONFIG_KEYS) {
    const raw = params.get(`lg${key.charAt(0).toUpperCase()}${key.slice(1)}`);
    if (raw === null) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) config[key] = value;
  }
  return config;
}

async function handleEnterLookingGlass() {
  if (!xrManager) return;
  // A new picture gets the starting frame back, because the right framing is
  // strongly scene-dependent and carrying the previous one over is almost
  // always wrong. Re-entering with the same picture keeps whatever was just
  // adjusted in the Looking Glass window.
  const resetFrame = state.lookingGlassFrameStale !== false;
  // Only the depth of the hologram volume generalises across scenes; two very
  // different pictures settled within 0.03 of each other on a Looking Glass Go.
  // Its height and size did not, varying by a factor of two and more, and an
  // attempt to derive them from the model's bounds disagreed with the measured
  // values in both magnitude and sign. They are left to the URL rather than
  // guessed at.
  const overrides = { ...lookingGlassFrameDefaults(), ...lookingGlassConfigFromUrl() };
  const success = await xrManager.enterLookingGlass(overrides, { resetFrame });
  if (success) {
    state.lookingGlassFrameStale = false;
  } else {
    showStatus('Looking Glass session could not start.', 4000);
  }
}

function syncMirrorControls() {
  if (!mirrorPanel) return;
  mirrorControls.forEach((mirrorNode, key) => {
    const sourceNode = syncControls.get(key);
    if (!sourceNode || !mirrorNode) return;
    if (mirrorNode.tagName === 'INPUT') {
      const input = mirrorNode;
      if (input.type === 'checkbox') {
        input.checked = sourceNode.checked;
      } else if (sourceNode.type !== 'file') {
        input.value = sourceNode.value;
        input.disabled = sourceNode.disabled;
        input.classList.toggle('is-disabled', sourceNode.disabled);
      }
      if (sourceNode.type === 'checkbox') {
        input.disabled = sourceNode.disabled;
      }
      if (sourceNode.type === 'file') {
        input.disabled = true;
      }
    } else if (mirrorNode.tagName === 'SELECT') {
      mirrorNode.value = sourceNode.value;
      mirrorNode.disabled = sourceNode.disabled;
    }
  });
  const sourceButtons = panel.querySelectorAll('button');
  const mirrorButtons = mirrorPanel.querySelectorAll('button');
  mirrorButtons.forEach((button, index) => {
    const source = sourceButtons[index];
    if (source) {
      button.textContent = source.textContent;
      button.disabled = source.disabled;
    }
  });
}

function syncMirrorScroll() {
  if (!mirrorPanel) return;
  mirrorPanel.scrollTop = panel.scrollTop;
}

function setUiHidden(hidden) {
  state.uiHidden = hidden;
  panel.classList.toggle('hidden', hidden);
  const label = hidden ? 'Show UI' : 'Hide UI';
  toggleButton.textContent = label;
  if (mirrorPanel && hidden) {
    mirrorPanel.classList.remove('visible');
  }
  if (mirrorToggleButton) {
    mirrorToggleButton.textContent = label;
  }
  syncMirrorControls();
  syncMirrorScroll();
  updateMirrorVisibility();
}

function updateMirrorVisibility() {
  if (mirrorPanel) {
    const showPanel = state.stereo.mode === 'sbs' && !state.uiHidden;
    mirrorPanel.classList.toggle('visible', showPanel);
    mirrorPanel.classList.toggle('hidden', !showPanel);
  }
  if (mirrorToggleButton) {
    const showToggle = state.stereo.mode === 'sbs';
    mirrorToggleButton.classList.toggle('visible', showToggle);
    mirrorToggleButton.textContent = toggleButton.textContent;
    mirrorToggleButton.disabled = !showToggle;
  }
}

function describeLookingGlassFrame() {
  const config = xrManager?.lookingGlassConfig;
  if (!config) return 'targetDiam 3 (defaults)';
  const parts = LOOKING_GLASS_CONFIG_KEYS.map((key) => {
    const value = Number(config[key]);
    return Number.isFinite(value) ? `${key} ${value.toFixed(2)}` : null;
  }).filter(Boolean);
  return parts.length ? parts.join(', ') : 'defaults';
}

function lookingGlassAutoTranslationZ() {
  const info = state.displayBounds;
  if (!info) return state.autoTranslationZ;
  return clamp(LOOKING_GLASS_MODEL_FRONT_Z - info.maxZ, -20, 20);
}

function buildModelMatrix(autoZ, into = mat4.identity()) {
  const model = into;
  const translateZ = state.controls.translationZ + autoZ;
  mat4.identityInto(model);
  mat4.translateInPlace(model, [state.controls.translationX, state.controls.translationY, translateZ]);
  mat4.translateInPlace(model, [0, 0, state.pivotZ]);
  mat4.rotateYInPlace(model, state.controls.rotationY);
  mat4.rotateXInPlace(model, state.controls.rotationX);
  mat4.scaleInPlace(model, state.controls.scale);
  mat4.translateInPlace(model, [0, 0, -state.pivotZ]);
  return model;
}

function computeModelMatrix() {
  if (!state.render.modelMatrixDirty) {
    return state.render.modelMatrix;
  }
  const autoZ = state.xr.mode === 'looking-glass'
    ? lookingGlassAutoTranslationZ()
    : state.autoTranslationZ;
  buildModelMatrix(autoZ, state.render.modelMatrix);
  state.render.modelMatrixDirty = false;
  return state.render.modelMatrix;
}

function renderScene() {
  if (!state.xr.active) {
    renderer.gl.bindFramebuffer(renderer.gl.FRAMEBUFFER, null);
  }
  if (!state.xr.active && state.mesh) {
    const width = canvas.width;
    const height = canvas.height;
    const monoAspect = width / height;
    const stereoAspect = (width / 2) / height;
    const farClip = Number.isFinite(state.options.farClip) ? state.options.farClip : FAR_MAX;
    const farPlane = Math.max(farClip * state.controls.scale * 1.5, 1000);
    const fovRadians = (state.camera.fov * Math.PI) / 180;
    const isStereo = state.stereo.mode === 'sbs';
    const nearPlane = 0.01;
    const projection = mat4.perspective(
      fovRadians,
      isStereo ? stereoAspect : monoAspect,
      nearPlane,
      farPlane
    );

    const baseView = mat4.identity();
    const model = computeModelMatrix();

    if (!isStereo) {
      renderer.render(model, baseView, projection, {
        viewport: [0, 0, width, height],
        clearColor: true,
        clearDepth: true,
      });
    } else {
      const halfWidth = Math.floor(width / 2);
      const eyeSeparation = clamp(state.stereo.separation, STEREO_MIN, STEREO_MAX);
      const convergence = computeStereoConvergenceDistance(model);
      const top = Math.tan(fovRadians / 2) * nearPlane;
      const right = top * stereoAspect;
      const frustumShift = (eyeSeparation * 0.5 * nearPlane) / convergence;
      const leftProjection = mat4.frustum(
        -right + frustumShift,
        right + frustumShift,
        -top,
        top,
        nearPlane,
        farPlane,
      );
      const rightProjection = mat4.frustum(
        -right - frustumShift,
        right - frustumShift,
        -top,
        top,
        nearPlane,
        farPlane,
      );
      const leftCam = -eyeSeparation / 2;
      const rightCam = eyeSeparation / 2;
      const leftView = mat4.translate(baseView, [-leftCam, 0, 0]);
      const rightView = mat4.translate(baseView, [-rightCam, 0, 0]);
      const leftViewport = [0, 0, halfWidth, height];
      const rightViewport = [halfWidth, 0, width - halfWidth, height];

      const eyes = state.stereo.swapEyes
        ? [
            { view: rightView, projection: rightProjection, viewport: leftViewport },
            { view: leftView, projection: leftProjection, viewport: rightViewport },
          ]
        : [
            { view: leftView, projection: leftProjection, viewport: leftViewport },
            { view: rightView, projection: rightProjection, viewport: rightViewport },
          ];

      renderer.render(model, eyes[0].view, eyes[0].projection, {
        viewport: eyes[0].viewport,
        clearColor: true,
        clearDepth: true,
      });
      renderer.render(model, eyes[1].view, eyes[1].projection, {
        viewport: eyes[1].viewport,
        clearColor: false,
        clearDepth: true,
      });
    }
  } else if (!state.xr.active) {
    renderer.gl.clear(renderer.gl.COLOR_BUFFER_BIT | renderer.gl.DEPTH_BUFFER_BIT);
  }
}

function updateBinding(key, value) {
  const element = bindings[key];
  if (element) {
    element.textContent = value;
  }
  const mirror = mirrorBindings.get(key);
  if (mirror) {
    mirror.textContent = value;
  }
}

let statusTimer = null;
function showStatus(message, timeout = 2000) {
  statusBox.textContent = message;
  statusBox.classList.add('visible');
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  if (timeout > 0) {
    statusTimer = setTimeout(() => {
      statusBox.classList.remove('visible');
    }, timeout);
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getMetadataVerticalFov(metadata) {
  const value = metadata?.verticalFovDeg;
  return Number.isFinite(value) ? value : null;
}

function normalizeMeshQuality(value) {
  const number = Number(value);
  return MESH_QUALITY_OPTIONS.has(number) ? number : MESH_QUALITY_DEFAULT;
}

function getMeshTarget() {
  return MESH_TARGET_BASE * state.meshConfig.qualityMultiplier;
}

function setMeshQuality(value, { rebuild = false } = {}) {
  const multiplier = normalizeMeshQuality(value);
  if (state.meshConfig.qualityMultiplier === multiplier && !rebuild) {
    return;
  }
  state.meshConfig.qualityMultiplier = multiplier;
  if (meshQualityInput && meshQualityInput.value !== String(multiplier)) {
    meshQualityInput.value = String(multiplier);
  }
  if (rebuild) {
    rebuildMeshDensity();
  }
}

function rebuildMeshDensity() {
  if (!state.rgbde) {
    showStatus(`Mesh quality ${state.meshConfig.qualityMultiplier}x will apply to the next RGBDE file.`, 2500);
    return;
  }
  const { width, height } = state.rgbde;
  const meshSize = findBestMeshSize(width, height, getMeshTarget());
  if (!meshSize.meshX || !meshSize.meshY) {
    showStatus('Unable to determine mesh density for this image.', 4000);
    return;
  }
  state.meshConfig.meshX = meshSize.meshX;
  state.meshConfig.meshY = meshSize.meshY;
  rebuildMesh({ preserveView: true });
  const cells = meshSize.meshX * meshSize.meshY;
  showStatus(`Mesh quality ${state.meshConfig.qualityMultiplier}x (${formatMeshCount(cells)} cells)`, 2500);
}

function formatMeshCount(value) {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(Math.round(value));
}

function formatFarClip(value) {
  if (!Number.isFinite(value)) return '∞';
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

// The slider is logarithmic across 0.1 to 100, so 1 sits a third of the way
// along. With a hundred steps that is position 33.33, which no step can reach:
// the neighbours are 0.98 and 1.05, and the one value that means "the scene at
// its own metric depth" was not selectable. Three hundred steps put it exactly
// on 100, and give finer control everywhere else as a side effect.
const MAG_SLIDER_STEPS = 300;

function sliderToMagnification(sliderValue) {
  const t = clamp(sliderValue, 0, MAG_SLIDER_STEPS) / MAG_SLIDER_STEPS;
  const ratio = MAG_MAX / MAG_MIN;
  return MAG_MIN * Math.pow(ratio, t);
}

function magnificationToSlider(magnification) {
  const mag = clamp(magnification, MAG_MIN, MAG_MAX);
  const ratio = Math.log(MAG_MAX / MAG_MIN);
  const t = Math.log(mag / MAG_MIN) / ratio;
  return Math.round(t * MAG_SLIDER_STEPS);
}

function sliderToFarClip(sliderValue) {
  const t = clamp(sliderValue, 0, 100) / 100;
  if (t <= 1 / 3) {
    const f = t / (1 / 3);
    return 10 * f;
  }
  if (t <= 2 / 3) {
    const f = (t - 1 / 3) / (1 / 3);
    return 10 * Math.pow(10, f);
  }
  const f = (t - 2 / 3) / (1 / 3);
  return 100 * Math.pow(10, f);
}

function farClipToSlider(distance) {
  const value = clamp(distance, 0, FAR_MAX);
  if (value <= 10) {
    const f = value / 10;
    return Math.round(f * (100 / 3));
  }
  if (value <= 100) {
    const f = Math.log10(value / 10);
    return Math.round((100 / 3) * (1 + f));
  }
  const f = Math.log10(value / 100);
  return Math.round((100 / 3) * (2 + f));
}

function computeBounds(positions) {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  const sizeX = maxX - minX;
  const sizeY = maxY - minY;
  const sizeZ = maxZ - minZ;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const maxSpan = Math.max(sizeX, sizeY, sizeZ);
  const radius = Math.max(sizeX, sizeY) * 0.5;

  return { minX, maxX, minY, maxY, minZ, maxZ, sizeX, sizeY, sizeZ, centerX, centerY, centerZ, maxSpan, radius };
}

function computeBaseBounds(mesh) {
  const { rayDirections, baseDepths, baseMinZ, baseMaxZ } = mesh;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < baseDepths.length; i++) {
    const depth = baseDepths[i];
    const dirX = rayDirections[i * 3];
    const dirY = rayDirections[i * 3 + 1];
    const x = dirX * depth;
    const y = dirY * depth;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const sizeX = maxX - minX;
  const sizeY = maxY - minY;
  const sizeZ = baseMaxZ - baseMinZ;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (baseMinZ + baseMaxZ) / 2;
  return {
    minX,
    maxX,
    minY,
    maxY,
    minZ: baseMinZ,
    maxZ: baseMaxZ,
    sizeX,
    sizeY,
    sizeZ,
    centerX,
    centerY,
    centerZ,
    maxSpan: Math.max(sizeX, sizeY, sizeZ),
    radius: Math.max(sizeX, sizeY) * 0.5,
  };
}

function computeStereoConvergenceDistance(modelMatrix) {
  const bounds = state.displayBounds || state.baseBounds;
  if (!bounds) {
    return 2;
  }
  const [,, z] = mat4.transformPoint(modelMatrix, [
    bounds.centerX || 0,
    bounds.centerY || 0,
    bounds.centerZ || 0,
  ]);
  return Math.max(STEREO_CONVERGENCE_MIN, -z);
}

function calculateInitialScale(bounds) {
  const span = Math.max(bounds.sizeX, bounds.sizeY);
  const targetSpan = 4.0;
  const scale = span > 0 ? targetSpan / span : 1;
  return clamp(scale, 0.5, 12);
}

function setReconstructionFov(value, { rebuild = false, preserveView = true } = {}) {
  const clamped = clamp(value, GEOM_FOV_MIN, GEOM_FOV_MAX);
  state.meshConfig.geomFov = clamped;
  if (geomFovInput.value !== String(clamped)) {
    geomFovInput.value = String(clamped);
  }
  updateBinding('geomFovValue', Math.round(clamped).toString());
  if (rebuild && state.mesh) {
    rebuildMesh({ preserveView, skipReset: !preserveView });
  }
}

function rebuildMesh({ preserveView = true, skipReset = false } = {}) {
  if (!state.rgbde) return;
  const { width, height, depth, depthStats, textureImage } = state.rgbde;
  const { meshX, meshY, geomFov } = state.meshConfig;
  if (!meshX || !meshY) return;

  const mesh = generatePerspectiveMesh({
    depth,
    width,
    height,
    meshX,
    meshY,
    depthMin: depthStats.min,
    depthMax: depthStats.max,
    centerZ: state.centerZ,
    fovDegrees: geomFov,
  });

  state.mesh = mesh;
  renderer.updateGeometry(mesh);
  renderer.setDepthOptions(mesh, state.options);
  renderer.setTexture(textureImage);
  updateGlbButtonState();
  state.baseBounds = computeBaseBounds(mesh);
  state.initialScale = calculateInitialScale(state.baseBounds);

  if (preserveView) {
    updateDepthTransform();
  } else {
    if (!skipReset) {
      resetView();
    }
    updateDepthTransform({ resetTranslation: true });
  }
}

function refreshAutoFit({ bounds, resetTranslation = false } = {}) {
  if (!state.mesh) return;
  let info = bounds;
  if (!info) {
    if (state.baseBounds) {
      info = state.baseBounds;
    } else {
      info = computeBounds(state.mesh.positions);
    }
  }
  state.displayBounds = info;

  const depthRange = Math.max(info.maxZ - info.minZ, 0.001);
  const pivotOffset = Math.min(1.0, depthRange * 0.15);
  state.pivotZ = clamp(info.maxZ - pivotOffset, info.minZ, info.maxZ);

  const prevAuto = state.autoTranslationZ;
  const newAuto = clamp(DESIRED_NEAR - info.maxZ, -20, 20);
  state.autoTranslationZ = newAuto;

  if (resetTranslation) {
    state.controls.translationZ = 0;
    zOffsetInput.value = '0.00';
    updateBinding('zOffsetValue', '0.00');
  } else {
    const delta = prevAuto - newAuto;
    if (Math.abs(delta) > 1e-6) {
      let adjusted = state.controls.translationZ + delta;
      adjusted = clamp(adjusted, -MAX_Z_OFFSET, MAX_Z_OFFSET);
      state.controls.translationZ = adjusted;
      zOffsetInput.value = adjusted.toFixed(2);
      updateBinding('zOffsetValue', adjusted.toFixed(2));
    }
  }
  invalidateModelMatrix();
}

function applyInitialView() {
  if (!state.mesh) return;
  const bounds = state.baseBounds || computeBounds(state.mesh.positions);
  state.initialScale = calculateInitialScale(bounds);
  state.controls.scale = state.initialScale;

  refreshAutoFit({ bounds, resetTranslation: true });
}

init();
