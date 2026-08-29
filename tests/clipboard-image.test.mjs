import assert from 'node:assert/strict';
import test from 'node:test';

import {
  imageFromPasteEvent,
  nameForType,
  pickImageType,
  readImageFromClipboard,
} from '../webapp/src/clipboard-image.js';


function imageBlob(type, name = 'fixture') {
  const blob = new Blob([new Uint8Array([1])], { type });
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
}


test('clipboard type selection prefers PNG but accepts any image', () => {
  assert.equal(pickImageType(['image/jpeg', 'image/png']), 'image/png');
  assert.equal(pickImageType(['text/plain', 'image/heic']), 'image/heic');
  assert.equal(pickImageType(['text/plain']), null);
  assert.equal(nameForType('image/jpeg', new Date('2026-08-22T16:04:05Z')),
    'pasted-20260822T160405.jpg');
});


test('keyboard paste selects the first image file and falls back to files', () => {
  const png = imageBlob('image/png', 'a.png');
  const event = {
    clipboardData: {
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => png },
      ],
      files: [],
    },
  };
  assert.equal(imageFromPasteEvent(event), png);
  assert.equal(imageFromPasteEvent({ clipboardData: { items: [], files: [png] } }), png);
  assert.equal(imageFromPasteEvent({ clipboardData: null }), null);
});


test('explicit clipboard read reports success, unsupported, denied and empty', async () => {
  const png = imageBlob('image/png');
  const success = await readImageFromClipboard({
    clipboard: {
      read: async () => [{ types: ['image/png'], getType: async () => png }],
    },
  });
  assert.equal(success.ok, true);
  assert.equal(success.file.type, 'image/png');
  assert.match(success.file.name, /^pasted-.*\.png$/u);
  assert.deepEqual(await readImageFromClipboard({ clipboard: {} }), {
    ok: false, reason: 'unsupported',
  });
  assert.deepEqual(await readImageFromClipboard({
    clipboard: { read: async () => { throw new Error('NotAllowedError'); } },
  }), { ok: false, reason: 'denied' });
  assert.deepEqual(await readImageFromClipboard({
    clipboard: { read: async () => [{ types: ['text/plain'] }] },
  }), { ok: false, reason: 'empty' });
});


test('clipboard read skips an item that disappeared and tries the next image', async () => {
  const jpeg = imageBlob('image/jpeg');
  const result = await readImageFromClipboard({
    clipboard: {
      read: async () => [
        { types: ['image/png'], getType: async () => { throw new Error('gone'); } },
        { types: ['image/jpeg'], getType: async () => jpeg },
      ],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.file.type, 'image/jpeg');
});
