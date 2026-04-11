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
      onInputFrame = null,
      onInputSourcesChange = null,
      onSelectStart = null,
      onSelectEnd = null,
      onSqueezeStart = null,
      onSqueezeEnd = null,
      onAfterViewRender = null,
    } = options;
    this.renderer = renderer;
    this.canvas = canvas;
    this.gl = renderer?.gl || null;
    this.getModelMatrix = getModelMatrix;
    this.onStateChange = onStateChange;
    this.onStatus = onStatus;
    this.onInputFrame = typeof onInputFrame === 'function' ? onInputFrame : null;
    this.onInputSourcesChange = typeof onInputSourcesChange === 'function' ? onInputSourcesChange : null;
    this.onSelectStart = typeof onSelectStart === 'function' ? onSelectStart : null;
    this.onSelectEnd = typeof onSelectEnd === 'function' ? onSelectEnd : null;
    this.onSqueezeStart = typeof onSqueezeStart === 'function' ? onSqueezeStart : null;
    this.onSqueezeEnd = typeof onSqueezeEnd === 'function' ? onSqueezeEnd : null;
    this.sessionEventHandlers = [];

    this.session = null;
    this.referenceSpace = null;
    this.isLookingGlass = false;
    this.lookPromise = null;
    this.xrSupported = false;
    this.nativeXR = navigator.xr || null;
    this.xr = this.nativeXR;
    this.prevXRTime = null;
    this.lastSessionLabel = null;
    this.polyfillActive = false;
    this.onAfterViewRender = typeof onAfterViewRender === 'function' ? onAfterViewRender : null;
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
    return this.startSessionWithOptions(options);
  }

  async startSessionWithOptions(options = {}) {
    if (!options.label && this.polyfillActive && this.nativeXR) {
      this.restoreNativeXR();
    }
    if (navigator.xr && this.xr !== navigator.xr) {
      this.xr = navigator.xr;
    }
    if (!this.xr) {
      this.onStatus('WebXR subsystem unavailable');
      return false;
    }

    const initAttempt = async (init, label) => {
      try {
        this.onStatus(`Starting WebXR session…${label ? ` (${label})` : ''}`);
        const session = await this.xr.requestSession('immersive-vr', init);
        await this.setupSession(session, options);
        return true;
      } catch (error) {
        console.warn(`XR requestSession failed${label ? ` (${label})` : ''}`, error);
        return error;
      }
    };

    const attempts = [
      {
        label: 'with floor options',
        init: {
          optionalFeatures: ['local-floor', 'bounded-floor'],
          ...(options.sessionInit || {}),
        },
      },
      {
        label: 'basic',
        init: {
          optionalFeatures: [],
          requiredFeatures: [],
        },
      },
    ];

    for (const attempt of attempts) {
      const result = await initAttempt(attempt.init, attempt.label);
      if (result === true) {
        this.onStatus('WebXR session active');
        return true;
      }
      if (result?.name === 'SecurityError') {
        this.onStatus('VR session blocked: click Enter VR again (user activation required).');
        return false;
      }
    }

    this.onStatus('WebXR session failed to start');
    return false;
  }

  restoreNativeXR() {
    if (!this.nativeXR) {
      return;
    }
    try {
      if (navigator.xr !== this.nativeXR) {
        Object.defineProperty(window.navigator, 'xr', {
          value: this.nativeXR,
          configurable: true,
          writable: true,
        });
      }
    } catch (error) {
      try {
        window.navigator.xr = this.nativeXR;
      } catch (assignError) {
        console.warn('Failed to restore native XR', assignError || error);
      }
    }
    this.xr = this.nativeXR;
    this.polyfillActive = false;
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
          new LookingGlassWebXRPolyfill(merged);
          this.polyfillActive = true;
          this.xr = navigator.xr || this.xr;
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
    this.lastSessionLabel = label || null;
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
      this.cleanupSessionEvents(session);
      this.session = null;
      this.referenceSpace = null;
      this.prevXRTime = null;
      const wasLookingGlass = this.isLookingGlass || this.lastSessionLabel === 'looking-glass';
      this.isLookingGlass = false;
      this.lastSessionLabel = null;
      if (wasLookingGlass && this.nativeXR) {
        this.restoreNativeXR();
      }
      this.onStateChange({ active: false, mode: null });
      this.onStatus('XR session ended');
    });

    this.registerSessionEvents(session);

    this.onStateChange({ active: true, mode: this.isLookingGlass ? 'looking-glass' : 'vr' });
    this.onStatus(this.isLookingGlass ? 'Looking Glass session active' : 'VR session active');

    const onXRFrame = (time, frame) => {
      if (!this.session) return;
      this.session.requestAnimationFrame(onXRFrame);
      this.renderXRFrame(time, frame);
    };
    session.requestAnimationFrame(onXRFrame);
  }

  registerSessionEvents(session) {
    this.cleanupSessionEvents(session);
    const handlers = [];

    if (this.onInputSourcesChange) {
      const handler = (event) => {
        try {
          this.onInputSourcesChange(event);
        } catch (error) {
          console.warn('WebXR input sources handler error', error);
        }
      };
      session.addEventListener('inputsourceschange', handler);
      handlers.push(['inputsourceschange', handler]);
    }

    if (this.onSelectStart) {
      const handler = (event) => {
        try {
          this.onSelectStart(event);
        } catch (error) {
          console.warn('WebXR selectstart handler error', error);
        }
      };
      session.addEventListener('selectstart', handler);
      handlers.push(['selectstart', handler]);
    }

    if (this.onSelectEnd) {
      const handler = (event) => {
        try {
          this.onSelectEnd(event);
        } catch (error) {
          console.warn('WebXR selectend handler error', error);
        }
      };
      session.addEventListener('selectend', handler);
      handlers.push(['selectend', handler]);
    }

    if (this.onSqueezeStart) {
      const handler = (event) => {
        try {
          this.onSqueezeStart(event);
        } catch (error) {
          console.warn('WebXR squeezestart handler error', error);
        }
      };
      session.addEventListener('squeezestart', handler);
      handlers.push(['squeezestart', handler]);
    }

    if (this.onSqueezeEnd) {
      const handler = (event) => {
        try {
          this.onSqueezeEnd(event);
        } catch (error) {
          console.warn('WebXR squeezeend handler error', error);
        }
      };
      session.addEventListener('squeezeend', handler);
      handlers.push(['squeezeend', handler]);
    }

    this.sessionEventHandlers = handlers;
  }

  cleanupSessionEvents(session) {
    if (!this.sessionEventHandlers || !session) {
      this.sessionEventHandlers = [];
      return;
    }
    this.sessionEventHandlers.forEach(([type, handler]) => {
      try {
        session.removeEventListener(type, handler);
      } catch (error) {
        console.warn(`WebXR failed to remove ${type} handler`, error);
      }
    });
    this.sessionEventHandlers = [];
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

  renderXRFrame(time, frame) {
    if (!this.referenceSpace || !this.renderer || !this.session) return;
    const pose = frame.getViewerPose(this.referenceSpace);
    if (!pose) {
      return;
    }

    const deltaTime = this.prevXRTime != null ? (time - this.prevXRTime) / 1000 : 0;
    this.prevXRTime = time;

    const baseLayer = this.session.renderState.baseLayer;
    this.renderer.gl.bindFramebuffer(this.renderer.gl.FRAMEBUFFER, baseLayer.framebuffer);

    const modelMatrix = this.getModelMatrix();
    pose.views.forEach((view, index) => {
      const viewport = baseLayer.getViewport(view);
      const viewMatrix = view.transform.inverse.matrix;
      const projectionMatrix = view.projectionMatrix;
      this.renderer.render(modelMatrix, viewMatrix, projectionMatrix, {
        viewport: [viewport.x, viewport.y, viewport.width, viewport.height],
        clearColor: index === 0,
        clearDepth: index === 0,
      });

      if (this.onAfterViewRender) {
        try {
          const transform = view.transform;
          this.onAfterViewRender({
            frame,
            view,
            viewport: {
              x: viewport.x,
              y: viewport.y,
              width: viewport.width,
              height: viewport.height,
            },
            viewMatrix,
            projectionMatrix,
            position: transform.position,
            orientation: transform.orientation,
            time,
            deltaTime,
          });
        } catch (error) {
          console.warn('WebXR after-view handler error', error);
        }
      }
    });

    if (this.onInputFrame) {
      try {
        this.onInputFrame({
          frame,
          session: this.session,
          referenceSpace: this.referenceSpace,
          time,
          deltaTime,
        });
      } catch (error) {
        console.warn('WebXR input handler error', error);
      }
    }
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
