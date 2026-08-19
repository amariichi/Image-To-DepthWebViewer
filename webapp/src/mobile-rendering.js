import { mat4 } from './rendering.js';

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec2 aUv;
uniform mat4 uModelViewProjection;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = uModelViewProjection * vec4(aPosition, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTexture;
out vec4 outColor;
void main() {
  outColor = vec4(texture(uTexture, vUv).rgb, 1.0);
}`;

export const MAX_BACKBUFFER_PIXELS = 2_600_000;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Mobile shader compile failed: ${info}`);
  }
  return shader;
}

function createProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Mobile shader link failed: ${info}`);
  }
  return program;
}

export function createMobileRenderer(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: true,
    powerPreference: 'high-performance',
  });
  if (!gl) {
    throw new Error('WebGL2 is unavailable on this device.');
  }

  const program = createProgram(gl);
  const mvpLocation = gl.getUniformLocation(program, 'uModelViewProjection');
  const textureLocation = gl.getUniformLocation(program, 'uTexture');
  const vao = gl.createVertexArray();
  const positionBuffer = gl.createBuffer();
  const uvBuffer = gl.createBuffer();
  const indexBuffer = gl.createBuffer();
  const texture = gl.createTexture();
  let indexCount = 0;
  let indexType = gl.UNSIGNED_INT;

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bindVertexArray(null);

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.031, 0.035, 0.035, 1);

  function resize(width, height, devicePixelRatio = window.devicePixelRatio || 1) {
    // The multisampled default framebuffer is allocated before a single
    // triangle is drawn, and on a tablet at full device pixel ratio it is one
    // of the largest single allocations the page makes. Capping total
    // backbuffer pixels leaves phones at full sharpness and trims only the
    // largest panels.
    const requested = Math.min(Math.max(devicePixelRatio, 1), 2);
    const cap = Math.sqrt(MAX_BACKBUFFER_PIXELS / Math.max(width * height, 1));
    const pixelRatio = Math.max(Math.min(requested, cap), 1);
    const displayWidth = Math.max(1, Math.round(width * pixelRatio));
    const displayHeight = Math.max(1, Math.round(height * pixelRatio));
    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
      canvas.width = displayWidth;
      canvas.height = displayHeight;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function updateGeometry(scene) {
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, scene.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, scene.uvs, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, scene.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    indexCount = scene.indices.length;
    if (scene.indices instanceof Uint8Array) indexType = gl.UNSIGNED_BYTE;
    else if (scene.indices instanceof Uint16Array) indexType = gl.UNSIGNED_SHORT;
    else indexType = gl.UNSIGNED_INT;
  }

  function setScene(scene, image) {
    updateGeometry(scene);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.bindTexture(gl.TEXTURE_2D, null);
    // Once the pixels are on the GPU the decoded bitmap is dead weight, and on
    // a constrained browser it is the biggest thing still held in the page.
    image.close?.();
  }

  function clear() {
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  function render({ modelMatrix, viewMatrix, projectionMatrix }) {
    clear();
    if (!indexCount) return;
    const modelView = mat4.multiply(viewMatrix, modelMatrix);
    const mvp = mat4.multiply(projectionMatrix, modelView);
    gl.useProgram(program);
    gl.uniformMatrix4fv(mvpLocation, false, mvp);
    gl.uniform1i(textureLocation, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.bindVertexArray(vao);
    gl.drawElements(gl.TRIANGLES, indexCount, indexType, 0);
    gl.bindVertexArray(null);
  }

  function destroy() {
    gl.deleteTexture(texture);
    gl.deleteBuffer(positionBuffer);
    gl.deleteBuffer(uvBuffer);
    gl.deleteBuffer(indexBuffer);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
  }

  return { gl, resize, updateGeometry, setScene, clear, render, destroy };
}
