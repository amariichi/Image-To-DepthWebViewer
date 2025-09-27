import {
  decodeRgbdeFile,
  findBestMeshSize,
  generatePerspectiveMesh,
  updateVertexPositions,
  DEFAULT_CENTER_Z,
} from './geometry.js';
import { createRenderer, mat4 } from './rendering.js';

const sourceInput = document.getElementById('source-input');
const generateButton = document.getElementById('generate-depth');
const saveButton = document.getElementById('save-rgbde');
const canvas = document.getElementById('glCanvas');
const toggleButton = document.getElementById('toggle-ui');
const mirrorToggleButton = document.getElementById('toggle-ui-mirror');
const panel = document.getElementById('control-panel');
const fileInput = document.getElementById('file-input');
const openDialogButton = document.getElementById('open-dialog');
const geomFovInput = document.getElementById('geom-fov');
const displayModeInput = document.getElementById('display-mode');
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

const API_BASE = window.__RGBDE_API_BASE__ || 'http://localhost:8000';

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
};

const mirrorBindings = new Map();
const syncControls = new Map();
const mirrorControls = new Map();

const MAX_Z_OFFSET = 5;
const MIN_SCALE = 0.05;
const MAX_SCALE = 25;
const DESIRED_NEAR = -2.0;
const MAG_MIN = 0.1;
const MAG_MAX = 100;
const MAG_DEFAULT = 0.5;
const FAR_MAX = 1000;
const FAR_MIN = 1;
const FAR_AUTO_EXPANSION = 10;
const GEOM_FOV_MIN = 15;
const GEOM_FOV_MAX = 120;
const GEOM_FOV_DEFAULT = 60;
const FOV_MIN = 15;
const FOV_MAX = 120;
const FOV_DEFAULT = 60;
const GENERATE_LABEL_DEFAULT = 'Generate Depth';
const GENERATE_LABEL_BUSY = 'Generating…';
const SAVE_LABEL_GENERATED = 'Save RGBDE';
const SAVE_LABEL_EXISTING = 'Download RGBDE';
const STEREO_MIN = 0;
const STEREO_MAX = 0.1;
const STEREO_DEFAULT = 0.02;

let renderer;
try {
  renderer = createRenderer(canvas);
} catch (error) {
  showStatus(error.message, 0);
  throw error;
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
  centerZ: DEFAULT_CENTER_Z,
  initialScale: 1.0,
  autoTranslationZ: 0.0,
  pivotZ: 0.0,
  backend: {
    available: false,
    device: null,
    checking: false,
    note: null,
  },
  asset: {
    blob: null,
    filename: null,
    source: null,
  },
  processing: false,
  uiHidden: false,
  sourceLabel: 'No file selected',
};

function init() {
  attachUIListeners();
  attachPointerListeners();
  attachDropListeners();
  window.addEventListener('resize', resizeCanvas);
  saveButton.disabled = true;
  generateButton.disabled = true;
  generateButton.textContent = GENERATE_LABEL_DEFAULT;
  updateSaveButtonState();
  setReconstructionFov(state.meshConfig.geomFov, { rebuild: false });
  initMirrorPanel();
  setDisplayMode(state.stereo.mode);
  setUiHidden(false);
  stereoSeparationInput.value = state.stereo.separation.toFixed(3);
  swapEyesInput.checked = state.stereo.swapEyes;
  setSourceLabel(state.sourceLabel);
  updateBinding('stereoValue', state.stereo.separation.toFixed(3));
  checkBackend();
  resetView();
  resizeCanvas();
  requestAnimationFrame(renderLoop);
}

function resizeCanvas() {
  renderer.resize(window.innerWidth, window.innerHeight);
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
  try {
    showStatus('Loading…');
    const data = await decodeRgbdeFile(file);
    state.rgbde = data;
    state.is360 = /\.360\./i.test(file.name);
    const { width, height } = data;
    const meshSize = findBestMeshSize(width, height);
    if (!meshSize.meshX || !meshSize.meshY) {
      throw new Error('Unable to determine mesh density for this image.');
    }
    if (state.is360) {
      showStatus('360° RGBDE files are displayed using planar reconstruction (spherical mode not yet implemented).', 4000);
    }
    state.meshConfig.meshX = meshSize.meshX;
    state.meshConfig.meshY = meshSize.meshY;
    const currentGeomFov = clamp(state.meshConfig.geomFov, GEOM_FOV_MIN, GEOM_FOV_MAX);
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
    console.info('Mesh depth sample', mesh.baseDepths.slice(0, 10));
    renderer.updateGeometry(mesh);
    renderer.setTexture(data.textureImage);
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
    showStatus(`Loaded ${file.name} (${width}×${height})`);
    return true;
  } catch (error) {
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
    return;
  }
  saveButton.disabled = false;
  if (state.asset.source === 'generated') {
    saveButton.textContent = SAVE_LABEL_GENERATED;
  } else {
    saveButton.textContent = SAVE_LABEL_EXISTING;
  }
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

function setProcessing(isProcessing) {
  state.processing = isProcessing;
  generateButton.disabled = !state.backend.available || isProcessing;
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
  } catch (error) {
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
  state.backend.checking = true;
  updateBackendStatus();
  try {
    const response = await fetch(`${API_BASE}/api/status`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('Status check failed');
    }
    const data = await response.json();
    state.backend.available = true;
    state.backend.device = data.device || 'unknown';
  } catch (error) {
    console.warn('Backend status check failed', error);
    state.backend.available = false;
    state.backend.device = null;
  } finally {
    state.backend.checking = false;
    if (!state.backend.available) {
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
  updateVertexPositions(state.mesh, state.options);
  renderer.updatePositions(state.mesh);
  refreshAutoFit({ resetTranslation: Boolean(options.resetTranslation) });
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
  });

  swapEyesInput.addEventListener('change', (event) => {
    state.stereo.swapEyes = Boolean(event.target.checked);
    syncMirrorControls();
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

  fovInput.addEventListener('input', (event) => {
    const value = Number(event.target.value);
    const clamped = clamp(value, FOV_MIN, FOV_MAX);
    if (clamped !== value) {
      event.target.value = String(clamped);
    }
    state.camera.fov = clamped;
    updateBinding('fovValue', Math.round(clamped).toString());
    syncMirrorControls();
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
      const sensitivity = (Math.PI / 180) * 0.04;
      const maxAngle = Math.PI / 6;
      state.controls.rotationY = clamp(state.controls.rotationY + dx * sensitivity, -maxAngle, maxAngle);
      state.controls.rotationX = clamp(state.controls.rotationX + dy * sensitivity, -maxAngle, maxAngle);
      state.interaction.lastX = event.clientX;
      state.interaction.lastY = event.clientY;
    }
    if (state.interaction.dragging) {
      const dx = event.clientX - state.interaction.lastX;
      const dy = event.clientY - state.interaction.lastY;
      const sizeFactor = state.baseBounds ? Math.max(state.baseBounds.sizeX, state.baseBounds.sizeY, 0.1) : 1;
      const movementScale = Math.min(sizeFactor + 0.3, 10);
      const factor = 0.0003 * movementScale * (state.controls.scale + 0.2);
      state.controls.translationX += dx * factor;
      state.controls.translationY -= dy * factor;
      state.interaction.lastX = event.clientX;
      state.interaction.lastY = event.clientY;
    }
  }, { passive: true });

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.001);
    state.controls.scale = clamp(state.controls.scale * factor, MIN_SCALE, MAX_SCALE);
  }, { passive: false });

  canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });

  canvas.addEventListener('dblclick', () => {
    setReconstructionFov(GEOM_FOV_DEFAULT, { rebuild: true, preserveView: false });
    resetView();
    state.controls.scale = state.initialScale;
    state.controls.translationZ = 0;
    zOffsetInput.value = '0.00';
    updateBinding('zOffsetValue', '0.00');
    updateDepthTransform({ resetTranslation: true });
  });
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

function renderLoop() {
  if (state.mesh) {
    const width = canvas.width;
    const height = canvas.height;
    const monoAspect = width / height;
    const stereoAspect = (width / 2) / height;
    const farClip = Number.isFinite(state.options.farClip) ? state.options.farClip : FAR_MAX;
    const farPlane = Math.max(farClip * state.controls.scale * 1.5, 1000);
    const fovRadians = (state.camera.fov * Math.PI) / 180;
    const isStereo = state.stereo.mode === 'sbs';
    const projection = mat4.perspective(
      fovRadians,
      isStereo ? stereoAspect : monoAspect,
      0.01,
      farPlane
    );

    const baseView = mat4.identity();
    let model = mat4.identity();
    const translateZ = state.controls.translationZ + state.autoTranslationZ;
    model = mat4.translate(model, [state.controls.translationX, state.controls.translationY, translateZ]);
    model = mat4.translate(model, [0, 0, state.pivotZ]);
    model = mat4.rotateY(model, state.controls.rotationY);
    model = mat4.rotateX(model, state.controls.rotationX);
    model = mat4.scale(model, state.controls.scale);
    model = mat4.translate(model, [0, 0, -state.pivotZ]);

    if (!isStereo) {
      renderer.render(model, baseView, projection, {
        viewport: [0, 0, width, height],
        clearColor: true,
        clearDepth: true,
      });
    } else {
      const halfWidth = Math.floor(width / 2);
      const separation = clamp(state.stereo.separation, STEREO_MIN, STEREO_MAX);
      const rawRadius = state.baseBounds ? Math.max(state.baseBounds.radius || 1, 0.0001) : 1;
      const scaleRadius = Math.max(0.1, Math.min(Math.pow(rawRadius, 0.75), 12.0));
      const offset = separation * scaleRadius;
      const leftCam = -offset / 2;
      const rightCam = offset / 2;
      const leftView = mat4.translate(baseView, [-leftCam, 0, 0]);
      const rightView = mat4.translate(baseView, [-rightCam, 0, 0]);
      const leftViewport = [0, 0, halfWidth, height];
      const rightViewport = [halfWidth, 0, width - halfWidth, height];

      const eyes = state.stereo.swapEyes
        ? [
            { view: rightView, viewport: leftViewport },
            { view: leftView, viewport: rightViewport },
          ]
        : [
            { view: leftView, viewport: leftViewport },
            { view: rightView, viewport: rightViewport },
          ];

      renderer.render(model, eyes[0].view, projection, {
        viewport: eyes[0].viewport,
        clearColor: true,
        clearDepth: true,
      });
      renderer.render(model, eyes[1].view, projection, {
        viewport: eyes[1].viewport,
        clearColor: false,
        clearDepth: true,
      });
    }
  } else {
    renderer.gl.clear(renderer.gl.COLOR_BUFFER_BIT | renderer.gl.DEPTH_BUFFER_BIT);
  }
  syncMirrorControls();
  requestAnimationFrame(renderLoop);
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

function formatFarClip(value) {
  if (!Number.isFinite(value)) return '∞';
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function sliderToMagnification(sliderValue) {
  const t = clamp(sliderValue, 0, 100) / 100;
  const ratio = MAG_MAX / MAG_MIN;
  return MAG_MIN * Math.pow(ratio, t);
}

function magnificationToSlider(magnification) {
  const mag = clamp(magnification, MAG_MIN, MAG_MAX);
  const ratio = Math.log(MAG_MAX / MAG_MIN);
  const t = Math.log(mag / MAG_MIN) / ratio;
  return Math.round(t * 100);
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
  const centerZ = (minZ + maxZ) / 2;
  const maxSpan = Math.max(sizeX, sizeY, sizeZ);
  const radius = Math.max(sizeX, sizeY) * 0.5;

  return { minX, maxX, minY, maxY, minZ, maxZ, sizeX, sizeY, sizeZ, centerZ, maxSpan, radius };
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
    centerZ,
    maxSpan: Math.max(sizeX, sizeY, sizeZ),
    radius: Math.max(sizeX, sizeY) * 0.5,
  };
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
  renderer.setTexture(textureImage);
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
}

function applyInitialView() {
  if (!state.mesh) return;
  const bounds = state.baseBounds || computeBounds(state.mesh.positions);
  state.initialScale = calculateInitialScale(bounds);
  state.controls.scale = state.initialScale;

  refreshAutoFit({ bounds, resetTranslation: true });
}

init();
