const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

const COMPONENTS_PER_TYPE = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
};

const COMPONENT_INFO = {
  5121: { ArrayType: Uint8Array, bytes: 1 },
  5123: { ArrayType: Uint16Array, bytes: 2 },
  5125: { ArrayType: Uint32Array, bytes: 4 },
  5126: { ArrayType: Float32Array, bytes: 4 },
};

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return value;
}

function requireArrayEntry(collection, index, label) {
  if (!Array.isArray(collection) || !Number.isInteger(index) || !collection[index]) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return collection[index];
}

function computeBounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis];
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}

function readAccessor(json, binary, accessorIndex, expectation) {
  const accessor = requireArrayEntry(json.accessors, accessorIndex, `${expectation.label} accessor`);
  if (accessor.sparse || accessor.normalized) {
    throw new Error(`${expectation.label} accessor uses an unsupported sparse or normalized layout.`);
  }
  if (accessor.type !== expectation.type || accessor.componentType !== expectation.componentType) {
    throw new Error(`${expectation.label} accessor must be ${expectation.type}/${expectation.componentType}.`);
  }
  if (!Number.isInteger(accessor.count) || accessor.count <= 0) {
    throw new Error(`${expectation.label} accessor count is invalid.`);
  }

  const view = requireArrayEntry(json.bufferViews, accessor.bufferView, `${expectation.label} bufferView`);
  if (view.buffer !== undefined && view.buffer !== 0) {
    throw new Error(`${expectation.label} references an unsupported external buffer.`);
  }
  const component = COMPONENT_INFO[accessor.componentType];
  const componentCount = COMPONENTS_PER_TYPE[accessor.type];
  const elementBytes = component.bytes * componentCount;
  if (view.byteStride !== undefined && view.byteStride !== elementBytes) {
    throw new Error(`${expectation.label} uses an unsupported interleaved bufferView.`);
  }

  const viewOffset = view.byteOffset || 0;
  const accessorOffset = accessor.byteOffset || 0;
  const byteLength = accessor.count * elementBytes;
  const absoluteOffset = viewOffset + accessorOffset;
  const viewLength = view.byteLength;
  if (!Number.isInteger(viewLength) || absoluteOffset < viewOffset
      || accessorOffset + byteLength > viewLength
      || absoluteOffset + byteLength > binary.byteLength) {
    throw new Error(`${expectation.label} accessor exceeds the binary chunk.`);
  }
  if (absoluteOffset % component.bytes !== 0) {
    throw new Error(`${expectation.label} accessor is not component-aligned.`);
  }

  const source = new component.ArrayType(
    binary.buffer,
    binary.byteOffset + absoluteOffset,
    accessor.count * componentCount,
  );
  return new component.ArrayType(source);
}

function readIndices(json, binary, accessorIndex) {
  const accessor = requireArrayEntry(json.accessors, accessorIndex, 'indices accessor');
  if (![5121, 5123, 5125].includes(accessor.componentType)) {
    throw new Error('indices accessor must use an unsigned integer component type.');
  }
  const source = readAccessor(json, binary, accessorIndex, {
    label: 'indices',
    type: 'SCALAR',
    componentType: accessor.componentType,
  });
  return source;
}

function readImage(json, binary, primitive) {
  const material = requireArrayEntry(json.materials, primitive.material, 'textured material');
  const textureIndex = material.pbrMetallicRoughness?.baseColorTexture?.index;
  const texture = requireArrayEntry(json.textures, textureIndex, 'base color texture');
  const image = requireArrayEntry(json.images, texture.source, 'embedded image');
  if (image.mimeType !== 'image/png' || image.uri) {
    throw new Error('Embedded base color image must be a PNG bufferView.');
  }
  const view = requireArrayEntry(json.bufferViews, image.bufferView, 'image bufferView');
  const offset = view.byteOffset || 0;
  if (!Number.isInteger(view.byteLength) || view.byteLength <= 0
      || offset < 0 || offset + view.byteLength > binary.byteLength) {
    throw new Error('Embedded PNG exceeds the binary chunk.');
  }
  return new Uint8Array(binary.slice(offset, offset + view.byteLength));
}

export function parseGlb(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < 20) {
    throw new Error('GLB data is too short.');
  }
  const header = new DataView(arrayBuffer);
  if (header.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error('Invalid GLB magic.');
  }
  if (header.getUint32(4, true) !== GLB_VERSION) {
    throw new Error('Only GLB version 2 is supported.');
  }
  const declaredLength = header.getUint32(8, true);
  if (declaredLength !== arrayBuffer.byteLength) {
    throw new Error('GLB declared length does not match the response size.');
  }

  let jsonBytes = null;
  let binary = null;
  let offset = 12;
  while (offset < declaredLength) {
    if (offset + 8 > declaredLength) {
      throw new Error('GLB chunk header is truncated.');
    }
    const length = header.getUint32(offset, true);
    const type = header.getUint32(offset + 4, true);
    offset += 8;
    if (length < 0 || offset + length > declaredLength) {
      throw new Error('GLB chunk exceeds the declared length.');
    }
    const bytes = new Uint8Array(arrayBuffer, offset, length);
    if (type === JSON_CHUNK && jsonBytes === null) {
      jsonBytes = bytes;
    } else if (type === BIN_CHUNK && binary === null) {
      binary = bytes;
    }
    offset += length;
  }
  if (!jsonBytes || !binary) {
    throw new Error('GLB must contain one JSON chunk and one BIN chunk.');
  }

  let json;
  try {
    const text = new TextDecoder().decode(jsonBytes).replace(/\0+$/u, '').trim();
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`GLB JSON is invalid: ${error.message}`);
  }
  requireObject(json, 'GLB JSON');

  const sceneDefinition = requireArrayEntry(json.scenes, json.scene ?? 0, 'default scene');
  const nodeIndex = Array.isArray(sceneDefinition.nodes) ? sceneDefinition.nodes[0] : null;
  const node = requireArrayEntry(json.nodes, nodeIndex, 'scene node');
  const mesh = requireArrayEntry(json.meshes, node.mesh, 'scene mesh');
  const primitive = Array.isArray(mesh.primitives) ? mesh.primitives[0] : null;
  requireObject(primitive, 'mesh primitive');

  const positions = readAccessor(json, binary, primitive.attributes?.POSITION, {
    label: 'POSITION',
    type: 'VEC3',
    componentType: 5126,
  });
  const uvs = readAccessor(json, binary, primitive.attributes?.TEXCOORD_0, {
    label: 'TEXCOORD_0',
    type: 'VEC2',
    componentType: 5126,
  });
  const indices = readIndices(json, binary, primitive.indices);
  if (uvs.length / 2 !== positions.length / 3) {
    throw new Error('TEXCOORD_0 count must match POSITION count.');
  }
  for (const index of indices) {
    if (index >= positions.length / 3) {
      throw new Error('Index references a vertex outside POSITION.');
    }
  }

  const imageBytes = readImage(json, binary, primitive);
  let nodeMatrix = null;
  if (node.matrix !== undefined) {
    if (!Array.isArray(node.matrix) || node.matrix.length !== 16
        || node.matrix.some((value) => !Number.isFinite(value))) {
      throw new Error('Scene node matrix must contain 16 finite numbers.');
    }
    nodeMatrix = new Float32Array(node.matrix);
  }

  return {
    positions,
    uvs,
    indices,
    imageBlob: new Blob([imageBytes], { type: 'image/png' }),
    nodeMatrix,
    bounds: computeBounds(positions),
  };
}
