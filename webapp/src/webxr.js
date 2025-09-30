const LOOKING_GLASS_MODULE = 'https://unpkg.com/@lookingglass/webxr@0.6.0/dist/bundle/webxr.js';

/**
 * Handles WebXR session flow for both standard HMDs (e.g. Quest via Link)
 * and Looking Glass displays through the official polyfill.
 */
export class WebXRManager {
  constructor(options) {
    const {
      renderer,
      canvas,
      getModelMatrix,
      onStateChange = () => {},
      onStatus = () => {},
    } = options;
    this.renderer = renderer;
    this.canvas = canvas;
    this.gl = renderer?.gl || null;
    this.getModelMatrix = getModelMatrix;
    this.onStateChange = onStateChange;
    this.onStatus = onStatus;

    this.session = null;
    this.referenceSpace = null;
    this.isLookingGlass = false;
    this.lookPromise = null;
    this.xrSupported = false;
    this.xr = navigator.xr || null;
  }

  async detectSupport() {
    if (navigator.xr && this.xr !== navigator.xr) {
      this.xr = navigator.xr;
    }
    if (!this.xr) {
      this.onStatus('WebXR unavailable');
      this.onStateChange({ supported: false });
      return false;
    }
    try {
      const supported = await this.xr.isSessionSupported('immersive-vr');
      this.xrSupported = supported;
      this.onStateChange({ supported });
      this.onStatus(supported ? 'WebXR ready (immersive-vr)' : 'WebXR not supported');
      return supported;
    } catch (error) {
      console.warn('WebXR support check failed', error);
      this.onStatus('WebXR check failed');
      this.onStateChange({ supported: false, error: error.message });
      return false;
    }
  }

  async enterVR(options = {}) {
    if (navigator.xr && this.xr !== navigator.xr) {
      this.xr = navigator.xr;
    }
    const supported = this.xrSupported || (await this.detectSupport());
    if (!supported) {
      this.onStatus('WebXR not available');
      return false;
    }
    if (this.session) {
      await this.session.end();
    }

    const sessionInit = {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['bounded-floor', 'hand-tracking', 'layers'],
      ...options.sessionInit,
    };

    try {
      this.onStatus('Starting WebXR session…');
      const session = await this.xr.requestSession('immersive-vr', sessionInit);
      await this.setupSession(session, options);
      return true;
    } catch (error) {
      console.error('Failed to start XR session', error);
      this.onStatus(`XR session failed: ${error.message || error}`);
      return false;
    }
  }

  async enterLookingGlass(config = {}) {
    this.isLookingGlass = true;
    try {
      await this.ensureLookingGlassPolyfill(config);
    } catch (error) {
      console.error('Looking Glass polyfill failed', error);
      this.onStatus(`Looking Glass setup failed: ${error.message || error}`);
      this.onStateChange({ lookingGlassReady: false, lookingGlassError: error.message });
      this.isLookingGlass = false;
      return false;
    }
    this.onStateChange({ lookingGlassReady: true, lookingGlassError: null });
    return this.enterVR({
      sessionInit: {
        requiredFeatures: ['local-floor'],
        optionalFeatures: ['bounded-floor'],
      },
      label: 'looking-glass',
    });
  }

  async ensureLookingGlassPolyfill(config) {
    if (!this.lookPromise) {
      this.lookPromise = import(/* webpackIgnore: true */ LOOKING_GLASS_MODULE)
        .then((module) => {
          const { LookingGlassWebXRPolyfill, LookingGlassConfig } = module;
          if (!LookingGlassWebXRPolyfill) {
            throw new Error('Looking Glass module missing polyfill export');
          }
          const merged = { ...(LookingGlassConfig || {}), ...config };
          // Instantiate polyfill once. Subsequent calls reuse existing session.
          // eslint-disable-next-line no-new
          new LookingGlassWebXRPolyfill(merged);
          return true;
        })
        .catch((error) => {
          console.error('Looking Glass module load failed', error);
          throw error;
        });
    }
    return this.lookPromise;
  }

  async setupSession(session, { label } = {}) {
    this.session = session;
    this.isLookingGlass = label === 'looking-glass';
    if (!this.gl) {
      throw new Error('Renderer WebGL context unavailable');
    }
    if (this.gl.makeXRCompatible) {
      await this.gl.makeXRCompatible();
    }
    const baseLayer = new XRWebGLLayer(session, this.gl, { antialias: true, alpha: false });
    session.updateRenderState({ baseLayer });

    this.referenceSpace = await this.getReferenceSpace(session);
    if (!this.referenceSpace) {
      throw new Error('Failed to acquire XR reference space');
    }

    session.addEventListener('end', () => {
      this.session = null;
      this.referenceSpace = null;
      this.onStateChange({ active: false, mode: null });
      this.onStatus('XR session ended');
    });

    this.onStateChange({ active: true, mode: this.isLookingGlass ? 'looking-glass' : 'vr' });
    this.onStatus(this.isLookingGlass ? 'Looking Glass session active' : 'VR session active');

    const onXRFrame = (time, frame) => {
      if (!this.session) return;
      this.session.requestAnimationFrame(onXRFrame);
      this.renderXRFrame(frame);
    };
    session.requestAnimationFrame(onXRFrame);
  }

  async getReferenceSpace(session) {
    const types = ['local-floor', 'bounded-floor', 'local'];
    for (const type of types) {
      try {
        return await session.requestReferenceSpace(type);
      } catch (error) {
        console.warn(`Reference space ${type} unavailable`, error);
      }
    }
    return null;
  }

  renderXRFrame(frame) {
    if (!this.referenceSpace || !this.renderer || !this.session) return;
    const pose = frame.getViewerPose(this.referenceSpace);
    if (!pose) {
      return;
    }

    const baseLayer = this.session.renderState.baseLayer;
    this.renderer.gl.bindFramebuffer(this.renderer.gl.FRAMEBUFFER, baseLayer.framebuffer);

    const modelMatrix = this.getModelMatrix();
    pose.views.forEach((view, index) => {
      const viewport = baseLayer.getViewport(view);
      this.renderer.render(modelMatrix, view.transform.inverse.matrix, view.projectionMatrix, {
        viewport: [viewport.x, viewport.y, viewport.width, viewport.height],
        clearColor: index === 0,
        clearDepth: index === 0,
      });
    });
  }

  async exit() {
    if (this.session) {
      try {
        await this.session.end();
      } catch (error) {
        console.warn('Failed to end XR session', error);
      }
    }
  }
}

export default WebXRManager;
