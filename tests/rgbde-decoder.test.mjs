import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import {
  DEPTH_METADATA_KEYWORD,
  decodeRgbdeComponentsFromBlob,
  focalLengthToFovDeg,
  normalizeDepthMetadata,
} from '../webapp/src/rgbde-decoder.js';

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('normalizes focal-length metadata and computes fallback fov', () => {
  const metadata = normalizeDepthMetadata({
    source_file: 'sample.png',
    width: 4,
    height: 2,
    input_focal_length_px: 50,
    focallength_px: 100,
  }, 4, 2);

  assert.equal(metadata.sourceFile, 'sample.png');
  assert.equal(metadata.focalLengthPx, 100);
  assert.equal(metadata.inputFocalLengthPx, 50);
  assert.equal(metadata.horizontalFovDeg, focalLengthToFovDeg(4, 100));
  assert.equal(metadata.verticalFovDeg, focalLengthToFovDeg(2, 100));
});

test('decodes LookingGlassGoDepthMetadata from RGBDE PNG iTXt', async () => {
  const metadata = {
    source_file: 'source.png',
    width: 2,
    height: 1,
    input_focal_length_px: 20,
    focallength_px: 40,
    vertical_fov_deg: 18,
    horizontal_fov_deg: 32,
  };
  const pngBytes = makeRgbdePng({ metadata });
  const decoded = await decodeRgbdeComponentsFromBlob(new Blob([pngBytes], { type: 'image/png' }));

  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 1);
  assert.equal(decoded.metadata.sourceFile, 'source.png');
  assert.equal(decoded.metadata.focalLengthPx, 40);
  assert.equal(decoded.metadata.verticalFovDeg, 18);
  assert.deepEqual(Array.from(decoded.depth), [1, 2.5]);
});

function makeRgbdePng({ metadata }) {
  const width = 4;
  const height = 1;
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const raw = new Uint8Array(1 + width * height * 4);
  raw[0] = 0;
  raw.set([
    10, 20, 30, 255,
    40, 50, 60, 255,
    ...encodeDepth(1),
    ...encodeDepth(2.5),
  ], 1);

  return concatBytes(
    PNG_SIGNATURE,
    makeChunk('IHDR', ihdr),
    makeITxtChunk(DEPTH_METADATA_KEYWORD, JSON.stringify(metadata)),
    makeChunk('IDAT', deflateSync(raw)),
    makeChunk('IEND', new Uint8Array()),
  );
}

function encodeDepth(meters) {
  const value = Math.round(meters * 10000);
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
}

function makeITxtChunk(keyword, text) {
  const keywordBytes = new TextEncoder().encode(keyword);
  const textBytes = new TextEncoder().encode(text);
  return makeChunk('iTXt', concatBytes(
    keywordBytes,
    Uint8Array.from([0, 0, 0, 0, 0]),
    textBytes,
  ));
}

function makeChunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, data.length);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(concatBytes(typeBytes, data)));
  return concatBytes(length, typeBytes, data, crc);
}

function concatBytes(...chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
