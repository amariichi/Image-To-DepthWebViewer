const VERT_SOURCE = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec2 aUv;

uniform mat4 uModel;
uniform mat4 uView;
uniform mat4 uProjection;

out vec2 vUv;

void main() {
  vUv = aUv;
  gl_Position = uProjection * uView * uModel * vec4(aPosition, 1.0);
}
`;

const FRAG_SOURCE = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uTexture;

void main() {
  vec4 tex = texture(uTexture, vUv);
  fragColor = vec4(tex.rgb, 1.0);
}
`;

export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: true, xrCompatible: true });
  if (!gl) {
    throw new Error('WebGL2 is not available in this browser.');
  }

  const program = createProgram(gl, VERT_SOURCE, FRAG_SOURCE);
  const attribLocations = {
    position: 0,
    uv: 1,
  };
  const uniforms = {
    model: gl.getUniformLocation(program, 'uModel'),
    view: gl.getUniformLocation(program, 'uView'),
    projection: gl.getUniformLocation(program, 'uProjection'),
    texture: gl.getUniformLocation(program, 'uTexture'),
  };

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.enableVertexAttribArray(attribLocations.position);
  gl.vertexAttribPointer(attribLocations.position, 3, gl.FLOAT, false, 0, 0);

  const uvBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
  gl.enableVertexAttribArray(attribLocations.uv);
  gl.vertexAttribPointer(attribLocations.uv, 2, gl.FLOAT, false, 0, 0);

  const indexBuffer = gl.createBuffer();

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.bindTexture(gl.TEXTURE_2D, null);

  let indexCount = 0;

  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 1);

  function resize(width, height, devicePixelRatio = window.devicePixelRatio || 1) {
    const displayWidth = Math.floor(width * devicePixelRatio);
    const displayHeight = Math.floor(height * devicePixelRatio);
    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
      canvas.width = displayWidth;
      canvas.height = displayHeight;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function updateGeometry(mesh) {
    gl.bindVertexArray(vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.DYNAMIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

    indexCount = mesh.indexCount;

    gl.bindVertexArray(null);
  }

  function updatePositions(mesh) {
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, mesh.positions);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  function setTexture(imageData) {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      imageData.width,
      imageData.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      imageData.data
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  function render(modelMatrix, viewMatrix, projectionMatrix, options = {}) {
    const {
      viewport = [0, 0, canvas.width, canvas.height],
      clearColor = true,
      clearDepth = true,
    } = options;

    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    let mask = 0;
    if (clearColor) mask |= gl.COLOR_BUFFER_BIT;
    if (clearDepth) mask |= gl.DEPTH_BUFFER_BIT;
    if (mask) {
      gl.clear(mask);
    }
    gl.useProgram(program);
    gl.bindVertexArray(vao);

    gl.uniformMatrix4fv(uniforms.model, false, modelMatrix);
    gl.uniformMatrix4fv(uniforms.view, false, viewMatrix);
    gl.uniformMatrix4fv(uniforms.projection, false, projectionMatrix);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(uniforms.texture, 0);

    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, 0);

    gl.bindVertexArray(null);
  }

  return {
    gl,
    resize,
    updateGeometry,
    updatePositions,
    setTexture,
    render,
  };
}

function createProgram(gl, vertSource, fragSource) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link failed: ${info}`);
  }
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  return program;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${info}`);
  }
  return shader;
}

export const mat4 = {
  identity() {
    return new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
  },
  multiply(a, b) {
    const out = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
      const ai0 = a[i];
      const ai1 = a[i + 4];
      const ai2 = a[i + 8];
      const ai3 = a[i + 12];
      out[i] = ai0 * b[0] + ai1 * b[1] + ai2 * b[2] + ai3 * b[3];
      out[i + 4] = ai0 * b[4] + ai1 * b[5] + ai2 * b[6] + ai3 * b[7];
      out[i + 8] = ai0 * b[8] + ai1 * b[9] + ai2 * b[10] + ai3 * b[11];
      out[i + 12] = ai0 * b[12] + ai1 * b[13] + ai2 * b[14] + ai3 * b[15];
    }
    return out;
  },
  perspective(fovy, aspect, near, far) {
    const f = 1.0 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    const out = new Float32Array(16);
    out[0] = f / aspect;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;

    out[4] = 0;
    out[5] = f;
    out[6] = 0;
    out[7] = 0;

    out[8] = 0;
    out[9] = 0;
    out[10] = (far + near) * nf;
    out[11] = -1;

    out[12] = 0;
    out[13] = 0;
    out[14] = (2 * far * near) * nf;
    out[15] = 0;
    return out;
  },
  lookAt(eye, target, up = [0, 1, 0]) {
    const [ex, ey, ez] = eye;
    const [tx, ty, tz] = target;
    const zx = ex - tx;
    const zy = ey - ty;
    const zz = ez - tz;
    let zLen = Math.hypot(zx, zy, zz);
    if (zLen === 0) {
      zLen = 1;
    }
    const zxN = zx / zLen;
    const zyN = zy / zLen;
    const zzN = zz / zLen;

    let xx = up[1] * zzN - up[2] * zyN;
    let xy = up[2] * zxN - up[0] * zzN;
    let xz = up[0] * zyN - up[1] * zxN;
    let xLen = Math.hypot(xx, xy, xz);
    if (xLen === 0) {
      xLen = 1;
    }
    xx /= xLen;
    xy /= xLen;
    xz /= xLen;

    const yx = zyN * xz - zzN * xy;
    const yy = zzN * xx - zxN * xz;
    const yz = zxN * xy - zyN * xx;

    const out = new Float32Array(16);
    out[0] = xx;
    out[1] = yx;
    out[2] = zxN;
    out[3] = 0;

    out[4] = xy;
    out[5] = yy;
    out[6] = zyN;
    out[7] = 0;

    out[8] = xz;
    out[9] = yz;
    out[10] = zzN;
    out[11] = 0;

    out[12] = -(xx * ex + xy * ey + xz * ez);
    out[13] = -(yx * ex + yy * ey + yz * ez);
    out[14] = -(zxN * ex + zyN * ey + zzN * ez);
    out[15] = 1;
    return out;
  },
  translate(matrix, translation) {
    const [x, y, z] = translation;
    const out = new Float32Array(matrix);
    out[12] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    out[13] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    out[14] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    out[15] = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
    return out;
  },
  rotateX(matrix, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const m10 = matrix[4];
    const m11 = matrix[5];
    const m12 = matrix[6];
    const m13 = matrix[7];
    const m20 = matrix[8];
    const m21 = matrix[9];
    const m22 = matrix[10];
    const m23 = matrix[11];
    const out = new Float32Array(matrix);
    out[4] = m10 * c + m20 * s;
    out[5] = m11 * c + m21 * s;
    out[6] = m12 * c + m22 * s;
    out[7] = m13 * c + m23 * s;
    out[8] = m20 * c - m10 * s;
    out[9] = m21 * c - m11 * s;
    out[10] = m22 * c - m12 * s;
    out[11] = m23 * c - m13 * s;
    return out;
  },
  rotateY(matrix, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const m00 = matrix[0];
    const m01 = matrix[1];
    const m02 = matrix[2];
    const m03 = matrix[3];
    const m20 = matrix[8];
    const m21 = matrix[9];
    const m22 = matrix[10];
    const m23 = matrix[11];
    const out = new Float32Array(matrix);
    out[0] = m00 * c - m20 * s;
    out[1] = m01 * c - m21 * s;
    out[2] = m02 * c - m22 * s;
    out[3] = m03 * c - m23 * s;
    out[8] = m00 * s + m20 * c;
    out[9] = m01 * s + m21 * c;
    out[10] = m02 * s + m22 * c;
    out[11] = m03 * s + m23 * c;
    return out;
  },
  scale(matrix, factor) {
    const out = new Float32Array(matrix);
    out[0] *= factor;
    out[1] *= factor;
    out[2] *= factor;
    out[3] *= factor;
    out[4] *= factor;
    out[5] *= factor;
    out[6] *= factor;
    out[7] *= factor;
    out[8] *= factor;
    out[9] *= factor;
    out[10] *= factor;
    out[11] *= factor;
    return out;
  },
};
