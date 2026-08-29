export const DEFAULT_DOUBLE_TAP_MS = 320;
export const DEFAULT_TAP_MOVEMENT_PX = 18;

export function createMobileChromeMachine({
  doubleTapMs = DEFAULT_DOUBLE_TAP_MS,
  movementPx = DEFAULT_TAP_MOVEMENT_PX,
  onChange = () => {},
} = {}) {
  let hidden = false;
  let firstTap = null;
  let gestureInvalid = false;
  const pointers = new Map();

  function snapshot(changed = false) {
    return { hidden, changed };
  }

  function publish(nextHidden) {
    const changed = hidden !== nextHidden;
    hidden = nextHidden;
    firstTap = null;
    if (changed) onChange(snapshot(true));
    return snapshot(changed);
  }

  function cancelPending() {
    firstTap = null;
    gestureInvalid = true;
    return snapshot(false);
  }

  return {
    getState: () => snapshot(false),
    explicitToggle: () => publish(!hidden),
    revealForBlockingState: () => publish(false),
    cancelGesture() {
      pointers.clear();
      firstTap = null;
      gestureInvalid = false;
      return snapshot(false);
    },
    controlInteraction: cancelPending,
    pointerDown({ pointerId, x, y, time, interactive = false }) {
      if (interactive) return cancelPending();
      pointers.set(pointerId, { x, y, time, moved: false });
      if (pointers.size > 1) return cancelPending();
      gestureInvalid = false;
      return snapshot(false);
    },
    pointerMove({ pointerId, x, y }) {
      const pointer = pointers.get(pointerId);
      if (!pointer) return snapshot(false);
      if (Math.hypot(x - pointer.x, y - pointer.y) > movementPx) {
        pointer.moved = true;
        return cancelPending();
      }
      return snapshot(false);
    },
    pointerUp({ pointerId, x, y, time }) {
      const pointer = pointers.get(pointerId);
      pointers.delete(pointerId);
      if (!pointer || pointers.size > 0 || gestureInvalid || pointer.moved
          || Math.hypot(x - pointer.x, y - pointer.y) > movementPx) {
        if (pointers.size === 0) gestureInvalid = false;
        return snapshot(false);
      }
      const tap = { x, y, time };
      if (firstTap
          && time - firstTap.time >= 0
          && time - firstTap.time <= doubleTapMs
          && Math.hypot(x - firstTap.x, y - firstTap.y) <= movementPx) {
        return publish(!hidden);
      }
      firstTap = tap;
      return snapshot(false);
    },
    pointerCancel({ pointerId } = {}) {
      if (pointerId !== undefined) pointers.delete(pointerId);
      return cancelPending();
    },
  };
}
