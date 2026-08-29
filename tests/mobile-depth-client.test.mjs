import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MobileDepthRequestAborted,
  requestRgbdeForImage,
  validateFocalLength35mm,
} from '../webapp/src/mobile-depth-client.js';


function sourceFile() {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
  Object.defineProperty(blob, 'name', { value: 'phone.jpg' });
  return blob;
}


test('depth request posts multipart image to the same-origin endpoint', async () => {
  const phases = [];
  let seen;
  const result = await requestRgbdeForImage(sourceFile(), {
    onPhase: (phase) => phases.push(phase),
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: {
          'Content-Type': 'image/png',
          'X-RGBDE-Filename': 'phone_RGBDE.png',
        },
      });
    },
  });
  assert.equal(seen.url, '/api/process');
  assert.equal(seen.options.method, 'POST');
  assert.equal(seen.options.body.get('image').type, 'image/jpeg');
  assert.equal(seen.options.body.has('focal_length_35mm'), false);
  assert.equal(result.type, 'image/png');
  assert.equal(result.name, 'phone_RGBDE.png');
  assert.deepEqual(phases, ['Sending image', 'Estimating depth']);
});


test('35 mm-equivalent override is explicit, bounded, and sent once', async () => {
  let calls = 0;
  let form;
  let endpoint;
  await requestRgbdeForImage(sourceFile(), {
    focalLength35mm: 28,
    fetchImpl: async (url, options) => {
      calls += 1;
      endpoint = url;
      form = options.body;
      return new Response(new Uint8Array([1]), {
        headers: { 'Content-Type': 'image/png' },
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(endpoint, '/api/process?focal_length_35mm=28');
  assert.equal(form.has('focal_length_35mm'), false);
  assert.equal(validateFocalLength35mm('35.5'), 35.5);
  assert.equal(validateFocalLength35mm(''), null);

  let invalidCalls = 0;
  await assert.rejects(() => requestRgbdeForImage(sourceFile(), {
    focalLength35mm: 9,
    fetchImpl: async () => {
      invalidCalls += 1;
      throw new Error('must not fetch');
    },
  }), /10 to 800 mm/);
  assert.equal(invalidCalls, 0);
});


test('encoded response filename wins and backend JSON detail is surfaced', async () => {
  const result = await requestRgbdeForImage(sourceFile(), {
    fetchImpl: async () => new Response(new Uint8Array([1]), {
      headers: {
        'Content-Type': 'image/png',
        'X-RGBDE-Filename': 'fallback.png',
        'X-RGBDE-Filename-Encoded': '%E6%B7%B1%E5%BA%A6.png',
      },
    }),
  });
  assert.equal(result.name, '深度.png');
  await assert.rejects(() => requestRgbdeForImage(sourceFile(), {
    fetchImpl: async () => new Response(JSON.stringify({ detail: 'image too large' }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    }),
  }), /image too large/);
});


test('unexpected or empty responses are rejected', async () => {
  await assert.rejects(() => requestRgbdeForImage(sourceFile(), {
    fetchImpl: async () => new Response('not png', {
      headers: { 'Content-Type': 'text/plain' },
    }),
  }), /unexpected response type/);
  await assert.rejects(() => requestRgbdeForImage(sourceFile(), {
    fetchImpl: async () => new Response(new Uint8Array(), {
      headers: { 'Content-Type': 'image/png' },
    }),
  }), /empty RGBDE/);
});


test('an aborted request has a stable stale-request identity', async () => {
  const controller = new AbortController();
  const pending = requestRgbdeForImage(sourceFile(), {
    signal: controller.signal,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  controller.abort();
  await assert.rejects(pending, (error) => (
    error instanceof MobileDepthRequestAborted
      && error.name === 'AbortError'
      && error.code === 'stale-request'
  ));
});
