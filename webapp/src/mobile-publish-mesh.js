export const MAX_MOBILE_PUBLISH_VERTICES = 65_535;
export const MAX_MOBILE_TEXTURE_DIMENSION = 2048;
export const MAX_MOBILE_TEXTURE_PIXELS = 2_000_000;


function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}


function chooseGridSize(meshX, meshY, maxVertices) {
  if ((meshX + 1) * (meshY + 1) <= maxVertices) return { meshX, meshY };
  const scale = Math.sqrt(maxVertices / ((meshX + 1) * (meshY + 1)));
  let outputX = Math.max(1, Math.floor(meshX * scale));
  let outputY = Math.max(1, Math.floor(meshY * scale));
  while ((outputX + 1) * (outputY + 1) > maxVertices) {
    if (outputX / meshX >= outputY / meshY && outputX > 1) outputX -= 1;
    else if (outputY > 1) outputY -= 1;
    else break;
  }
  return { meshX: outputX, meshY: outputY };
}


export function createMobilePublishMesh(source, {
  maxVertices = MAX_MOBILE_PUBLISH_VERTICES,
} = {}) {
  const meshX = positiveInteger(source?.meshX, 'source.meshX');
  const meshY = positiveInteger(source?.meshY, 'source.meshY');
  positiveInteger(maxVertices, 'maxVertices');
  const sourceVertices = (meshX + 1) * (meshY + 1);
  if (!(source.positions instanceof Float32Array)
      || source.positions.length !== sourceVertices * 3) {
    throw new Error('Mobile publish source POSITION data does not match its grid.');
  }
  if (!(source.uvs instanceof Float32Array) || source.uvs.length !== sourceVertices * 2) {
    throw new Error('Mobile publish source UV data does not match its grid.');
  }

  const output = chooseGridSize(meshX, meshY, maxVertices);
  const vertexCount = (output.meshX + 1) * (output.meshY + 1);
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  for (let y = 0; y <= output.meshY; y += 1) {
    const sourceY = Math.round((y / output.meshY) * meshY);
    for (let x = 0; x <= output.meshX; x += 1) {
      const sourceX = Math.round((x / output.meshX) * meshX);
      const sourceVertex = sourceY * (meshX + 1) + sourceX;
      const outputVertex = y * (output.meshX + 1) + x;
      positions.set(source.positions.subarray(sourceVertex * 3, sourceVertex * 3 + 3), outputVertex * 3);
      uvs.set(source.uvs.subarray(sourceVertex * 2, sourceVertex * 2 + 2), outputVertex * 2);
    }
  }

  const IndexArray = vertexCount <= 65_535 ? Uint16Array : Uint32Array;
  const indices = new IndexArray(output.meshX * output.meshY * 6);
  let triangleIndex = 0;
  for (let y = 0; y < output.meshY; y += 1) {
    for (let x = 0; x < output.meshX; x += 1) {
      const current = y * (output.meshX + 1) + x;
      const next = current + output.meshX + 1;
      indices[triangleIndex++] = current;
      indices[triangleIndex++] = next;
      indices[triangleIndex++] = current + 1;
      indices[triangleIndex++] = current + 1;
      indices[triangleIndex++] = next;
      indices[triangleIndex++] = next + 1;
    }
  }

  return {
    positions,
    uvs,
    indices,
    meshX: output.meshX,
    meshY: output.meshY,
    vertexCount,
    indexCount: indices.length,
  };
}


export function fitMobileTextureSize(width, height, {
  maxDimension = MAX_MOBILE_TEXTURE_DIMENSION,
  maxPixels = MAX_MOBILE_TEXTURE_PIXELS,
} = {}) {
  positiveInteger(width, 'width');
  positiveInteger(height, 'height');
  positiveInteger(maxDimension, 'maxDimension');
  positiveInteger(maxPixels, 'maxPixels');
  const scale = Math.min(
    1,
    maxDimension / Math.max(width, height),
    Math.sqrt(maxPixels / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}
