// MediaPipe's metric face pose assumes a canonical face and camera lens. A
// tape-measured distance supplies one multiplicative correction for all XYZ.

// v2 follows the cyclopean-eye matrix transform. A multiplier calibrated
// against v1's face-model origin would bias the new physical eye distance.
export const HEAD_DISTANCE_SCALE_STORAGE_KEY = 'rgbde-mobile-head-distance-scale-v2';
export const MIN_DISTANCE_SCALE = 0.2;
export const MAX_DISTANCE_SCALE = 5;

export function clampDistanceScale(scale) {
  if (!Number.isFinite(scale) || !(scale > 0)) return 1;
  return Math.min(Math.max(scale, MIN_DISTANCE_SCALE), MAX_DISTANCE_SCALE);
}

export function distanceScaleFrom(reportedMm, actualMm) {
  if (!Number.isFinite(reportedMm) || !Number.isFinite(actualMm)
      || !(reportedMm > 0) || !(actualMm > 0)) return 1;
  return clampDistanceScale(actualMm / reportedMm);
}

export function loadDistanceScale(storage) {
  try {
    const raw = storage?.getItem?.(HEAD_DISTANCE_SCALE_STORAGE_KEY);
    return raw === null || raw === undefined ? 1 : clampDistanceScale(Number(raw));
  } catch {
    return 1;
  }
}

export function saveDistanceScale(storage, scale) {
  try {
    const value = clampDistanceScale(scale);
    if (value === 1) storage?.removeItem?.(HEAD_DISTANCE_SCALE_STORAGE_KEY);
    else storage?.setItem?.(HEAD_DISTANCE_SCALE_STORAGE_KEY, String(value));
  } catch {
    // The current session remains calibrated if private browsing rejects storage.
  }
}
