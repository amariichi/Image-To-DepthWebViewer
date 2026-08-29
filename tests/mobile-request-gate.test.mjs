import assert from 'node:assert/strict';
import test from 'node:test';

import { createLatestRequestGate } from '../webapp/src/mobile-request-gate.js';


test('a newer source generation aborts and rejects an older result', () => {
  const gate = createLatestRequestGate();
  const first = gate.begin();
  assert.equal(gate.isCurrent(first.generation), true);
  const second = gate.begin();
  assert.equal(first.signal.aborted, true);
  assert.equal(gate.isCurrent(first.generation), false);
  assert.equal(gate.isCurrent(second.generation), true);
  gate.cancel();
  assert.equal(second.signal.aborted, true);
  assert.equal(gate.isCurrent(second.generation), false);
});
