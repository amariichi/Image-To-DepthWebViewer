const textEncoder = new TextEncoder();

function toFloat32(array) {
  if (array instanceof Float32Array) {
    return new Float32Array(array);
  }
  return new Float32Array(array);
}

function toUint32(array) {
  if (array instanceof Uint32Array) {
    return new Uint32Array(array);
  }
  return new Uint32Array(array);
}

function computeVertexNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * 3;
    const ib = indices[i + 1] * 3;
    const ic = indices[i + 2] * 3;

    const ax = positions[ia];
    const ay = positions[ia + 1];
    const az = positions[ia + 2];

    const bx = positions[ib];
    const by = positions[ib + 1];
    const bz = positions[ib + 2];

    const cx = positions[ic];
    const cy = positions[ic + 1];
    const cz = positions[ic + 2];

    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;

    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;

    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;

    normals[ia] += nx;
    normals[ia + 1] += ny;
    normals[ia + 2] += nz;
    normals[ib] += nx;
    normals[ib + 1] += ny;
    normals[ib + 2] += nz;
    normals[ic] += nx;
    normals[ic + 1] += ny;
    normals[ic + 2] += nz;
  }

  for (let i = 0; i < normals.length; i += 3) {
    const nx = normals[i];
    const ny = normals[i + 1];
    const nz = normals[i + 2];
    const length = Math.hypot(nx, ny, nz);
    if (length > 1e-5) {
      normals[i] = nx / length;
      normals[i + 1] = ny / length;
      normals[i + 2] = nz / length;
    } else {
      normals[i] = 0;
      normals[i + 1] = 1;
      normals[i + 2] = 0;
    }
  }
  return normals;
}

function computeBounds(positions) {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  return { min, max };
}

function toUint8Array(data) {
  if (data instanceof Uint8Array) {
    return data;
  }
  return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
}

function createBinaryBuffer() {
  const parts = [];
  let byteLength = 0;
  const bufferViews = [];

  function append(data, { align = 4, target } = {}) {
    const array = toUint8Array(data);
    const padding = (align - (byteLength % align)) % align;
    if (padding) {
      parts.push({ type: 'pad', length: padding });
      byteLength += padding;
    }
    const byteOffset = byteLength;
    parts.push({ type: 'data', array });
    byteLength += array.byteLength;
    const view = {
      buffer: 0,
      byteOffset,
      byteLength: array.byteLength,
    };
    if (typeof target === 'number') {
      view.target = target;
    }
    bufferViews.push(view);
    return bufferViews.length - 1;
  }

  function finalize() {
    const buffer = new Uint8Array(byteLength);
    let offset = 0;
    parts.forEach((part) => {
      if (part.type === 'pad') {
        offset += part.length;
      } else {
        buffer.set(part.array, offset);
        offset += part.array.byteLength;
      }
    });
    return { buffer, bufferViews, byteLength };
  }

  return { append, finalize };
}

async function encodeImageData(imageData) {
  if (!imageData) return null;
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(imageData.width, imageData.height);
      const ctx = canvas.getContext('2d');
      ctx.putImageData(imageData, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const buffer = await blob.arrayBuffer();
      return new Uint8Array(buffer);
    }
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(imageData, 0, 0);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) {
          resolve(result);
        } else {
          reject(new Error('Canvas toBlob failed.'));
        }
      }, 'image/png');
    });
    const buffer = await blob.arrayBuffer();
    return new Uint8Array(buffer);
  } catch (error) {
    console.error('Failed to encode texture image', error);
    return null;
  }
}

function createJsonChunk(json) {
  const jsonString = JSON.stringify(json);
  const jsonBytes = textEncoder.encode(jsonString);
  const padding = (4 - (jsonBytes.length % 4)) % 4;
  const padded = new Uint8Array(jsonBytes.length + padding);
  padded.set(jsonBytes, 0);
  for (let i = jsonBytes.length; i < padded.length; i++) {
    padded[i] = 0x20; // space
  }
  return padded;
}

function createGlb(jsonChunk, binaryChunk) {
  const JSON_TYPE = 0x4e4f534a;
  const BIN_TYPE = 0x004e4942;

  const binaryPadding = (4 - (binaryChunk.length % 4)) % 4;
  let binaryBuffer = binaryChunk;
  if (binaryPadding) {
    const paddedBinary = new Uint8Array(binaryChunk.length + binaryPadding);
    paddedBinary.set(binaryChunk, 0);
    binaryBuffer = paddedBinary;
  }

  const totalLength = 12 + 8 + jsonChunk.length + 8 + binaryBuffer.length;
  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  view.setUint32(0, 0x46546c67, true); // magic
  view.setUint32(4, 2, true); // version
  view.setUint32(8, totalLength, true);

  let offset = 12;
  view.setUint32(offset, jsonChunk.length, true);
  view.setUint32(offset + 4, JSON_TYPE, true);
  offset += 8;
  out.set(jsonChunk, offset);
  offset += jsonChunk.length;

  view.setUint32(offset, binaryBuffer.length, true);
  view.setUint32(offset + 4, BIN_TYPE, true);
  offset += 8;
  out.set(binaryBuffer, offset);

  return new Uint8Array(buffer);
}

export async function createGlbBlob(options) {
  const {
    mesh,
    modelMatrix,
    meshName = 'DepthMesh',
    includeUVs = true,
    texture = null,
  } = options || {};

  if (!mesh || !mesh.positions || !mesh.indices) {
    throw new Error('Mesh data missing for glTF export.');
  }

  const name = meshName && meshName.trim() ? meshName : 'DepthMesh';

  const positions = toFloat32(mesh.positions);
  const indices = toUint32(mesh.indices);
  const normals = computeVertexNormals(positions, indices);
  const uvs = includeUVs && mesh.uvs ? new Float32Array(mesh.uvs) : null;
  const { min, max } = computeBounds(positions);

  const matrixArray = modelMatrix ? Array.from(modelMatrix) : undefined;

  const binary = createBinaryBuffer();
  const POSITION_TARGET = 34962;
  const INDEX_TARGET = 34963;

  const positionViewIndex = binary.append(positions, { target: POSITION_TARGET });
  const normalViewIndex = binary.append(normals, { target: POSITION_TARGET });
  const uvViewIndex = uvs ? binary.append(uvs, { target: POSITION_TARGET }) : null;
  const indexViewIndex = binary.append(indices, { target: INDEX_TARGET });

  let imageBytes = null;
  if (texture && texture.imageData) {
    imageBytes = await encodeImageData(texture.imageData);
    if (!imageBytes) {
      throw new Error('Failed to encode texture image.');
    }
  }

  const imageViewIndex = imageBytes ? binary.append(imageBytes, { align: 4 }) : null;

  const { buffer: binaryBuffer, bufferViews, byteLength } = binary.finalize();

  const accessors = [];
  const accessorIndices = {};

  accessorIndices.position = accessors.length;
  accessors.push({
    bufferView: positionViewIndex,
    componentType: 5126,
    count: positions.length / 3,
    type: 'VEC3',
    min,
    max,
  });

  accessorIndices.normal = accessors.length;
  accessors.push({
    bufferView: normalViewIndex,
    componentType: 5126,
    count: normals.length / 3,
    type: 'VEC3',
  });

  if (uvViewIndex !== null) {
    accessorIndices.uv = accessors.length;
    accessors.push({
      bufferView: uvViewIndex,
      componentType: 5126,
      count: uvs.length / 2,
      type: 'VEC2',
    });
  }

  accessorIndices.indices = accessors.length;
  accessors.push({
    bufferView: indexViewIndex,
    componentType: 5125,
    count: indices.length,
    type: 'SCALAR',
  });

  const attributes = {
    POSITION: accessorIndices.position,
    NORMAL: accessorIndices.normal,
  };
  if (uvViewIndex !== null) {
    attributes.TEXCOORD_0 = accessorIndices.uv;
  }

  const samplers = imageBytes ? [{
    magFilter: 9729,
    minFilter: 9987,
    wrapS: 10497,
    wrapT: 10497,
  }] : [];

  const textures = imageBytes ? [{
    sampler: 0,
    source: 0,
  }] : [];

  const images = imageBytes ? [{
    bufferView: imageViewIndex,
    mimeType: 'image/png',
  }] : [];

  const materials = [{
    name: `${name}_Material`,
    pbrMetallicRoughness: imageBytes ? {
      baseColorTexture: { index: 0 },
      metallicFactor: 0,
      roughnessFactor: 1,
    } : {
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 0,
      roughnessFactor: 1,
    },
    extensions: {
      KHR_materials_unlit: {},
    },
  }];

  const meshDef = {
    name,
    primitives: [
      {
        attributes,
        indices: accessorIndices.indices,
        material: 0,
      },
    ],
  };

  const node = {
    mesh: 0,
  };
  if (matrixArray && matrixArray.length === 16) {
    node.matrix = Array.from(matrixArray);
  }

  const json = {
    asset: {
      version: '2.0',
      generator: 'Image-to-Depth Web Viewer',
    },
    buffers: [
      {
        byteLength,
      },
    ],
    bufferViews,
    accessors,
    meshes: [meshDef],
    nodes: [node],
    scenes: [
      {
        nodes: [0],
      },
    ],
    scene: 0,
    materials,
  };

  const usedExtensions = ['KHR_materials_unlit'];
  json.extensionsUsed = usedExtensions;
  json.extensionsRequired = usedExtensions;

  if (samplers.length > 0) {
    json.samplers = samplers;
  }
  if (textures.length > 0) {
    json.textures = textures;
  }
  if (images.length > 0) {
    json.images = images;
  }

  const jsonChunk = createJsonChunk(json);
  const glbBytes = createGlb(jsonChunk, binaryBuffer);
  return new Blob([glbBytes], { type: 'model/gltf-binary' });
}
