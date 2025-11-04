const INTRO_LINES = [
  'VR Controls',
  'Trigger + Move → Orbit',
  'Grip + Move → Pan',
  'Trigger + Forward/Back → Zoom',
  'Stick ←/→ → Geometry FOV',
  'Stick ↑/↓ → Depth Magnification',
  'X / Y → Far Clip',
];

function drawRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function quaternionToBasis(orientation) {
  const x = orientation?.x || 0;
  const y = orientation?.y || 0;
  const z = orientation?.z || 0;
  const w = orientation?.w ?? 1;

  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;

  const right = [1 - (yy + zz), xy + wz, xz - wy];
  const up = [xy - wz, 1 - (xx + zz), yz + wx];
  const forward = [xz + wy, yz - wx, 1 - (xx + yy)];
  return { right, up, forward };
}

function normalize(vec) {
  const len = Math.hypot(vec[0], vec[1], vec[2]) || 1;
  return [vec[0] / len, vec[1] / len, vec[2] / len];
}

export default class XRHintOverlay {
  constructor(gl) {
    this.gl = gl;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 256;
    this.ctx = this.canvas.getContext('2d');

    this.program = this.createProgram();
    this.texture = gl.createTexture();
    this.vao = gl.createVertexArray();
    this.vertexBuffer = gl.createBuffer();
    this.uvBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();

    this.opacity = 0;
    this.targetOpacity = 0;
    this.displayTimer = 0;
    this.fadeSpeed = 6;
    this.lines = [];
    this.needsUpload = true;
    this.active = false;

    this.mode = null;
    this.offset = { right: 0, up: -0.15, forward: -1.0 };
    this.physicalWidth = 0.95;
    this.physicalHeight = this.physicalWidth * (this.canvas.height / this.canvas.width);
    this.depthScale = 0.001;

    this.uniforms = {
      model: gl.getUniformLocation(this.program, 'uModel'),
      view: gl.getUniformLocation(this.program, 'uView'),
      projection: gl.getUniformLocation(this.program, 'uProjection'),
      opacity: gl.getUniformLocation(this.program, 'uOpacity'),
      texture: gl.getUniformLocation(this.program, 'uTexture'),
    };

    this.setMode('intro');
    this.setupGeometry();
    this.setupTexture();
  }

  dispose() {
    const { gl } = this;
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
    if (this.uvBuffer) gl.deleteBuffer(this.uvBuffer);
    if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
  }

  onSessionStart() {
    this.active = true;
    this.setMode('intro');
    this.showMessage(INTRO_LINES, { duration: 6, immediate: true });
  }

  onSessionEnd() {
    this.active = false;
    this.hide(true);
  }

  showAction(label, value = null) {
    if (!this.active) return;
    this.setMode('inline');
    const lines = value ? [`${label}: ${value}`] : [label];
    this.showMessage(lines, { duration: 0.6 });
  }

  showMessage(lines, { duration = 3, immediate = false } = {}) {
    this.lines = Array.isArray(lines) ? lines : [String(lines)];
    this.displayTimer = duration;
    this.targetOpacity = 1;
    if (immediate) {
      this.opacity = 1;
    }
    this.needsUpload = true;
  }

  hide(force = false) {
    if (force) {
      this.opacity = 0;
      this.targetOpacity = 0;
      this.displayTimer = 0;
    } else {
      this.displayTimer = 0;
      this.targetOpacity = 0;
    }
  }

  update(deltaTime = 0) {
    if (!this.active && this.opacity <= 0) {
      return;
    }
    if (this.displayTimer > 0) {
      this.displayTimer = Math.max(0, this.displayTimer - deltaTime);
      if (this.displayTimer === 0) {
        this.targetOpacity = 0;
      }
    }
    const diff = this.targetOpacity - this.opacity;
    if (Math.abs(diff) > 0.001) {
      const step = Math.min(1, this.fadeSpeed * deltaTime);
      this.opacity += diff * step;
    } else {
      this.opacity = this.targetOpacity;
    }
  }

  draw({ position, orientation, viewMatrix, projectionMatrix, viewport }) {
    if (this.opacity <= 0.01) {
      return;
    }
    if (!orientation || !position || !viewMatrix || !projectionMatrix) {
      return;
    }

    const gl = this.gl;
    if (this.needsUpload) {
      this.uploadTexture();
      this.needsUpload = false;
    }

    const { right, up, forward } = quaternionToBasis(orientation);
    const rightN = normalize(right);
    const upN = normalize(up);
    const forwardN = normalize(forward);

    const pos = [
      position.x + rightN[0] * this.offset.right + upN[0] * this.offset.up + forwardN[0] * this.offset.forward,
      position.y + rightN[1] * this.offset.right + upN[1] * this.offset.up + forwardN[1] * this.offset.forward,
      position.z + rightN[2] * this.offset.right + upN[2] * this.offset.up + forwardN[2] * this.offset.forward,
    ];

    const model = new Float32Array(16);
    model[0] = rightN[0] * this.physicalWidth;
    model[1] = rightN[1] * this.physicalWidth;
    model[2] = rightN[2] * this.physicalWidth;
    model[3] = 0;

    model[4] = upN[0] * this.physicalHeight;
    model[5] = upN[1] * this.physicalHeight;
    model[6] = upN[2] * this.physicalHeight;
    model[7] = 0;

    model[8] = -forwardN[0] * this.depthScale;
    model[9] = -forwardN[1] * this.depthScale;
    model[10] = -forwardN[2] * this.depthScale;
    model[11] = 0;

    model[12] = pos[0];
    model[13] = pos[1];
    model[14] = pos[2];
    model[15] = 1;

    const previousViewport = gl.getParameter(gl.VIEWPORT);
    const depthEnabled = gl.isEnabled(gl.DEPTH_TEST);
    const blendEnabled = gl.isEnabled(gl.BLEND);
    const depthMask = gl.getParameter(gl.DEPTH_WRITEMASK);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);

    if (viewport) {
      gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);

    gl.uniformMatrix4fv(this.uniforms.model, false, model);
    gl.uniformMatrix4fv(this.uniforms.view, false, viewMatrix);
    gl.uniformMatrix4fv(this.uniforms.projection, false, projectionMatrix);
    gl.uniform1f(this.uniforms.opacity, this.opacity);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.uniforms.texture, 0);

    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);

    if (!blendEnabled) gl.disable(gl.BLEND);
    if (depthEnabled) gl.enable(gl.DEPTH_TEST);
    gl.depthMask(depthMask);
    gl.viewport(previousViewport[0], previousViewport[1], previousViewport[2], previousViewport[3]);

    gl.bindVertexArray(null);
    gl.useProgram(null);
  }

  createProgram() {
    const vert = `#version 300 es\nlayout(location = 0) in vec3 aPosition;\nlayout(location = 1) in vec2 aUv;\nuniform mat4 uModel;\nuniform mat4 uView;\nuniform mat4 uProjection;\nout vec2 vUv;\nvoid main() {\n  vUv = aUv;\n  gl_Position = uProjection * uView * uModel * vec4(aPosition, 1.0);\n}`;
    const frag = `#version 300 es\nprecision highp float;\nin vec2 vUv;\nout vec4 fragColor;\nuniform sampler2D uTexture;\nuniform float uOpacity;\nvoid main() {\n  vec4 tex = texture(uTexture, vUv);\n  fragColor = vec4(tex.rgb, tex.a * uOpacity);\n}`;
    return this.compileProgram(vert, frag);
  }

  compileProgram(vertexSource, fragmentSource) {
    const gl = this.gl;
    const vertexShader = this.compileShader(gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = this.compileShader(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`XR hint shader link failed: ${info}`);
    }
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return program;
  }

  compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`XR hint shader compile failed: ${info}`);
    }
    return shader;
  }

  setMode(mode) {
    if (this.mode === mode) {
      return;
    }
    this.mode = mode;
    if (mode === 'intro') {
      this.canvas.width = 512;
      this.canvas.height = 256;
      this.offset = { right: 0, up: -0.15, forward: -1.2 };
      this.physicalWidth = 0.9;
    } else {
      this.canvas.width = 512;
      this.canvas.height = 96;
      this.offset = { right: 0, up: -0.55, forward: -1.25 };
      this.physicalWidth = 0.85;
    }
    this.ctx = this.canvas.getContext('2d');
    this.physicalHeight = this.physicalWidth * (this.canvas.height / this.canvas.width);
    this.needsUpload = true;
  }

  setupGeometry() {
    const gl = this.gl;
    const positions = new Float32Array([
      -0.5, 0.5, 0,
      -0.5, -0.5, 0,
      0.5, 0.5, 0,
      0.5, -0.5, 0,
    ]);
    const uvs = new Float32Array([
      0, 0,
      0, 1,
      1, 0,
      1, 1,
    ]);
    const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);

    this.gl.bindVertexArray(this.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }

  setupTexture() {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  uploadTexture() {
    const gl = this.gl;
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    const isIntro = this.mode === 'intro';
    const padding = isIntro ? 18 : 8;
    const radius = isIntro ? 18 : 12;
    ctx.fillStyle = 'rgba(18, 20, 28, 0.82)';
    drawRoundedRect(ctx, padding, padding, width - padding * 2, height - padding * 2, radius);
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = isIntro ? '24px sans-serif' : '24px sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const lineHeight = isIntro ? 30 : 22;
    const innerHeight = height - padding * 2;
    let y = padding + (isIntro ? 12 : Math.max(0, (innerHeight - lineHeight) / 2));
    for (const line of this.lines) {
      ctx.fillText(line, padding + 20, y);
      y += lineHeight;
    }
    ctx.restore();

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}
