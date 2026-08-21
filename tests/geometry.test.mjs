import assert from 'node:assert/strict';
import test from 'node:test';

import { generatePerspectiveMesh } from '../webapp/src/geometry.js';


function flatWall(size, distance) {
  return new Float32Array(size * size).fill(distance);
}


test('depth is unprojected along the optical axis, so a flat wall is flat', () => {
  // Depth Pro reports depth along the optical axis: `depth = 1 /
  // (canonical_inverse_depth * W / f_px)` is the pinhole relation between
  // disparity and z. Multiplying a unit ray by that figure treats it as a
  // distance along the ray and places everything off-axis too close, by the
  // cosine of its angle from the axis. A wall at a constant depth then bowed
  // towards the viewer at its edges, and across a face that gradient read as
  // the head being tilted.
  for (const fovDegrees of [32, 50, 65, 90]) {
    const mesh = generatePerspectiveMesh({
      depth: flatWall(9, 3),
      width: 9,
      height: 9,
      meshX: 8,
      meshY: 8,
      depthMin: 0.1,
      depthMax: 10,
      centerZ: 0,
      fovDegrees,
    });
    let min = Infinity;
    let max = -Infinity;
    for (let index = 2; index < mesh.positions.length; index += 3) {
      min = Math.min(min, mesh.positions[index]);
      max = Math.max(max, mesh.positions[index]);
    }
    assert.ok(max - min < 1e-6, `at ${fovDegrees} degrees the wall spread over ${max - min}`);
    assert.ok(Math.abs(min + 3) < 1e-6, `at ${fovDegrees} degrees the wall sat at ${min}`);
  }
});


test('the stored ray times the depth reproduces the position', () => {
  // `mesh-evaluator` rebuilds positions as ray times depth when magnification
  // or clipping change, so the two must agree.
  const mesh = generatePerspectiveMesh({
    depth: flatWall(5, 4),
    width: 5,
    height: 5,
    meshX: 4,
    meshY: 4,
    depthMin: 0.1,
    depthMax: 10,
    centerZ: 0,
    fovDegrees: 60,
  });
  for (let vertex = 0; vertex < mesh.baseDepths.length; vertex += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const rebuilt = mesh.rayDirections[vertex * 3 + axis] * mesh.baseDepths[vertex];
      assert.ok(
        Math.abs(rebuilt - mesh.positions[vertex * 3 + axis]) < 1e-6,
        `vertex ${vertex} axis ${axis}: ${rebuilt} vs ${mesh.positions[vertex * 3 + axis]}`,
      );
    }
  }
});


test('a sample keeps the image position it was sampled from', () => {
  // Unprojecting along the axis must not move a point sideways in the picture:
  // its screen position is the ray, and depth only sets how far along it sits.
  const mesh = generatePerspectiveMesh({
    depth: flatWall(5, 2),
    width: 5,
    height: 5,
    meshX: 4,
    meshY: 4,
    depthMin: 0.1,
    depthMax: 10,
    centerZ: 0,
    fovDegrees: 60,
  });
  for (let vertex = 0; vertex < mesh.baseDepths.length; vertex += 1) {
    const x = mesh.positions[vertex * 3];
    const y = mesh.positions[vertex * 3 + 1];
    const z = mesh.positions[vertex * 3 + 2];
    const u = mesh.uvs[vertex * 2];
    const v = mesh.uvs[vertex * 2 + 1];
    const halfWidth = Math.tan((60 * Math.PI) / 360);
    assert.ok(Math.abs(x / -z - (u - 0.5) * 2 * halfWidth) < 1e-6);
    assert.ok(Math.abs(y / -z - (0.5 - v) * 2 * halfWidth) < 1e-6);
  }
});
