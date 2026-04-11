# Establish CI-Gated Performance Improvement Workflow And Deliver Responsiveness Improvements

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This document must be maintained in accordance with `.agent/PLANS.md`.

## Purpose / Big Picture

After this change, work on this repository should happen through the same safer path the user now prefers elsewhere: create a branch, open a pull request, and require GitHub Actions checks before merge. Within that workflow, the app itself should also become faster and more responsive: RGBDE preprocessing should take less JavaScript time, the desktop viewer should stop redrawing continuously while idle, and depth-shaping sliders should become smooth even on dense meshes.

This plan intentionally starts with workflow hardening before performance work. The repository currently has no `.github/` directory, no CI workflow, and no JavaScript package metadata for linting. That means the safest next step is not “optimize first,” but “install the guardrails first, then optimize under those guardrails.”

## Progress

- [x] (2026-04-06 00:00 JST) Reviewed `.agent/PLANS.md` and `.agent/improvement_suggestion.md`.
- [x] (2026-04-06 00:00 JST) Inspected the current frontend and backend hot paths and wrote the first version of this plan.
- [x] (2026-04-06 22:12 JST) Reworked the plan so branch creation, PR-based delivery, and CI setup are the first milestone instead of an afterthought.
- [x] (2026-04-06 22:29 JST) Created branch `feat/rgbde-performance-improvements` for this work.
- [x] (2026-04-06 22:29 JST) Added local CI scaffolding: `.github/workflows/ci.yml`, `package.json`, `package-lock.json`, `eslint.config.js`, `scripts/check-js.mjs`, `tests/test_server_main.py`, and lazy backend service import in `server/main.py`.
- [x] (2026-04-06 22:29 JST) Verified Milestone 1 locally with `npm run check:js`, `npm run lint`, and `.venv/bin/python -m unittest discover -s tests -p 'test_*.py'`.
- [ ] Push the branch and confirm GitHub Actions passes in the remote PR environment.
- [ ] Mark the CI checks as required on pull requests after the workflow names settle.
- [x] (2026-04-06 22:47 JST) Implemented the local code for Milestone 2: extracted `webapp/src/depth-processing.js`, added `scripts/generate_perf_fixtures.py`, generated `webapp/test-assets/`, added `webapp/perf-harness.html`, and landed the low-risk preprocessing and backend PNG changes.
- [x] (2026-04-06 22:47 JST) Verified Milestone 2 locally: `npm run check:js`, `npm run lint`, `.venv/bin/python -m unittest discover -s tests -p 'test_*.py'`, and a browser run of `http://127.0.0.1:5173/perf-harness.html` completed with frontend timing rows for `rgbde-small` and `rgbde-large`.
- [x] (2026-04-06 22:47 JST) Implemented the local code for Milestone 3: desktop rendering now uses `requestRender()`, model matrices are cached in `state.render.modelMatrix`, and `webapp/src/rendering.js` has in-place matrix helpers.
- [x] (2026-04-06 22:47 JST) Verified Milestone 3 locally: syntax, lint, and Python tests still pass, and the main app plus the performance harness both load in the browser after the render-scheduling refactor.
- [x] (2026-04-06 23:17 JST) Implemented the local code for Milestone 4: added `webapp/src/rgbde-decoder.js` and `webapp/src/rgbde-worker.js`, moved PNG decode plus depth preprocessing behind a worker-capable `decodeRgbdeFile()` path, added stale-load guards in `webapp/src/app.js`, and expanded `webapp/src/perf-harness.js` to compare main-thread and worker modes.
- [x] (2026-04-06 23:17 JST) Verified Milestone 4 locally: `npm run check:js`, `npm run lint`, and `.venv/bin/python -m unittest discover -s tests -p 'test_*.py'` all pass, `http://127.0.0.1:5173/perf-harness.html` reports both `main-thread` and `worker` rows for the repository-local RGBDE fixtures, and the main viewer successfully loads `webapp/test-assets/rgbde-small.png` through the file-open path.
- [x] (2026-04-06 23:33 JST) Implemented the local code for Milestone 5: added `webapp/src/mesh-evaluator.js`, moved display-time depth shaping into the vertex shader in `webapp/src/rendering.js`, changed `webapp/src/app.js` to update only shader uniforms plus CPU bounds, and switched glTF export to generate deformed CPU positions on demand instead of reusing a constantly mutated buffer.
- [x] (2026-04-06 23:33 JST) Verified Milestone 5 locally: syntax, lint, and Python tests still pass; the main viewer still loads `webapp/test-assets/rgbde-small.png`; depth sliders continue to update through the live UI; and a one-off parity check reported `maxDiff: 0` between the shared CPU evaluator and the previous CPU vertex-rewrite path.

## Surprises & Discoveries

- Observation: this repository currently has no `.github/` directory at all.
  Evidence: `rg --files .github .agent` reported `.github: No such file or directory`.

- Observation: the repository has Python dependencies in `requirements.txt`, but no `package.json`, so JavaScript linting is not yet wired into the project.
  Evidence: the repository root contains `requirements.txt` and `webapp/` sources, but no npm metadata or frontend toolchain files.

- Observation: `server/main.py` imported `.depth_service` eagerly, which would pull in torch and Depth Pro just to import filename helpers in tests.
  Evidence: before the Milestone 1 patch, `server/main.py` imported `DepthProService`, `DepthResult`, and `get_depth_service` at module import time.

- Observation: bootstrap-created `.venv/` and `checkpoints/` directories appear as untracked repository content unless they are ignored explicitly.
  Evidence: `git status --short` after bootstrap showed both `.venv/` and `checkpoints/` as untracked.

- Observation: the new performance harness can already exercise the frontend pipeline end to end without the backend.
  Evidence: the browser snapshot for `perf-harness.html` showed populated rows for `rgbde-small` and `rgbde-large`, while the backend row was skipped with `Failed to fetch` because no backend server was running.

- Observation: the previous frontend server stayed bound to port 5173 across validation steps.
  Evidence: rerunning `python3 scripts/run_frontend.py` returned `OSError: [Errno 98] Address already in use`, but the existing server still served both `/` and `/perf-harness.html`.

- Observation: `syncMirrorControls()` is already called from most UI mutation sites, but `renderLoop()` still calls it every frame.
  Evidence: `webapp/src/app.js` calls `syncMirrorControls()` from slider handlers, `setUiHidden()`, `setDisplayMode()`, and again at the end of `renderLoop()`.

- Observation: the current bilateral smoother computes a color distance with `Math.sqrt`, then immediately squares that result inside `Math.exp(...)`.
  Evidence: `colorDistance()` in `webapp/src/geometry.js` returns `sqrt(dr*dr + dg*dg + db*db)`, while `applyEdgeAwareSmooth()` uses `Math.exp(-(colorDiff * colorDiff) / ...)`.

- Observation: `generatePerspectiveMesh()` allocates a fresh JavaScript array for every vertex through `normalize3()`.
  Evidence: `normalize3()` returns `[x / len, y / len, z / len]`, and `generatePerspectiveMesh()` calls it once per vertex for meshes that target about 250,000 triangles.

- Observation: the worker path improved responsiveness but not raw wall-clock time on the current local fixtures.
  Evidence: the harness showed `rgbde-large` at about `169.4 ms` total in `main-thread` mode versus about `185.5 ms` in `worker` mode, while the page stayed interactive and the viewer load path still completed successfully.

- Observation: GPU depth shaping cannot be treated as a rendering-only change because export and auto-fit still consume CPU positions and bounds.
  Evidence: `updateDepthTransform()` mutates `mesh.positions`; `refreshAutoFit()` can read `state.mesh.positions`; `createGlbBlob()` copies `mesh.positions` into the exported GLB.

- Observation: a shared CPU evaluator makes the shader path and export path easy to keep bit-for-bit aligned with the earlier CPU rewrite formula.
  Evidence: after adding `webapp/src/mesh-evaluator.js`, a local comparison between `updateVertexPositions()` and `createDeformedPositions()` returned `maxDiff: 0` on a sample mesh.

- Observation: half-precision inference is explicitly out of scope for this plan.
  Evidence: the note appended to `.agent/improvement_suggestion.md` says it is not acceptable because Depth Pro outputs float data.

## Decision Log

- Decision: put branch creation and CI setup ahead of performance implementation.
  Rationale: the user wants branch-based PR work with required GitHub Actions checks, and the repository does not currently provide those protections.
  Date/Author: 2026-04-06 / Codex

- Decision: make the first JavaScript checks lightweight: `node --check` first, then ESLint.
  Rationale: the repository has no existing npm toolchain, so syntax checking is the cheapest first safeguard; ESLint can follow immediately once `package.json` is added.
  Date/Author: 2026-04-06 / Codex

- Decision: include a minimal npm setup as part of CI enablement.
  Rationale: GitHub Actions should be able to run a stable JavaScript check in CI, and that is easier to maintain once the repository declares its frontend dev dependencies explicitly.
  Date/Author: 2026-04-06 / Codex

- Decision: keep the performance work staged even after CI is added.
  Rationale: the repository already works, so the first runtime changes should still be safe and measurable before deeper structural work.
  Date/Author: 2026-04-06 / Codex

- Decision: keep a CPU evaluator for exported geometry and bounds even after shader-based deformation lands.
  Rationale: `Save glTF` must still export the geometry the user sees, and auto-fit still needs deformed bounds after magnification, log mode, or far clip changes.
  Date/Author: 2026-04-06 / Codex

- Decision: do not pursue float16 or bfloat16 inference in this plan.
  Rationale: the user has already ruled that out, and it is not required for the observable browser-side responsiveness goals.
  Date/Author: 2026-04-06 / Codex

## Outcomes & Retrospective

Milestone 1 is locally complete. The repository now has branch-local CI scaffolding, lightweight JavaScript checks, and backend tests that do not require loading the Depth Pro model. One backend helper bug was exposed and fixed while writing the tests: filenames that sanitized down to only the `.png` suffix previously became `png.png` instead of falling back to a safe default stem.

The remaining Milestone 1 work is remote-only: push the branch, open the PR, and verify the GitHub Actions workflow names and required-check configuration on GitHub itself.

Milestone 2 is locally complete for the frontend and backend code paths. The repository now contains deterministic benchmark fixtures, a browser-visible harness page, and the first safe runtime optimizations: a no-allocation direction calculation in `generatePerspectiveMesh()`, a reusable median-of-nine helper, squared color-distance weighting in the bilateral smoother, removal of the noisy depth debug logs, a bounded `normalizeAngle()`, and a faster backend PNG compression setting.

Milestone 3 is locally complete. Desktop rendering is now scheduled on demand, not via a permanent `requestAnimationFrame` loop, and the model matrix path no longer allocates a chain of new `Float32Array` instances per redraw.

Milestone 4 is locally complete. RGBDE PNG decode and depth preprocessing can now run in a dedicated web worker, the main viewer ignores stale decode results when a newer load starts, and the performance harness can compare main-thread and worker modes explicitly. The current benchmark fixtures show that worker mode is slightly slower in total elapsed time, which is acceptable for this milestone because the goal was main-thread responsiveness, not guaranteed throughput improvement.

Milestone 5 is locally complete. Depth shaping now happens in the vertex shader for display, while `webapp/src/mesh-evaluator.js` preserves the same shaping formula for bounds and export-time CPU geometry generation. That removes the per-slider vertex-buffer rewrite from the interactive path without giving up CPU-side export parity.

## Context and Orientation

This repository is a two-part toolchain. The browser viewer lives under `webapp/`, and the Depth Pro backend lives under `server/`.

The files and directories that matter for this plan are:

`webapp/src/geometry.js` reads RGBDE PNG files, decodes the depth half, smooths the depth map, and generates the perspective mesh. This is where the current median filter, bilateral smoother, PNG parser, and CPU-side `updateVertexPositions()` live.

`webapp/src/app.js` owns the application state, UI listeners, desktop render loop, mirror-panel synchronization, mesh rebuild flow, auto-fit behavior, and export entry points. This is where the unconditional desktop `requestAnimationFrame` loop lives.

`webapp/src/rendering.js` owns the WebGL2 program, mesh buffer uploads, texture upload, and matrix utilities. Right now the vertex shader only multiplies `aPosition` by `uModel`, `uView`, and `uProjection`, so all depth shaping happens on the CPU.

`webapp/src/gltf-exporter.js` exports the currently displayed mesh to a binary glTF (`.glb`). It reads `mesh.positions` directly, so any future GPU path must still provide identical CPU-side geometry when exporting.

`server/depth_service.py` runs Depth Pro, converts the predicted depth map into RGBA bytes, and saves the output PNG. Its `compress_level=9` setting favors file size over latency.

`server/main.py` exposes `/api/status` and `/api/process`. It is not a major performance hotspot, but it is the right place to preserve backend behavior while performance work lands underneath it.

`.github/workflows/` does not exist yet. This plan will create it.

`package.json` does not exist yet. This plan will add it so JavaScript checks can run in CI in a repeatable way.

In this plan, “RGBDE PNG” means one PNG file whose left half is RGBA color and whose right half stores a 32-bit depth value split across four 8-bit channels. “Auto-fit” means the code in `webapp/src/app.js` that derives `state.pivotZ` and `state.autoTranslationZ` from the current mesh bounds so the subject remains framed after loading or depth shaping changes. “Depth shaping” means the magnification, linear/log mode, log power, and far clip transforms that currently rewrite every vertex in `updateVertexPositions()`.

## Milestones

### Milestone 1: Put branch and CI workflow in place first

At the end of this milestone, a novice should be able to create a dedicated feature branch, push it, open a pull request, and see GitHub Actions run automatically. The repository should have enough checks that the branch can be protected by required status checks before performance work continues.

This milestone has four deliverables.

First, create and use a dedicated feature branch for all work in this plan. The branch name should describe the combined workflow and performance effort, for example `feat/ci-and-performance-plan` or `feat/rgbde-performance-improvements`. Do not work on `main`.

Second, create `.github/workflows/ci.yml` with at least two jobs. The Python job should install `requirements.txt` and run `python -m unittest discover -s tests -p 'test_*.py'`. The JavaScript job should install npm dependencies and run both a syntax check and a lint check.

Third, add minimal JavaScript tooling. Create `package.json` and `package-lock.json`, add a small set of dev dependencies centered on ESLint, and define scripts equivalent to:

    npm run check:js
    npm run lint

`npm run check:js` should use `node --check` over the browser JavaScript files under `webapp/src/`. `npm run lint` should run ESLint with a minimal, browser-aware configuration. Start with the smallest stable ruleset that catches obvious mistakes such as syntax errors, undefined names, and unused variables. Do not turn this into a large formatting or style migration.

Fourth, add the first Python tests under `tests/`. The initial target should be stable backend behavior, not model inference. Add tests around `server.main.build_download_headers()`, `server.main.ascii_safe_filename()`, and, where practical, backend encode helpers that do not require the Depth Pro model to load.

This milestone is complete when GitHub Actions passes on the branch, the JavaScript check job fails on a deliberate syntax error, the Python test job fails on a deliberate backend regression, and the user can reasonably make those checks required on pull requests.

### Milestone 2: Add measurement fixtures and land low-risk wins

At the end of this milestone, a novice should be able to run the app, open a repository-local performance harness, and compare before-and-after timings for RGBDE decode, depth preprocessing, mesh generation, and backend PNG generation. The repository should also contain the first batch of safe optimizations that do not change architecture.

Create deterministic fixtures under `tests/fixtures/` or `webapp/test-assets/` instead of relying on external images. Add one small RGBDE fixture and one larger RGBDE fixture for frontend timing, plus one regular PNG or JPG fixture for backend generation timing. If fixture files would be too large for the repository, add a deterministic generator script under `scripts/` and check in only the generated small fixture plus instructions for regenerating the larger one locally.

Add a browser-visible harness page such as `webapp/perf-harness.html` with a module script such as `webapp/src/perf-harness.js`. The harness should load the repository-local fixtures, call the same decode and mesh functions used by the app, and print timing rows to the page so a human can compare them without opening DevTools first.

Within `webapp/src/geometry.js`, extract or refactor the preprocessing helpers so the median-of-nine logic and color-distance logic are explicit and testable. The low-risk changes for this milestone are:

replace `Array.from(window).sort(...)` with a fixed-size median helper,

precompute bilateral sigma denominators,

use squared color distance where the code later squares the value anyway,

remove the temporary array allocation created by `normalize3()`,

remove or demote the current production `console.info` depth-debug logging,

replace `normalizeAngle()`’s `while` loops with a bounded trigonometric form,

and change backend PNG writing in `server/depth_service.py` from `compress_level=9` to `compress_level=6`.

Keep the RGBDE file format and visible rendering behavior unchanged.

### Milestone 3: Stop doing desktop work when nothing changed

At the end of this milestone, the non-XR viewer should render on demand instead of redrawing continuously. A static scene with no mouse movement, no slider changes, and no active XR session should use minimal CPU. The mirror control panel must still stay in sync.

Implement this by replacing the unconditional desktop `requestAnimationFrame(renderLoop)` path in `webapp/src/app.js` with a `requestRender()` scheduler and a small set of dirty flags. XR sessions can continue to render every frame through the existing XR path; only the desktop path should become event-driven.

`computeModelMatrix()` should stop allocating a chain of fresh `Float32Array` instances for every frame. Introduce scratch matrices or in-place variants in `webapp/src/rendering.js`, and cache the model matrix in `app.js` until view-related state changes. The same milestone should remove the unconditional `syncMirrorControls()` call from `renderLoop()` and replace it with event-driven synchronization plus explicit sync calls after programmatic state changes that do not flow through a DOM event.

This milestone is complete when moving the camera, changing display mode, toggling UI visibility, or adjusting sliders still updates immediately, but the desktop tab no longer burns CPU while idle.

### Milestone 4: Move RGBDE decode and depth preprocessing off the main thread

At the end of this milestone, loading a large RGBDE PNG should no longer freeze the main thread while the PNG is decoded and the depth map is preprocessed.

Extract the decode and preprocessing path behind a worker-friendly interface. The cleanest shape is to move the heavy logic into a shared module such as `webapp/src/depth-processing.js` and then create a worker entry file such as `webapp/src/depth-worker.js` that receives a `Blob` or `ArrayBuffer`, performs PNG decode plus depth preprocessing, and posts back transferable typed arrays.

`decodeRgbdeFile()` should become an orchestration layer that prefers the worker path when `Worker` is available and falls back to the current synchronous path if worker startup fails. Do not let repeated file drops race each other: carry a monotonically increasing request token in `app.js` so that stale worker results are ignored after a newer file load begins.

The PNG parser change proposed in the earlier improvement memo belongs here as well: stop storing copied `bytes.slice(...)` IDAT chunks and instead store offsets and lengths, then concatenate in one pass before inflation. That improvement is worthwhile on its own, but it matters more once the worker path makes decode cost visible and repeatable.

### Milestone 5: Move depth shaping to the GPU while preserving CPU export and bounds parity

At the end of this milestone, changing magnification, linear/log mode, log power, or far clip should update the displayed mesh by changing uniforms, not by rewriting every vertex buffer. The display result, auto-fit behavior, and exported GLB geometry must remain consistent.

Implement this by separating static mesh data from deformed mesh data. In `webapp/src/rendering.js`, replace the current `aPosition`-only vertex path with static attributes for ray direction and base depth. The vertex shader should receive uniforms for at least the minimum depth clamp, magnification, far clip, depth mode, log power, and any constant offset needed to preserve today’s shaping formula.

Do not remove CPU geometry evaluation entirely. Add a shared evaluator module such as `webapp/src/mesh-evaluator.js` with two responsibilities: one function that computes deformed bounds from base depths plus ray directions without mutating a GPU buffer, and one function that can write fully deformed positions into a `Float32Array` for `Save glTF`. `app.js` should use the cheap bounds function for auto-fit and other display-time state, while `gltf-exporter.js` should request a full CPU position write only when the user exports.

Keep the old CPU path behind a temporary development switch until parity is proven. Once the harness and manual validation confirm that the shader path matches the CPU path, delete the per-slider `renderer.updatePositions()` path and simplify `updateDepthTransform()`.

## Plan of Work

Begin by setting up the workflow guardrails. Create the feature branch, add `.github/workflows/ci.yml`, add `package.json`, install ESLint, and add minimal backend tests. This is the only sensible starting point because the repository currently has no automated feedback loop for future performance edits.

Once CI exists, add measurement scaffolding. That means repository-local fixtures plus a small performance harness page inside `webapp/`. The harness must use the same decode and mesh-generation code as the real app, otherwise it will not be useful for comparing optimizations.

After measurement exists, land the safe runtime optimizations from Milestone 2. These should not change the visible behavior. The expected result is smaller preprocessing time, smaller mesh-build allocation pressure, no noisy production `console.info` output, and faster backend PNG writes.

Then change the desktop render scheduling in `webapp/src/app.js`. The app already knows when most state changes happen because almost every interaction mutates `state` inside a dedicated handler. Use that fact. Add a single `requestRender()` entry point, call it whenever camera state, depth options, display mode, or loaded mesh state changes, and leave continuous rendering to XR only.

Only after the desktop path is stable should the worker and GPU work land. The worker milestone is primarily about responsiveness and cancellation. The GPU milestone is primarily about removing the CPU-to-GPU upload bottleneck without sacrificing export correctness.

## Concrete Steps

Run everything from the repository root:

    cd /home/amari1/github/Image-To-DepthWebViewer

For Milestone 1, first create the branch:

    git switch -c feat/rgbde-performance-improvements

Then create the npm metadata and workflow files, install npm dependencies, and run:

    npm run check:js
    npm run lint
    python -m unittest discover -s tests -p 'test_*.py'

After pushing the branch and opening a pull request, GitHub Actions should run the same commands automatically.

For Milestone 2, use:

    python scripts/run.py

Then open:

    http://localhost:5173/perf-harness.html

The harness should show at least these rows:

    Fixture           Decode ms   Preprocess ms   Mesh ms   Total ms
    rgbde-small       ...
    rgbde-large       ...

For Milestone 3, start the app the same way, load one repository-local RGBDE fixture, stop interacting, and verify two things:

    1. The scene remains visible and correct.
    2. The harness or browser task manager shows the tab returning close to idle instead of redrawing continuously.

For Milestone 4, use the same harness page to compare “main-thread decode” and “worker decode” modes with the same fixture. The worker mode should keep the page responsive while the timing table updates.

For Milestone 5, validate both visual parity and export parity:

    1. Load one fixture.
    2. Change magnification, far clip, and log mode.
    3. Save a GLB.
    4. Confirm that the exported geometry reflects the same slider state as the on-screen view.

## Validation and Acceptance

Milestone 1 is accepted when:

the work is happening on a dedicated branch,

GitHub Actions runs on pushes and pull requests,

the JavaScript job runs both `node --check` and ESLint,

the Python job runs repository tests without trying to load the Depth Pro model,

and the user can mark those checks as required on pull requests.

Milestone 2 is accepted when:

the app still loads RGBDE files correctly,

the backend still returns a valid RGBDE PNG,

the new harness exists in-repo,

production decode no longer prints the current depth-debug `console.info` lines,

and the harness shows measurable improvement in at least preprocessing time and backend encode time.

Milestone 3 is accepted when:

desktop mode no longer redraws continuously while idle,

mirror controls still reflect the live UI state,

and no interaction requires an extra click or manual refresh to appear.

Milestone 4 is accepted when:

large RGBDE loads no longer block the UI thread for the full decode-plus-preprocess duration,

stale worker results are ignored after a newer load starts,

and fallback to the synchronous path still works if worker startup fails.

Milestone 5 is accepted when:

slider-driven depth shaping no longer performs `gl.bufferSubData(...)` uploads on every change,

on-screen geometry matches the previous CPU path within visual tolerance,

auto-fit still frames the model correctly after depth-shaping changes,

and the exported GLB matches the displayed geometry.

## Idempotence and Recovery

All milestones should be landed additively so the app remains usable after each commit. The CI workflow should be safe to rerun repeatedly. The benchmark harness and test fixtures should be safe to regenerate repeatedly. The worker path must keep a synchronous fallback so browsers without the needed worker features still function. During Milestone 5, keep the CPU deformation path available behind a temporary switch until parity is proven; if shader parity breaks, flip back to the CPU path rather than leaving export or auto-fit in an ambiguous state.

Do not change the RGBDE file format. Do not change the Depth Pro model interface. Do not rely on half-precision inference. Do not make CI depend on the actual Depth Pro checkpoint download or model inference path in its first version. Those are explicit non-goals for this plan.

## Artifacts and Notes

The following evidence snippets should be added as each milestone lands:

For Milestone 1, paste one GitHub Actions success summary, one `npm run lint` success transcript, and one `python -m unittest` success transcript.

For Milestone 2, paste one short timing table from `perf-harness.html`, for example:

    rgbde-small  decode 5.00 ms  preprocess 10.20 ms  mesh 12.30 ms  total 27.50 ms
    rgbde-large  decode 43.60 ms preprocess 109.50 ms mesh 12.40 ms  total 165.50 ms

For Milestone 3, paste one note or screenshot-equivalent summary showing the idle desktop tab returning near zero redraw activity.

For Milestone 4, paste one harness comparison showing worker and non-worker runs on the same fixture.

For Milestone 5, paste one before-and-after note confirming that slider interaction no longer triggers full position uploads, plus one export-parity note for the saved GLB.

## Interfaces and Dependencies

In `.github/workflows/ci.yml`, define jobs equivalent to:

    python-tests
    js-checks

The Python job should install `requirements.txt` and run:

    python -m unittest discover -s tests -p 'test_*.py'

The JavaScript job should run:

    npm ci
    npm run check:js
    npm run lint

At the repository root, create:

    package.json
    package-lock.json
    eslint.config.js

or an equivalent minimal ESLint configuration file supported by the chosen ESLint version.

In `webapp/src/geometry.js`, keep the public entry points that `app.js` already uses, but move reusable internals into named helpers. At the end of Milestone 2 or Milestone 4, the repository should expose something equivalent to:

    export function preprocessDepth(depth, colors, width, height)
    export function generatePerspectiveMesh(options)
    export function decodeRgbdeFile(file, options = {})

In a new shared module such as `webapp/src/depth-processing.js`, define helpers equivalent to:

    export function median9(values)
    export function reduceDepthSpikes(depth, colors, width, height)
    export function applyEdgeAwareSmooth(depth, colors, width, height)
    export function colorDistanceSquared(r1, g1, b1, r2, g2, b2)

In a new worker entry file such as `webapp/src/depth-worker.js`, define a message contract that accepts one decode request and returns:

    {
      width,
      height,
      leftPixels,
      depth,
      depthStats
    }

where `leftPixels` and `depth` are returned through transferable buffers.

In `webapp/src/rendering.js`, the renderer should eventually expose a static-geometry upload path and a uniform update path, not just a mutable position-buffer path. At the end of Milestone 5, the renderer should support interfaces equivalent to:

    updateGeometry(mesh)
    setDepthOptions(options)
    render(modelMatrix, viewMatrix, projectionMatrix, options = {})

In a new shared module such as `webapp/src/mesh-evaluator.js`, define:

    export function computeDeformedBounds(mesh, options)
    export function writeDeformedPositions(mesh, options, out)

`computeDeformedBounds()` exists so `app.js` can preserve auto-fit without uploading new position buffers. `writeDeformedPositions()` exists so `gltf-exporter.js` can still export the geometry the user sees.

In `server/depth_service.py`, keep `DepthProService.generate_rgbde()` and `_encode_depth()` as the backend interface. The milestone work may change implementation details, but callers in `server/main.py` should not need new parameters.

Change note: 2026-04-06 22:12 JST / Codex. Rewrote the plan so branch creation, PR-based delivery, GitHub Actions, and JavaScript checking are now part of the core execution path rather than side suggestions. This change was prompted by the user’s stated preference for branch-required PRs with CI and by the discovery that this repository currently has no CI or npm tooling at all.

Change note: 2026-04-06 22:29 JST / Codex. Updated the plan after implementing the local half of Milestone 1. The progress section now records the created branch, added CI/test files, and successful local verification commands, and the discoveries section now notes the eager Depth Pro import and bootstrap-generated untracked directories.

Change note: 2026-04-06 22:47 JST / Codex. Updated the plan after implementing the local code for Milestones 2 and 3. The progress section now records the added preprocessing module, fixture generator, benchmark harness, and on-demand desktop rendering path, and the artifacts section now includes one captured benchmark result from the browser harness.
