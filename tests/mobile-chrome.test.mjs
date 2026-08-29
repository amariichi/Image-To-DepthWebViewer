import assert from 'node:assert/strict';
import test from 'node:test';

import { createMobileChromeMachine } from '../webapp/src/mobile-chrome.js';

function tap(machine, pointerId, x, y, time) {
  machine.pointerDown({ pointerId, x, y, time });
  return machine.pointerUp({ pointerId, x, y, time: time + 20 });
}

test('two clean nearby stage taps hide chrome and the next pair restores it', () => {
  const machine = createMobileChromeMachine();
  assert.equal(tap(machine, 1, 100, 100, 0).changed, false);
  assert.deepEqual(tap(machine, 2, 106, 104, 220), { hidden: true, changed: true });
  tap(machine, 3, 100, 100, 600);
  assert.deepEqual(tap(machine, 4, 100, 100, 820), { hidden: false, changed: true });
});

test('slow, distant, dragged and control taps cannot toggle chrome', () => {
  const machine = createMobileChromeMachine({ doubleTapMs: 300, movementPx: 12 });
  tap(machine, 1, 0, 0, 0);
  assert.equal(tap(machine, 2, 0, 0, 400).hidden, false);
  tap(machine, 3, 0, 0, 800);
  assert.equal(tap(machine, 4, 30, 0, 900).hidden, false);
  machine.pointerDown({ pointerId: 5, x: 0, y: 0, time: 1200 });
  machine.pointerMove({ pointerId: 5, x: 20, y: 0 });
  machine.pointerUp({ pointerId: 5, x: 20, y: 0, time: 1250 });
  assert.equal(tap(machine, 6, 20, 0, 1300).hidden, false);
  machine.pointerDown({ pointerId: 7, x: 0, y: 0, time: 1600, interactive: true });
  machine.pointerUp({ pointerId: 7, x: 0, y: 0, time: 1620 });
  assert.equal(tap(machine, 8, 0, 0, 1700).hidden, false);
});

test('a second pointer cancels a pending double tap and current pinch', () => {
  const machine = createMobileChromeMachine();
  tap(machine, 1, 10, 10, 0);
  machine.pointerDown({ pointerId: 2, x: 10, y: 10, time: 100 });
  machine.pointerDown({ pointerId: 3, x: 30, y: 10, time: 110 });
  machine.pointerUp({ pointerId: 2, x: 10, y: 10, time: 150 });
  machine.pointerUp({ pointerId: 3, x: 30, y: 10, time: 160 });
  assert.equal(machine.getState().hidden, false);
  assert.equal(tap(machine, 4, 10, 10, 200).hidden, false);
});

test('explicit hide, blocking reveal and orientation cancellation are deterministic', () => {
  const changes = [];
  const machine = createMobileChromeMachine({ onChange: (state) => changes.push(state.hidden) });
  assert.deepEqual(machine.explicitToggle(), { hidden: true, changed: true });
  assert.deepEqual(machine.revealForBlockingState(), { hidden: false, changed: true });
  tap(machine, 1, 0, 0, 0);
  machine.cancelGesture();
  assert.equal(tap(machine, 2, 0, 0, 100).changed, false);
  assert.deepEqual(changes, [true, false]);
});
