# Deliver a head-tracked mobile window into published RGBDE scenes

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds. This document follows `.agent/PLANS.md`.

## Purpose / Big Picture

The desktop editor can turn an image into an RGBDE mesh, but previously that mesh could only be inspected in the desktop, side-by-side stereo, WebXR, or Looking Glass paths. This work adds an explicit `Publish to Mobile` action and a separate `/viewer.html` page for an iPhone or iPad on the same port-5173 server. The mobile page downloads the latest baked GLB, supports one-finger rotation plus two-finger zoom and pan, and can use the front camera to render a head-coupled perspective: the display behaves like a window, revealing different parts of a model as the viewer moves.

The feature is successful when a user loads or generates an RGBDE scene at `http://localhost:5173/`, presses `Publish to Mobile`, opens `http://<PC-tailnet-name-or-address>:5173/viewer.html` on a phone or iPad, and sees the same scene update without transferring camera frames away from the mobile browser. Existing desktop, SBS, WebXR, and Looking Glass behavior must remain unchanged.

## Progress

- [x] (2026-08-17) Added an in-memory FastAPI relay on port 5173 with atomic manifest/model revisions and tests for publishing, replacement, validation, and restart behavior.
- [x] (2026-08-17) Added `Publish to Mobile` to the desktop editor. It exports an untransformed baked GLB so mobile placement is independent of the desktop inspection camera.
- [x] (2026-08-18) Added `/viewer.html`, a WebGL2 GLB renderer, revision-safe polling, responsive phone/tablet layout, camera lifecycle controls, debug metrics, and orientation handling.
- [x] (2026-08-18) Added local MediaPipe eye tracking, calibration, time-based smoothing, off-axis projection, clipping safety, and unit tests for their numerical behavior.
- [x] (2026-08-18) Added one-finger rotation and two-finger pinch/pan with bounded state and orientation-safe gesture cancellation.
- [x] (2026-08-18) Tuned the first real-device presentation pass: added a screen-plane parallax test, reduced the XY gain from `1.35` to `0.65`, and removed the original positive pop-out placement.
- [x] (2026-08-18) Confirmed that the reported RGBDE load failure was a file-selection mistake rather than a product regression. Both repository RGBDE fixtures load and enable the existing desktop actions, so the desktop decode/load path was left unchanged.
- [x] (2026-08-18) Added the first browser-specific front-camera handedness pass plus a persistent `Flip L/R` override that immediately discards the stale calibration and recenters. The browser-sign assumption was superseded by the second device pass below.
- [x] (2026-08-18) Replaced raw XYZ auto-fit on mobile with a UV-anchored thin relief. The nearest sample is fixed to `z = 0`, all geometry remains at `z <= 0`, and extreme far-depth samples no longer determine the image's fitted size.
- [x] (2026-08-18) Reduced face-distance exaggeration with a separate `DEFAULT_Z_GAIN = 0.35` and baseline-relative Z limits. Published Desktop Depth Magnification now maps to a bounded mobile relief span.
- [x] (2026-08-18) Ran 47 JavaScript tests, 15 Python tests, syntax checks over 20 JavaScript files, ESLint, and `git diff --check`; all passed. Browser smoke checks retained Desktop 2D/SBS switching, VR and Looking Glass entry controls, the mobile controls, and zero page errors.
- [x] (2026-08-18) Restarted the normal port-5173/8000 project stack so the live relay accepts `depthSpan`, verified it with a disposable live publish, then cleared the disposable scene.
- [x] (2026-08-19) Applied the second iPhone direction/gain pass: Safari and iOS Chrome now share the corrected horizontal sign, the persisted flip key was versioned to discard stale first-pass choices, Safari XY gain was halved from `0.65` to `0.325`, and Chrome retained `0.65` because its observed response was already much weaker.
- [x] (2026-08-19) Diagnosed the iPad Chrome report as frame/UI available but the actual published model not completing. A tiny GLB loaded under an iPad/CriOS emulation, making large-scene decode/upload memory the strongest failure candidate.
- [x] (2026-08-19) Added mobile-only publish budgets: at most 65,535 vertices, 16-bit indices preserved through GLB parsing and WebGL upload, no unused normals, and a texture capped at 2048 per side and two million pixels. Standard Desktop `Save glTF` remains full quality with normals and 32-bit indices.
- [x] (2026-08-19) Added download/parse/texture status phases and a 15-second texture-decode timeout so a constrained device reports the stopping stage instead of waiting indefinitely.
- [x] (2026-08-19) Verified the actual PC RGBDE load → optimized publish path (`65,490` vertices for the small fixture), automatic revision pickup on a 744×1133 CriOS/iPad viewport, `Scene ready`, and WebGL error 0. Desktop SBS switching also remained error-free.
- [x] (2026-08-19) Ran 54 JavaScript tests, 15 Python tests, syntax checks over 21 JavaScript files, ESLint, and `git diff --check`; all passed.
- [x] (2026-08-19) Numerically audited the mobile presentation as a miniature behind a physical glass plane. The cyclopean off-axis formula is correct: a glass-plane point remains fixed as the eye approaches, while a point behind the glass contracts only slightly toward the image center.
- [x] (2026-08-19) Fixed pinch zoom so it scales only image-plane X/Y and no longer multiplies relief Z. Reduced the default relief span from `0.25` to `0.125`, its Desktop-magnification mapping to `0.025`–`0.225`, and apparent-eye-distance Z response from `0.35` to `0.1`.
- [x] (2026-08-19) Added numerical regressions for glass-plane invariance, modest far-point contraction on approach, and constant relief thickness under pinch. The focused suite passed 24 tests.
- [x] (2026-08-19) Republished the actual RGBDE fixture as revision 8 and verified `depthSpan: 0.125`, `Scene ready`, and WebGL error 0 on a 744×1133 mobile viewport. Desktop SBS switching, VR/Looking Glass entry controls, and Desktop WebGL remained error-free.
- [x] (2026-08-19) Ran 56 JavaScript tests, 15 Python tests, syntax checks over 21 JavaScript files, ESLint, and `git diff --check`; all passed.
- [x] (2026-08-19) Reviewed the third-pass build against the user's stated goal and found the presentation was governed by two compensating scale errors plus a depth mapping that cannot serve outdoor scenes. Recorded the numerical analysis in `Surprises & Discoveries`.
- [x] (2026-08-19) Added `webapp/src/device-metrics.js`: a physical screen-size table for iPhone 17 and iPad mini (A17 Pro), a density fallback for unknown devices, a user-measured override, and `computeViewingGeometry()` which derives eye distance and vertical field of view from real millimetres.
- [x] (2026-08-19) Switched head tracking to MediaPipe's metric facial transformation matrix. Head position now arrives in centimetres and converts to world units through the device's screen size, so the XY and Z gains are no longer used on devices that supply it. The landmark-ratio path remains as a fallback.
- [x] (2026-08-19) Replaced linear radial-depth normalization with a disparity mapping (`z` proportional to `1 / distance`), exposed as a `disparityBlend` between linear and disparity, and rejected depth outliers at the near end as well as the far end.
- [x] (2026-08-19) Raised the default relief span from `0.125` to `1.0`, its magnification mapping to `0.2`–`1.8`, and the relay ceiling to `2.0`.
- [x] (2026-08-19) Restored uniform pinch scaling and bounded relief thickness at a quarter of the viewer's real eye distance instead of freezing depth.
- [x] (2026-08-19) Added `?debug=1` sliders for viewing distance, relief span, and disparity blend so the remaining perceptual choices can be settled on the device itself.
- [x] (2026-08-19) Ran 71 JavaScript tests, 16 Python tests, syntax checks over 22 JavaScript files, and ESLint; all passed.
- [x] (2026-08-19) Reduced mobile transfer and peak memory at the consumer that dominates it. The texture is published as JPEG rather than lossless PNG, decoded with `createImageBitmap`, and released as soon as it reaches the GPU. The vertex ceiling rose from `65,535` to `262,144` with 32-bit indices, which WebGL2 draws without an extension. The multisampled backbuffer is capped at 2.6 million pixels.
- [x] (2026-08-19) Added a genuine high/low fallback. `Publish to Mobile` now uploads a reduced build alongside the full one, the relay serves it at `?variant=reduced` with its own ETag, and the viewer requests it only after the full build has actually failed to load, because no browser API on iOS reports available memory in advance.
- [x] (2026-08-19) Moved the debug tuning sliders and live readings clear of the startup copy so both remain usable on a phone-sized viewport.
- [x] (2026-08-19) Verified the whole path in a browser against the live relay: `rgbde-large.png` loaded in the desktop editor, `Publish to Mobile` produced a 249,750-vertex, 10.5 MB full build plus a 2.0 MB reduced build, and the manifest carried `depthSpan 1`, `disparityBlend 1`, `baselineEyeZ 4.5`, and `captureFovDeg 32`. The viewer reached `Scene ready` with WebGL error 0, parsed 32-bit indices and an `image/jpeg` texture, and produced a relief spanning exactly `z` in `[-1, 0]`. The device table resolved iPhone 17 to `0.16565` and iPad mini to `0.15583` millimetres per CSS pixel. Injecting a simulated out-of-memory failure on the full build made the viewer fall back and report `Scene ready (reduced build)`.
- [x] (2026-08-19) Confirmed the desktop editor is unchanged: `Generate Depth`, `Save RGBDE`, `Save glTF`, `Publish to Mobile`, and the VR and Looking Glass entry controls are all present, mono and side-by-side switching both report WebGL error 0, and the only console errors are the unrelated port-8000 depth backend and `favicon.ico`.
- [x] (2026-08-19) Ran 76 JavaScript tests, 17 Python tests, syntax checks over 22 JavaScript files, ESLint, and `git diff --check`; all passed.
- [ ] Settle the three remaining perceptual variables on the user's real iPhone 17 and iPad mini using the `?debug=1` sliders, then fold the chosen values into the defaults. Verify the fourth-pass behavior: iPhone Chrome direction is natural, Safari motion is approximately half the original amplitude, the newly republished optimized scene loads in iPad Chrome, pinch magnifies without producing crescent-shaped foreground distortion, and a near subject in a deep outdoor scene now has visible relief.

## Surprises & Discoveries

- Observation: The originally requested `EXECPLAN_head_tracked_mobile_viewer.md` was absent from the working tree even though the implementation files and tests existed.
  Evidence: `rg --hidden --files -g '*EXECPLAN*'` returned no matching file on 2026-08-18. This document was reconstructed from the current source, tests, README, and user-visible behavior before further edits.

- Observation: A small positive `frontOffset` has a large qualitative effect. In this repository `+z` points toward the viewer and the virtual display is `z = 0`; therefore the former default `frontOffset: 0.05` deliberately put the nearest mesh surface in front of the glass. A point in front of the glass has the opposite horizontal motion parallax from a point behind it.
  Evidence: `computeMobileModelPlacement` makes `transformedBounds.max[2]` equal to `frontOffset`, and the existing test explicitly described a positive value as popping toward the viewer. The user's real-device report was that this looked unnatural and could appear horizontally reversed.

- Observation: The initial implementation assumed MediaPipe landmarks always arrived in the same unmirrored front-camera convention, while display-space `+x` is the viewer's visual right. The first correction then overfit the browser name and assigned iOS Chrome the opposite default sign.
  Evidence: On the second device pass, iPhone Chrome remained reversed with the `CriOS` exception while Safari was correct. Removing that exception makes both start with the same corrected sign; `Flip L/R` remains the device-level escape hatch.

- Observation: Horizontal and vertical eye movement were originally mapped at `1.35` virtual units per apparent interpupillary distance. On a portrait phone or iPad this can exceed the half-width of the virtual screen after a modest head movement and feels amplified.
  Evidence: The initial `mapObservationToEyePose` defaulted both gains to `1.35`; the virtual screen has height `2` and may be narrower than `1` in portrait orientation.

- Observation: Safari and iOS Chrome can feel very different even with the same numerical XY gain. In the second report Safari was still about twice as strong as desired, while iPhone Chrome was reversed and much weaker.
  Evidence: Safari now uses `0.325`; iOS Chrome keeps `0.65` while adopting Safari's sign. The gain and sign are separate tracker inputs, so projection math remains unchanged.

- Observation: iPad Chrome displayed the viewer frame but did not complete the model load. The same viewport and CriOS branch loaded a tiny GLB, which rules out the layout, page bootstrap, relay polling, and basic WebGL2 path.
  Evidence: A 744×1133 CriOS browser smoke test loaded a two-megabyte, 65,341-vertex optimized GLB with `state=ready` and WebGL error 0. The prior full publish carried higher-density geometry, unused normals, 32-bit indices, and unrestricted texture dimensions, all of which increase peak tab memory during fetch, parse, image decode, CPU copies, and GPU upload.

- Observation: The severe distant-scene failure was caused by fitting the published raw perspective mesh by its complete XYZ bounds. Because perspective reconstruction makes lateral X/Y grow with depth, distant sky can make the bounds enormous; fitting those bounds necessarily makes the near subject tiny.
  Evidence: The published GLB already contains baked adjusted depths and ray-expanded positions. A fixture with a depth ratio of 1:100 reproduced the bound domination. The new relief test proves the projected image corners remain at the requested screen occupancy despite that ratio.

- Observation: A negative front offset is safer than positive pop-out, but it does not provide the stable pivot the user expected. The physically useful invariant for this effect is that the nearest sample touches the glass and nothing crosses it.
  Evidence: With `frontZ = 0`, off-axis projection keeps the glass-plane sample stationary under eye translation. `constrainReliefBehindScreen` translates a rotated or zoomed relief backward whenever a transformed bound would cross `z = 0`.

- Observation: The apparent forehead/hair distortion when leaning closer combined three effects: relative eye-distance scaling, an overly deep virtual relief, and pinch zoom uniformly scaling X, Y, and Z.
  Evidence: A 3× pinch previously made the relief three times thicker. Z response now applies only 10% of the inferred deviation from the calibrated baseline, the default relief is `0.125`, the bounded range is `0.025`–`0.225`, and pinch leaves Z unchanged.

- Observation: The off-axis projection itself agrees with a miniature behind glass. For eye distance `E`, a point at depth `D` behind the glass projects as `x_screen = X * E / (E + D)`.
  Evidence: At `D = 0` the projected position is independent of `E`. As the eye approaches, a point with `D > 0` moves slightly toward image center instead of expanding toward the viewer. A numerical regression covers both cases at the current `0.125` relief span.

- Observation: A single front-camera face estimate cannot distinguish true face approach from phone/head yaw using apparent eye width alone.
  Evidence: Both real approach and foreshortening from yaw reduce the observed inter-eye landmark distance. The current tracker therefore treats some device tilt as Z motion; damping Z limits the artifact, but DeviceOrientation or a calibrated 6-DoF pose model would be needed to separate them.

- Observation: One ordinary phone/tablet panel cannot provide geometrically correct independent views to two eyes whose separation is wider than the panel.
  Evidence: The renderer uses the midpoint of the eyes as a cyclopean camera. This is the least-surprising monoscopic window view, but close, strongly tilted binocular viewing necessarily differs from physical binocular parallax; square-on or one-eye inspection is the strict geometry check.

- Observation: The reported RGBDE load regression could not be reproduced and was subsequently withdrawn by the user.
  Evidence: `rgbde-small.png` and `rgbde-large.png` both decoded and displayed in the browser, and the user confirmed the earlier attempt used the wrong load location.

- Observation: The virtual eye was roughly twice as close as a phone or tablet is actually held, and the tracking gain had been shrunk to compensate. The two errors cancel in perceived amplitude but never converge to a natural response.
  Evidence: The virtual screen is two world units tall and `baselineEyeZ` was `2.5`, which is 1.25 screen heights and a 43.6 degree vertical field of view. An iPhone 17 canvas is about 130 mm tall and is held near 300 mm, which is 4.6 screen half-heights and about 24 degrees. Separately, one interpupillary distance of head movement is about 63 mm; on that canvas one world unit is about 65 mm, so a physically correct horizontal gain is near `0.97`, while the tuned value was `0.325`. The tuning history `1.35` to `0.65` to `0.325` never converged because it was correcting the wrong variable.

- Observation: The reported "model is a tiny point in a pyramid of sky" failure is genuinely fixed, but the underlying depth-allocation failure for the same scene is not.
  Evidence: `createMobileReliefScene` builds image-plane X and Y from UV rather than from source XYZ, and `tests/mobile-relief.test.mjs` proves the image corners still land at the requested screen occupancy with a 1:100 depth ratio. However, with linear normalization a coastal portrait whose subject is 2 m away and whose horizon is 10 000 m away gives the subject about 0.003 percent of the relief budget. At the then-current span of `0.125` that is well under a micrometre of physical relief. The framing was corrected; the depth was not.

- Observation: Depth mapped by disparity serves both extremes of subject matter with one formula, so no scene classification or mode switch is needed.
  Evidence: For the 2 m to 10 000 m coastal portrait, disparity gives the subject about 13 percent of the budget against 0.003 percent for linear. For a macro or microscope subject spanning 1.0 to 1.1 units, disparity and linear agree to within three percent. Both cases are covered by regressions in `tests/mobile-relief.test.mjs`.

- Observation: Removing depth from pinch traded one artifact for another. The reported crescent-shaped foreground distortion was not caused by scaling depth; it was caused by scaling depth relative to a fixed viewing distance.
  Evidence: Uniformly scaling a relief by `s` is algebraically identical to rebuilding it with span `s * depthSpan` and reconstruction anchor `s * baselineEyeZ`, so uniform scaling is self-consistent. What is not self-consistent is a relief whose thickness reaches 30 percent of the viewing distance, which is what a 3x pinch of the then-current `0.25` span at an eye distance of `2.5` produced. Freezing depth instead makes a zoomed model an anamorphic flat card exactly when the viewer zooms in to inspect it.

- Observation: The near end of the depth range had no outlier protection at all, and disparity mapping makes that omission much more dangerous than linear mapping did.
  Evidence: `computeRadialDepthRange` used `depths[0]`, the absolute minimum, as the near reference while the far reference used a 98th percentile. Disparity mapping is anchored on `1 / near`, so a single stray foreground sample compresses the entire remaining scene against the back plane. Both ends now use quantiles and out-of-range samples are flattened onto the near or far plane rather than dropped.

- Observation: A CSS pixel has no fixed physical size, and the conventional 96 dpi assumption is wrong by more than half on these devices.
  Evidence: An iPhone 17 is 1206 by 2622 hardware pixels at 460 ppi with a device pixel ratio of 3, which is 0.1657 mm per CSS pixel. An iPad mini (A17 Pro) is 1488 by 2266 at 326 ppi with a ratio of 2, which is 0.1558 mm per CSS pixel. These differ from each other by nine percent and from the nominal 0.2646 mm by about 60 percent, so a per-device table is required rather than a formula.

- Observation: Making the relief's depth direction follow the viewer's face exactly, which was the user's first description of the desired effect, provably removes all parallax.
  Evidence: Each relief vertex is placed at `S * (E0z - z) / E0z`, which is the point where the ray from the calibrated eye `E0` through the image-plane anchor `S` reaches depth `z`. Re-anchoring that ray to the live eye `E` puts every vertex on the ray from `E` through `S`, and the projection of such a point from `E` is exactly `S`. The image would be pinned to the screen and perfectly flat. The user subsequently clarified that the model must not rotate and that the vanishing point should follow the viewer, which the existing off-axis projection already provides; the missing ingredient was amplitude, not a new geometry mode.

- Observation: The initial view reproduces the source image exactly, and that property is independent of the depth span and the depth mapping.
  Evidence: Projecting `S * (E0z - z) / E0z` from `E0` onto the plane `z = 0` gives `S` for every `z`. Both the relief span and the disparity blend may therefore be changed freely without disturbing what the viewer sees before moving.

## Decision Log

- Decision: Keep the mobile viewer a separate `/viewer.html` entry point and keep monitor/SBS/WebXR/Looking Glass code paths untouched.
  Rationale: Isolation minimizes regression risk and lets mobile-specific camera permissions and touch behavior evolve without changing established rendering modes.
  Date/Author: 2026-08-17 / Codex

- Decision: Publish a GLB plus a small presentation manifest through an in-memory, latest-scene-only relay.
  Rationale: The user needs a simple local/Tailnet handoff, not durable cloud storage. A revisioned pair prevents a viewer from combining a new manifest with an old GLB.
  Date/Author: 2026-08-17 / Codex

- Decision: Process face landmarks locally in the mobile browser and request no gyroscope or motion-sensor permission.
  Rationale: This minimizes privacy exposure and supports iOS browsers through a user-initiated camera action.
  Date/Author: 2026-08-18 / Codex

- Decision: Treat the screen as the front boundary of the scene by default; no mesh vertex should begin in front of `z = 0`.
  Rationale: Head-coupled perspective is most stable as a window into a scene. Crossing the screen plane reverses motion-parallax direction and makes a single depth mesh look torn or detached.
  Date/Author: 2026-08-18 / Codex, prompted by user device feedback

- Decision: Correct front-camera horizontal handedness in the tracking-to-eye mapping and reduce the default XY gain rather than altering the mathematically correct off-axis projection.
  Rationale: Projection and view matrices already implement the physical screen/eye geometry. The observed reversal and excessive motion originate before projection, in camera-coordinate conversion and gain.
  Date/Author: 2026-08-18 / Codex, prompted by user device feedback

- Decision (superseded 2026-08-19): Use browser-specific horizontal defaults only as a starting point and provide a user-controlled, persistent `Flip L/R` override.
  Rationale: Camera delivery conventions can differ by browser/device revision. A saved explicit control is more robust than continuing to accumulate user-agent exceptions, and recalibration prevents a sign change from mixing with the previous center.
  Date/Author: 2026-08-18 / Codex, prompted by the Safari/Chrome comparison

- Decision: Supersede the `CriOS` sign exception; Safari and iOS Chrome now share `mirrorX = true`, while their XY gains remain independently tuned.
  Rationale: The second iPhone result directly falsified the sign exception. Keeping sign and magnitude independent addresses both observations without touching the off-axis projection.
  Date/Author: 2026-08-19 / Codex, prompted by second-pass device feedback

- Decision: Optimize only `Publish to Mobile`, not the standard Desktop GLB exporter behavior.
  Rationale: A head-tracked phone/tablet relief does not need the full desktop mesh density or vertex normals. Isolating the budget preserves Desktop/SBS/WebXR/Looking Glass and DCC export fidelity while reducing iPad Chrome's download, CPU, and GPU memory.
  Date/Author: 2026-08-19 / Codex

- Decision: Cap mobile publish at the 16-bit index ceiling and preserve the compact index type through renderer upload.
  Rationale: At most 65,535 vertices still gives roughly a 300×200 relief grid for common aspect ratios, while omitting normals and halving index width materially lowers peak memory. The source corners and UV endpoints are preserved by deterministic grid resampling.
  Date/Author: 2026-08-19 / Codex

- Decision: Treat published XYZ as the baked depth source, but rebuild mobile presentation positions from UV plus normalized radial depth.
  Rationale: UVs preserve the intended image rectangle independent of far-depth outliers. Reprojecting each relief sample for the calibrated baseline eye preserves the original 2D appearance while retaining bounded head-coupled parallax.
  Date/Author: 2026-08-18 / Codex

- Decision: Set the mobile front boundary exactly to the display glass (`frontZ = 0`) and enforce `maxZ <= 0` after every touch transform.
  Rationale: This makes the nearest surface the rotation/presentation boundary requested by the user and prevents any part from acquiring reversed pop-out parallax.
  Date/Author: 2026-08-18 / Codex, prompted by user device feedback

- Decision: Use the 98th percentile of radial depth as the relief far reference and clamp all remaining outliers to the finite back plane.
  Rationale: Isolated extreme depths should not spend almost the entire relief span on sky/error samples. The percentile is deterministic, cheap, and leaves the texture/image fit entirely independent of source XYZ bounds.
  Date/Author: 2026-08-18 / Codex

- Decision: Carry Desktop Depth Magnification into the mobile manifest as a bounded `depthSpan`, while damping inferred eye Z separately.
  Rationale: Model depth and viewer motion are independent perceptual controls. Keeping them separate avoids using excessive head motion to compensate for a shallow or deep scene.
  Date/Author: 2026-08-18 / Codex

- Decision: Keep the cyclopean off-axis projection unchanged and make the relief/interaction model more conservative: `DEFAULT_Z_GAIN = 0.1`, default `depthSpan = 0.125`, bounded span `0.025`–`0.225`, and X/Y-only pinch scaling.
  Rationale: The projection equation already preserves the physical glass plane and gives the expected weak change for distant samples. The exaggeration came from presentation thickness and input transforms, so correcting those variables avoids destabilizing Desktop, SBS, WebXR, Looking Glass, or the window geometry.
  Date/Author: 2026-08-19 / Codex, prompted by the physical-geometry review

- Decision: Derive the viewer's eye distance from the device's physical screen size rather than shipping a fixed `baselineEyeZ`, using a small hardware table with a density fallback and a user-measured override.
  Rationale: The virtual screen is defined as two world units tall and is mapped onto the whole canvas, so one world unit is half the canvas's physical height. Once that is known in millimetres, eye distance and head motion are both measurable quantities instead of tuned constants. A browser cannot report physical size, and no formula recovers it, so a table is the only accurate source.
  Date/Author: 2026-08-19 / Claude, prompted by the user's "the orbit is too close" observation

- Decision: Read MediaPipe's metric facial transformation matrix and retire the XY and Z gains on devices that provide it, keeping the landmark-ratio path only as a fallback.
  Rationale: The matrix carries the head position in centimetres, which combined with the physical screen size converts real head movement into world units with no free parameter. It also separates leaning closer from turning the head, which apparent eye spacing alone cannot do and which was recorded earlier as an accepted limitation.
  Date/Author: 2026-08-19 / Claude

- Decision: Map source depth by disparity, exposed as a blend against the previous linear mapping, and reject outliers at both ends of the range.
  Rationale: Equal steps of `1 / distance` are equal steps of perceived depth, and they match the pinhole reconstruction the source mesh came from. This is what gives a near subject usable relief in a scene whose far field is thousands of times more distant, and it degrades gracefully to the linear behaviour for shallow macro subjects.
  Date/Author: 2026-08-19 / Claude, prompted by the coastal-portrait case

- Decision: Set the default relief span to one world unit, about half a screen height of depth behind the glass.
  Rationale: The goal is a miniature that reads as a solid object, which requires the near subject's relief to be proportional to its size on screen. For a typical portrait that lands near one world unit under disparity mapping. The previous `0.125` was about 1 mm of physical relief on a real device and could not read as solid regardless of how well the tracking behaved.
  Date/Author: 2026-08-19 / Claude

- Decision: Restore uniform pinch scaling and bound the resulting thickness at a quarter of the viewer's measured eye distance.
  Rationale: A miniature magnifies uniformly; freezing depth produces an anamorphic card. The crescent artifact came from thickness growing without limit against a fixed viewing distance, so bounding the ratio removes the cause while keeping the natural behaviour. The bound is expressed in the one physically meaningful quantity available, and it widens automatically now that the eye distance is correct.
  Date/Author: 2026-08-19 / Claude

- Decision: Do not cut triangles that straddle a depth discontinuity.
  Rationale: The user requires the stretched, textured triangle as the hole filler. Where the source has no data behind an occluding edge, a smeared surface is a more plausible reconstruction than a black hole, and the goal is explicitly a textured mesh pushed out by depth rather than a segmented scene. This supersedes an earlier proposal to cull such triangles.
  Date/Author: 2026-08-19 / Claude, prompted by explicit user direction

- Decision: Keep the model square-on to the glass and never rotate it toward the viewer.
  Rationale: The user specified that the model's orientation must not change and that only the vanishing point should follow the viewer. The off-axis projection already places the vanishing point of depth-parallel lines directly under the eye, so no geometry change is required; what was missing was enough depth and enough tracking amplitude for that motion to be visible.
  Date/Author: 2026-08-19 / Claude, prompted by explicit user direction

- Decision: Continue without DeviceOrientation fusion or a full per-eye renderer in this milestone and document the cyclopean limitation.
  Rationale: Motion sensors add permission, calibration, and browser-coordinate complexity, while a normal panel cannot emit separate views to both eyes. Strong Z damping is a safe comfort correction now; richer 6-DoF/device-pose fusion belongs in a separately tested milestone.
  Date/Author: 2026-08-19 / Codex

## Outcomes & Retrospective

Milestones through head tracking, touch interaction, browser-specific handedness, bounded mobile relief, and the physical projection audit are implemented in the current working tree. Automated unit coverage exists for the relay, GLB parsing, revision consistency, projection math, tracking math, touch gestures, runtime cadence, relief generation, glass-plane constraints, image-plane-only pinch, and JavaScript syntax/lint checks. Real-device feedback found defects that algebraic projection tests alone had not exposed: browser-dependent horizontal handedness, a front surface that did not behave as the glass-plane pivot, excessive forward/back response, raw far-depth bounds that collapsed the foreground into a pyramid tip, and pinch zoom that also deepened the model. Each now has an isolated control and a numerical regression test.

The final outcome still requires another real-device check because camera delivery, comfortable gain, and iOS browser memory remain device-dependent properties. The debug URL `/viewer.html?debug=1` displays eye coordinates, the active horizontal flip and XY gain, camera dimensions, render rate, inference rate, and first-pose latency. Loading now reports download, GLB parse, and texture decode as separate stages. The user must reload the PC editor and republish once more because only a newly published scene receives the mobile grid/texture budgets.

Milestones 4–9 are complete in code. The physical-audit red phase failed at the old Z gain/span expectations and the missing image-plane-only interaction transform; after implementation, 24 focused tests passed. The final regression result is 56 JavaScript tests and 15 Python tests passing, with 21 JavaScript files passing syntax checks, ESLint returning zero, and `git diff --check` clean. Browser smoke checks found no page errors at `/` or `/viewer.html`; Desktop 2D/SBS switching and the VR/Looking Glass entry controls remained intact. The actual app path loaded an RGBDE fixture, published a 65,490-vertex compact GLB with `depthSpan: 0.125`, and an iPad-sized viewport picked up revision 8 with `Scene ready` and WebGL error 0. WebXR and Looking Glass hardware were unavailable, so their unchanged entry and isolated rendering paths were verified rather than a hardware session.

The fourth pass replaced a set of compensating errors with measured quantities. Physical screen size now drives the eye distance, which had been about half the real holding distance; the metric head pose replaces the tuned gains that had been shrunk to hide that error; and depth is allocated by disparity rather than linearly in distance, which is what lets a near subject keep usable relief in a scene whose far field is thousands of times more distant. The relief span rose eightfold as a result, and pinch scales the miniature uniformly again within a bound tied to the viewer's real distance. Three variables remain genuinely perceptual — how far the device is actually held, how thick the miniature should be, and how much of the depth budget the near subject should take — and all three are exposed as `?debug=1` sliders so they can be settled by looking at the result rather than by argument.

Two earlier proposals were withdrawn on explicit user direction and are recorded here so they are not reintroduced. Triangles that straddle a depth discontinuity must not be culled: the stretched textured triangle is the wanted hole filler, because a smeared surface is a more plausible reconstruction of hidden geometry than a black hole. The model must not rotate toward the viewer: it stays square-on to the glass, and only the vanishing point follows the eye, which the existing off-axis projection already provides.

The validation transcript for the fourth pass was:

    npm test:                     76 passed, 0 failed
    Python unittest discovery:    17 passed, 0 failed
    npm run check:js:             22 files checked
    npm run lint:                 exit 0
    git diff --check:             exit 0
    browser errors at /:          only the unstarted port-8000 backend and favicon.ico
    browser errors at viewer:     none
    optimized publish:            249,750 vertices, 10.5 MB full, 2.0 MB reduced
    published manifest:           depthSpan 1, disparityBlend 1, baselineEyeZ 4.5, captureFovDeg 32
    mobile scene state:           ready, WebGL error 0, image/jpeg texture, Uint32 indices
    relief depth bounds:          z in [-1, 0]
    simulated full-build failure: fell back and reported "Scene ready (reduced build)"

## Context and Orientation

`webapp/index.html` and `webapp/src/app.js` implement the existing desktop editor. `Publish to Mobile` calls `createCurrentGlb()` without the desktop model matrix, creates a presentation manifest through `webapp/src/mobile-scene-client.js`, and POSTs both to `/viewer-api/scene`.

`server/viewer_host.py` wraps the existing frontend with FastAPI. It serves static files and keeps only the latest published scene in memory. A manifest request and model request carry a revision number; `webapp/src/mobile-scene-client.js` retries if the numbers do not match.

`webapp/viewer.html` is the mobile page. `webapp/src/mobile-viewer.js` coordinates scene loading, touch state, head tracking, and rendering. `webapp/src/glb-loader.js` parses the constrained GLB export. `webapp/src/mobile-rendering.js` draws it with WebGL2.

`webapp/src/device-metrics.js` resolves how many millimetres one CSS pixel covers on the current device and converts that into the viewing geometry the projection needs. Nothing else in the repository can answer that question, because a CSS pixel is a logical unit with no fixed physical size.

`webapp/src/head-tracker.js` converts MediaPipe's metric facial transformation matrix into an eye position, falling back to iris or eye landmarks. The initial centered samples establish a calibration center and apparent eye distance. Later center displacement gives X/Y, while the ratio of calibrated to current eye distance gives Z. A time-based low-pass filter reduces jitter.

`webapp/src/head-coupled-projection.js` defines the virtual screen at world `z = 0`, with `+x` right, `+y` up, and `+z` toward the viewer. An off-axis projection is an asymmetric camera frustum whose four sides are calculated from the eye and screen edges. Together with the inverse eye translation view matrix, it makes the screen act as a stationary window. Geometry at negative Z is behind the glass; geometry at positive Z is in front and exhibits the opposite motion-parallax direction.

`webapp/src/mobile-relief.js` converts the baked GLB into the mobile presentation geometry. Source radial depth is normalized into a small finite span, source UVs define a screen-fitted image rectangle, and X/Y are reprojected so the calibrated baseline eye sees the undistorted image. `constrainReliefBehindScreen()` preserves the glass boundary after touch transforms.

`webapp/src/mobile-publish-mesh.js` bounds the data sent to constrained mobile browsers. It resamples the baked regular grid without losing the four image boundaries and computes a texture size that respects both dimension and total-pixel budgets. `webapp/src/gltf-exporter.js` can omit normals and preserve 16-bit indices for this mobile profile; its default Desktop profile still writes normals and 32-bit indices.

`webapp/src/mobile-interaction.js` records optional inspection rotation, image-plane scale, and pan around the glass-plane pivot. `createReliefInteractionMatrix()` in `webapp/src/mobile-relief.js` converts that state into a transform whose scale is `[scale, scale, 1]`, so pinch changes image size without changing relief thickness. Touch transformations are independent of eye tracking and remain available when camera permission is denied.

The desktop renderer, SBS split, WebXR sessions, and Looking Glass entry remain in `webapp/src/app.js` and `webapp/src/rendering.js`. Mobile fixes must not change those code paths.

## Plan of Work

Milestone 1 established the publish relay and desktop handoff. The relay accepts one GLB and a small schema-versioned manifest, stores them under a lock, increments the revision, and serves exact bytes. Its tests exercise success, invalid input, replacement, and concurrent revision semantics.

Milestone 2 established the static mobile viewer and touch controls. The viewer polls for a consistent scene pair, parses positions, UVs, indices, a texture, bounds, and an optional node matrix, then auto-fits the model. It continues to work as a static touch viewer without camera permission.

Milestone 3 established local front-camera tracking. MediaPipe runs only after `Start 3D`, uses actual video dimensions, calibrates from stable observations, filters poses, and shuts down tracks on stop or page exit. The renderer builds a view and off-axis projection from each eye pose. Debug mode makes timing and pose visible.

Milestone 4 tunes initial perceptual correctness. Add a projection test demonstrating that a point behind the screen moves in the window-consistent direction while a point in front moves oppositely. Lower the default XY gain to a conservative value and keep handedness correction outside the projection matrices.

Milestone 5 handles cross-browser camera delivery. Infer Safari versus iOS Chrome as an initial horizontal sign, expose `Flip L/R`, persist the explicit choice, and force fresh calibration whenever it changes.

Milestone 6 replaces mobile raw-bounds fitting with a thin relief. Build screen X/Y from UV, compress radial source depth into a bounded span, place the nearest depth at the glass plane, and rigidly move any transformed geometry back if rotation or zoom crosses the glass. Transfer Desktop Depth Magnification as a mobile `depthSpan`, and damp face-distance-derived eye Z independently.

Milestone 7 runs the complete automated regression suite and browser smoke checks. The user then republishes the scene, reloads the mobile page, presses `Recenter` from a neutral pose, and reports whether direction, pivot, foreground size, and close-up response now feel natural. If tuning remains necessary, adjust the isolated XY/Z gains or bounded relief span; do not disturb Desktop/SBS/WebXR/Looking Glass reconstruction or projection geometry.

Milestone 8 incorporates the second device pass. Use the same corrected sign for Safari and iOS Chrome, halve Safari XY gain while retaining Chrome's already-weaker numerical gain, and reset stale sign persistence with a versioned storage key. Make `Publish to Mobile` produce a bounded GLB profile: no more than 65,535 vertices, compact indices, no normals, and a bounded texture. Preserve the standard Desktop export profile and expose distinct load stages for follow-up diagnosis.

Milestone 9 audits the miniature-behind-glass physics. Preserve the off-axis projection because its screen-plane invariant and behind-glass response are correct. Remove the accidental depth multiplication from pinch, halve the default mobile relief, damp apparent-eye-distance Z response to 10%, and add numerical tests showing that approach fixes glass-plane size while only slightly contracting distant content. Document that the present midpoint-eye tracker cannot separate device/head yaw from true Z motion and that a normal single panel cannot be binocular-correct for both eyes at close, tilted angles.

Milestone 10 gives the presentation physical units. `webapp/src/device-metrics.js` holds the active display size of each supported device in millimetres, derived from its published hardware pixel count and pixel density, and matched on the portrait-normalised CSS screen size plus the device pixel ratio. Unknown devices fall back to 160 CSS pixels per inch, which is close to both table entries and far better than the nominal 96. A user-measured millimetres-per-CSS-pixel value stored in the browser always wins. `computeViewingGeometry()` then turns the canvas height and a viewing distance into the world unit size, the eye distance, and the vertical field of view. The virtual screen is always two world units tall, so one world unit is half the canvas's physical height; that single relation is what converts real millimetres into the units every other module already uses.

Milestone 11 replaces guessed tracking gains with measurement. `createMediaPipeFaceLandmarker()` now requests `outputFacialTransformationMatrixes`, and `extractMetricHeadTranslation()` reads the translation column of that column-major 4x4, which is the head position in centimetres in a camera space where negative Z points away from the camera. `mapMetricPoseToEyePose()` divides those millimetres by the world unit size. X and Y are referenced to the calibration pose so `Recenter` still works and so the front camera's offset above the picture is absorbed automatically; Z stays absolute because a measured distance is exactly what the off-axis frustum needs and no longer has to be damped to disguise a scale error. Devices that do not deliver the matrix keep the previous landmark-ratio path and its gains.

Milestone 12 makes the depth budget usable. `computeReliefDepthRange()` takes quantiles at both ends rather than the absolute minimum and a far percentile, because disparity mapping is anchored on the reciprocal of the near reference and one stray foreground sample would otherwise compress everything else against the back plane. `normalizeReliefDepth()` blends a linear-in-distance mapping against a disparity mapping, defaulting fully to disparity, and flattens out-of-range samples onto the near or far plane so the mesh stays a closed sheet. The default relief span becomes one world unit, which is about half a screen height of depth behind the glass and is the thickness at which a typical near subject's relief is proportional to its size on screen. `reliefInteractionDepthScale()` restores uniform pinch scaling but stops depth growing once the relief would be thicker than a quarter of the measured eye distance.

Milestone 13 reduces what a constrained mobile browser has to hold in memory, and it targets the right consumer. At the 65,535-vertex ceiling the geometry is about 2 MB while a 2048-square texture is 16 MB once decoded, so the vertex cap saves little and costs mesh resolution that is now visible along stretched silhouettes. Publish the texture as JPEG instead of lossless PNG, decode it with `createImageBitmap` so no full-size RGBA copy is ever materialised on the main thread, raise the vertex ceiling to the desktop grid using 32-bit indices which WebGL2 supports without an extension, and give the viewer a real fallback: request a reduced variant after a genuine load failure rather than guessing a device's memory in advance, which no browser API on iOS reports.

## Concrete Steps

Work from `/home/amari1/github/Image-To-DepthWebViewer`.

Before edits, run:

    npm test
    npm run check:js
    npm run lint
    .venv/bin/python -m unittest discover -s tests -p 'test_*.py'

For the perceptual correction milestones, edit the tracking/runtime, scene manifest, relief, mobile viewer/renderer, relay validation, and corresponding test files. Run the focused numerical files first:

    node --test tests/mobile-publish-mesh.test.mjs tests/mobile-relief.test.mjs tests/head-coupled-projection.test.mjs tests/head-tracker-math.test.mjs tests/mobile-runtime.test.mjs tests/mobile-scene-client.test.mjs tests/glb-loader.test.mjs

Then repeat all four full validation commands plus `git diff --check`. Start or restart the project server through `scripts/run.py` when relay schema changes, open `/` and `/viewer.html`, and confirm both pages load without console errors. Do not restart the existing operator stack or use ad hoc tmux commands.

## Validation and Acceptance

Automated acceptance requires every JavaScript and Python test to pass, `check:js` to report success, ESLint to exit zero, and `git diff --check` to remain clean. Numerical tests must prove the shared Safari/Chrome sign and override persistence, browser-specific XY gain, reduced Z gain, baseline image-size preservation under extreme far depth, exact glass-plane anchoring, modest far-point contraction when the eye approaches, constant Z thickness under pinch, post-transform behind-glass enforcement, mobile vertex/texture budgets, compact index preservation, and unchanged standard Desktop GLB attributes.

Desktop acceptance requires the editor root to retain `Generate Depth`, `Save RGBDE`, `Save glTF`, `Publish to Mobile`, `Enter VR`, and `Enter Looking Glass`, with its normal monitor default. No mobile module is imported into the Desktop/SBS/WebXR/Looking Glass render loop.

Mobile acceptance requires the following observation after a new optimized publish and recentering from a neutral pose: moving the head to the viewer's right changes the virtual eye to display-space right in both Safari and Chrome; Safari XY motion is about half the original build; Chrome is no longer reversed; iPad Chrome reaches `Scene ready`; forward/back motion remains restrained; the nearest surface behaves as if attached to the glass; and pinch changes image size without increasing the depth/protrusion. `Flip L/R` must correct and remember any remaining device exception. Touch rotation, pinch zoom, and two-finger pan must still work with tracking stopped. Square-on or one-eye viewing is the reference for strict geometry because an ordinary display presents only one cyclopean image.

## Idempotence and Recovery

Publishing replaces only the in-memory scene and is safe to repeat. Reloading or restarting the frontend clears the relay; publish again. Camera start and stop are designed to be repeatable and stop all tracks on cleanup. If a device changes orientation, the current gesture is cancelled and active tracking is recentered.

If the inferred handedness is wrong on a specific browser, press `Flip L/R`; the viewer stores that browser choice and recalibrates. Use `/viewer.html?debug=1` to confirm the active flip and eye-X values. Do not revert projection matrices based on one browser. If motion or depth feels too weak, change the isolated tracking gains or bounded relief span; do not move geometry in front of the screen to amplify motion.

## Artifacts and Notes

The real-device feedback that triggered Milestone 4 was: horizontal movement looked reversed, geometry in front of the display looked unnatural, and the model response was too large. The source state at diagnosis used `frontOffset: 0.05`, `xGain: 1.35`, and `yGain: 1.35`.

The second-pass validation transcript was:

    node --test focused files: 23 passed, 0 failed
    npm test:                     54 passed, 0 failed
    Python unittest discovery:   15 passed, 0 failed
    npm run check:js:             21 files checked
    npm run lint:                 exit 0
    git diff --check:             exit 0
    browser errors at /:          none
    browser errors at viewer:     none
    optimized RGBDE publish:      65,490 vertices
    iPad/CriOS scene state:       ready, WebGL error 0

The physical-audit validation transcript was:

    node --test focused files: 24 passed, 0 failed
    npm test:                  56 passed, 0 failed
    Python unittest discovery: 15 passed, 0 failed
    npm run check:js:          21 files checked
    npm run lint:              exit 0
    git diff --check:          exit 0
    browser errors at /:       none
    browser errors at viewer:  none
    optimized RGBDE publish:   revision 8, 65,490 vertices, depthSpan 0.125
    mobile scene state:        ready, WebGL error 0

The relevant invariant is:

    display plane: z = 0
    viewer/eye:     z > 0
    default model:  every vertex z <= 0
    nearest sample: max z = 0

For a point at lateral model coordinate `X` and depth `D = -z >= 0`, viewed from cyclopean eye distance `E > 0`, the screen coordinate is:

    x_screen = X * E / (E + D)

Thus `D = 0` is fixed as `E` changes, while `D > 0` contracts slightly toward the center as the eye approaches. Pinch modifies `X`/`Y` only; it no longer modifies `D`.

## Interfaces and Dependencies

Keep the current browser-native interfaces. `createMobileSceneManifest()` returns schema version 1 and presentation defaults including `depthSpan`. `mobileDepthSpanForMagnification()` maps Desktop magnification to the bounded `0.025`–`0.225` relief thickness. `inferFrontCameraXyGain()` returns `0.325` for Safari/default and `0.65` for `CriOS`; it now applies only to the landmark-ratio fallback. `resolveScreenMetrics()` returns millimetres per CSS pixel plus the source of that figure, and `computeViewingGeometry()` returns the world unit size, eye distance, and vertical field of view. `extractMetricHeadTranslation()` returns millimetres and a positive distance from the camera, or `null` when the device does not supply the matrix. `mapMetricPoseToEyePose()` needs only `worldUnitMm` and the handedness flag. `computeReliefDepthRange()` returns quantile-bounded near and far references, `normalizeReliefDepth()` returns a bounded `0`–`1` position blended between linear and disparity mapping, and `reliefInteractionDepthScale()` returns the bounded pinch depth factor. `mapObservationToEyePose(observation, calibration, options)` returns `{x, y, z, confidence, timestamp}` and accepts independent `mirrorX`, XY gain, and Z gain options; the default Z gain is `0.1`. `createMobilePublishMesh()` returns a regular resampled grid bounded by `MAX_MOBILE_PUBLISH_VERTICES`. `fitMobileTextureSize()` returns aspect-preserving bounded dimensions. `createMobileReliefScene()` returns a cloned scene with screen-fitted relief positions and bounds. `createReliefInteractionMatrix()` returns the glass-pivot interaction transform with X/Y-only pinch scale. `constrainReliefBehindScreen()` returns the safe model matrix, transformed bounds, and any Z correction. `mat4.scaleAxes()` supplies per-axis scaling without changing the legacy uniform `mat4.scale()` used by existing paths. `computeOffAxisProjection()` returns the sanitized eye, frustum extents, and projection matrix. `computeEyeViewMatrix()` returns only the inverse eye translation. The legacy `computeMobileModelPlacement()` remains tested for compatibility but is no longer used by the mobile viewer.

MediaPipe Tasks Vision remains pinned in `webapp/src/head-tracker.js`; no new dependency is required for this tuning. The server remains FastAPI/uvicorn through the existing Python environment. Desktop, SBS, WebXR, and Looking Glass retain their current libraries and initialization order.

Revision note (2026-08-18): Reconstructed the missing living ExecPlan from the implemented working tree and added a perceptual-correction milestone after the user's first real-device observation. The revision records why screen-plane placement, camera handedness, and gain must be tested independently.

Revision note (2026-08-18, Milestone 4 completion): Recorded the implemented handedness, gain, and behind-glass defaults plus focused, full-suite, and browser-smoke evidence. Real-device perceptual confirmation remains the only open acceptance item.

Revision note (2026-08-18, Milestones 5–7): Recorded the user's RGBDE-load clarification, Safari/Chrome handedness split, persistent manual flip, exact glass-plane pivot, damped Z response, UV-anchored relief for distant scenes, new manifest depth span, live server restart, and final 47/15-test regression evidence. Real-device perceptual confirmation remains open.

Revision note (2026-08-19, Milestone 8): Superseded the incorrect `CriOS` sign exception, halved Safari XY motion while preserving Chrome's weaker gain, diagnosed iPad Chrome as a model-load rather than frame/UI failure, added a bounded mobile-only GLB profile and phased loading diagnostics, and recorded 54/15-test plus iPad/CriOS browser evidence. A new real-device publish remains the final acceptance step.

Revision note (2026-08-19, Milestone 9): Audited the behind-glass projection numerically, preserved the correct cyclopean off-axis formula, removed Z scaling from pinch, reduced Z gain and relief thickness, documented tilt/monoscopic limitations, and recorded 56/15-test plus revision-8 browser evidence. Real-device comfort and iOS-browser confirmation remain open.
