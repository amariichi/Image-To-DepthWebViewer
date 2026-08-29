export const MAX_INSPECTION_ANGLE = Math.PI / 6;
// A wide reconstruction viewed on a portrait phone can need far less than
// 0.2× framing before its complete source frame is reachable. True Window uses
// this as an overview aperture only; it never scales the model or moves the
// reference camera. The low bound still prevents a degenerate projection.
export const MIN_TOUCH_SCALE = 0.02;
export const MAX_TOUCH_SCALE = 3;

const ROTATION_RADIANS_PER_PIXEL = (Math.PI / 180) * 0.12;
const PAN_WORLD_HEIGHT = 2;

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function createInteractionState(overrides = {}) {
  return {
    yaw: clamp(Number(overrides.yaw) || 0, -MAX_INSPECTION_ANGLE, MAX_INSPECTION_ANGLE),
    pitch: clamp(Number(overrides.pitch) || 0, -MAX_INSPECTION_ANGLE, MAX_INSPECTION_ANGLE),
    scale: clamp(Number(overrides.scale) || 1, MIN_TOUCH_SCALE, MAX_TOUCH_SCALE),
    panX: Number(overrides.panX) || 0,
    panY: Number(overrides.panY) || 0,
  };
}

export function applyDrag(startState, deltaX, deltaY) {
  return createInteractionState({
    ...startState,
    yaw: startState.yaw + deltaX * ROTATION_RADIANS_PER_PIXEL,
    pitch: startState.pitch + deltaY * ROTATION_RADIANS_PER_PIXEL,
  });
}

export function applyPinchPan(startState, {
  startDistance,
  currentDistance,
  deltaCenterX,
  deltaCenterY,
  viewportHeight,
}) {
  const safeHeight = Math.max(Number(viewportHeight) || 1, 1);
  const ratio = startDistance > 0 ? currentDistance / startDistance : 1;
  return createInteractionState({
    ...startState,
    scale: startState.scale * ratio,
    panX: startState.panX + (deltaCenterX / safeHeight) * PAN_WORLD_HEIGHT,
    panY: startState.panY - (deltaCenterY / safeHeight) * PAN_WORLD_HEIGHT,
  });
}

function twoPointerGeometry(points) {
  const [first, second] = points;
  return {
    centerX: (first.x + second.x) / 2,
    centerY: (first.y + second.y) / 2,
    distance: Math.hypot(second.x - first.x, second.y - first.y),
  };
}

export function createTouchInteraction(target, { onChange = () => {} } = {}) {
  const pointers = new Map();
  let state = createInteractionState();
  let baseline = null;

  function setBaseline() {
    const points = [...pointers.values()];
    if (points.length === 1) {
      baseline = { kind: 'drag', point: { ...points[0] }, state: { ...state } };
    } else if (points.length >= 2) {
      baseline = { kind: 'pinch', ...twoPointerGeometry(points.slice(0, 2)), state: { ...state } };
    } else {
      baseline = null;
    }
  }

  function emit() {
    onChange({ ...state });
  }

  function onPointerDown(event) {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      target.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic events and a pointer cancelled by the browser can race capture.
      // Gesture tracking remains valid inside the canvas without capture.
    }
    setBaseline();
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.values()];
    if (points.length === 1 && baseline?.kind === 'drag') {
      state = applyDrag(
        baseline.state,
        points[0].x - baseline.point.x,
        points[0].y - baseline.point.y,
      );
      emit();
    } else if (points.length >= 2 && baseline?.kind === 'pinch') {
      const current = twoPointerGeometry(points.slice(0, 2));
      state = applyPinchPan(baseline.state, {
        startDistance: baseline.distance,
        currentDistance: current.distance,
        deltaCenterX: current.centerX - baseline.centerX,
        deltaCenterY: current.centerY - baseline.centerY,
        viewportHeight: target.clientHeight,
      });
      emit();
    } else {
      setBaseline();
    }
    event.preventDefault();
  }

  function finishPointer(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    setBaseline();
    event.preventDefault();
  }

  target.addEventListener('pointerdown', onPointerDown);
  target.addEventListener('pointermove', onPointerMove);
  target.addEventListener('pointerup', finishPointer);
  target.addEventListener('pointercancel', finishPointer);

  return {
    getState: () => ({ ...state }),
    // The viewer controls sit over the canvas, so a finger that is part of a
    // pinch can land on one and activate it on release.
    activePointerCount: () => pointers.size,
    reset(nextState = {}) {
      pointers.clear();
      baseline = null;
      state = createInteractionState(nextState);
      emit();
    },
    cancelGesture() {
      pointers.clear();
      baseline = null;
    },
    destroy() {
      target.removeEventListener('pointerdown', onPointerDown);
      target.removeEventListener('pointermove', onPointerMove);
      target.removeEventListener('pointerup', finishPointer);
      target.removeEventListener('pointercancel', finishPointer);
      pointers.clear();
      baseline = null;
    },
  };
}
