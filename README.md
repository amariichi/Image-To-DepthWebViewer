# Image-to-Depth Web Viewer
<img width="400" height="225" alt="Desktop editor" src="https://github.com/user-attachments/assets/92bbe04c-fc68-477a-be74-612d1e930189" /><img width="400" height="225" alt="Side-by-side stereo view" src="https://github.com/user-attachments/assets/241659fc-060d-49b3-9832-d0fd4689f8fc" />

Language / 言語: [English](#english) | [日本語](#日本語)

## English

### Overview
This repository now ships a two-part toolchain: a WebGL viewer in `webapp/` and a FastAPI backend in `server/`. Raw JPG/PNG images are uploaded through the UI, the backend runs Apple Depth Pro (pulled in as the `third_party/ml-depth-pro` submodule plus `depth-pro_rgbde.py`) to infer depth, and the resulting depth-augmented PNG (RGBDE PNG) streams straight back to the browser for preview and download. Generated RGBDE PNGs include Depth Pro focal length metadata, and metadata-bearing RGBDE files initialize the Geometry FOV from that camera estimate. Precomputed RGBDE assets remain fully supported. From the viewer you can export the adjusted mesh and texture as a binary glTF (`.glb`) with an unlit material (`KHR_materials_unlit`) for DCC packages such as Blender. While inspecting the scene you can switch between linear/log depth, apply magnification (0.1×–100×), clamp the far plane (1–1000 m), and tune both reconstruction and display FOVs in real time.

### Getting Started
1. Initialise the repo (installs requirements, creates `.venv`, pulls Depth Pro submodule):
   ```bash
   python scripts/bootstrap.py
   ```
   The script upgrades `pip`, creates the `.venv` virtual environment, installs `requirements.txt` (NumPy is pinned to `<2` for Depth Pro compatibility), and then installs the Depth Pro package (`pip install -e third_party/ml-depth-pro`). This step also pulls in PyTorch, torchvision, timm, and the other dependencies required by Depth Pro.
   If the automatic submodule checkout fails, the script falls back to cloning the repository directly. You can also run `git submodule update --init --recursive` yourself before re-running the bootstrap step.

2. Activate the virtual environment:
   ```bash
   # Linux / macOS
   source .venv/bin/activate
   # Windows PowerShell / CMD
   .\.venv\Scripts\activate
   ```
   On startup the backend checks `checkpoints/depth_pro.pt`; if absent it is fetched automatically from Hugging Face (`apple/DepthPro`). Set `DEPTH_DEVICE` (e.g., `cuda`, `cpu`) before launching if you need to force a specific device.

3. Start the development servers (frontend + backend). Recommended:
   ```bash
   python scripts/run.py
   ```
   This launches both servers in one terminal (`http://localhost:8000`, `http://localhost:5173`).
   To run them separately, launch the backend first:
   ```bash
   python scripts/run_backend.py
   ```
   …then, in another terminal:
   ```bash
   python scripts/run_frontend.py
   ```
   Both approaches expose `http://localhost:5173` (configurable via `RGBDE_FRONTEND_PORT`).
   For local performance spot checks, open `http://localhost:5173/perf-harness.html` after the frontend starts. The harness benchmarks the repository-local RGBDE fixtures and, when the backend is running, can also time one `/api/process` round trip.

4. Open the viewer in Chrome/Edge/Safari:
   - **2D Image (JPEG or PNG)** selects a source image; **Generate Depth** runs Depth Pro through the backend. The backend does not keep uploaded files after responding.
   - **Save RGBDE** downloads the current RGBDE PNG, and **Save glTF** exports the displayed mesh as a `.glb` with embedded texture and an unlit material (`KHR_materials_unlit`).
   - **Load RGBDE PNG file** / **Open file...** loads a precomputed RGBDE PNG. Drag-and-drop also works. If the PNG contains Depth Pro focal length metadata, **Geom FOV** is initialized from it for 2D, SBS, and XR display paths.
   - **Display Mode** switches between 2D and 3D SBS. **Stereo Separation** adjusts SBS eye spacing, and **Swap Left/Right for Cross-Eyed Viewing** swaps the SBS eye order.
   - **Geom FOV** controls reconstruction rays. The compact **Mesh** selector beside it switches reconstruction density between 1x, 2x, and 4x. **Screen FOV** controls the display camera separately.
   - **Depth Magnification**, **Depth Mode**, **Log Power**, **Far Crop Distance**, and **Model Z Offset** adjust depth shaping, clipping, and placement. Mouse wheel zooms, left-drag rotates, right-drag pans, and double-click resets the view.
   - **Enter VR**, **Enter Looking Glass**, and **Show XR hints** are described in the WebXR section below. Running the backend elsewhere? Set `window.__RGBDE_API_BASE__ = 'http://host:port'` before loading, or adjust `API_BASE` in `webapp/src/app.js`.

### Head-tracked mobile viewer

<img width="270" height="480" alt="Head-tracked mobile viewer running on an iPhone" src="https://github.com/user-attachments/assets/2d58b740-3433-4033-a32a-1b32f11c906f" />

Open `/viewer.html` on a phone or tablet and use its front camera to move the viewpoint. There are two independent ways to supply a scene:

- **Published scene:** load or generate RGBDE in the desktop editor, make any adjustments, and press **Publish to Mobile**. The relay keeps one optimized full GLB plus a reduced fallback in the memory of the process serving these pages. Reloading the page does not clear it; stopping that process does.
- **Paste image:** use the mobile **Paste image** button, keyboard paste, or **Details → Choose image** with an ordinary JPEG/PNG. The image is posted to the same-origin `/api/process`, the existing Depth Pro backend returns an RGBDE PNG, and the phone constructs the metric mesh in a Web Worker. This path does not require a desktop publish.

The route also runs the other way. Depth inference happens on this machine, so an image pasted on the phone is generated here and the RGBDE passes through this host on its way out; a copy is kept. **Open mobile image** in the editor opens that copy, which puts a phone-pasted scene into the desktop pipeline — Depth Magnification, Geometry FOV, glTF export, VR, Looking Glass — with nothing uploaded from the phone and nothing charged to a metered connection. It is a pull, so a scene being worked on in the editor is never replaced because someone picked up the phone. The button reports the file, lens and time it is offering, and is greyed out until the phone has generated something.

On the phone, open the serving machine's page, for example `https://192.168.1.5:5173/viewer.html`.

**This has to be HTTPS.** Browsers only give a page the camera on a secure origin, and a plain `http://` LAN address is not one. (`localhost` is treated as secure, but on the phone that means the phone itself, not the machine running the server.) Two ways to get it:

```bash
python scripts/run.py --https
```

Creates a self-signed certificate on first use and prints the address to open. The phone will warn about it once; continue past the warning.

```bash
tailscale serve 5173
```

If you use Tailscale, this serves the port over your tailnet with a genuine certificate, so there is no warning and nothing to install on the phone. It stays inside your tailnet rather than going out to the internet. `tailscale cert` can also issue certificate files to pass to `--https` with `--cert` and `--key`.

After the scene is ready, press **Start 3D** and hold still while face calibration completes. Start is deliberately a separate tap: a long Depth Pro request can outlive iOS user activation, so the viewer does not pretend it can request the camera automatically afterward. Motion and orientation permission is requested from that Start gesture where the platform requires it. Denying motion leaves camera tracking usable and **Hold level** off. Turning the phone about the screen's vertical axis is corrected in every mode and with Hold either on or off: the tracked eye is read in the heading reference and the scene receives the inverse turn, so the world behind the glass stays where it is in the room. Heading is also subtracted from the gravity tilt a turn explains, which is what Hold and True Window's persistent pitch rely on. **Stop camera** is in Details, and **Start 3D** can restart it later.

The primary controls have these meanings:

| Control | Effect |
| --- | --- |
| **Start 3D / Recenter** | Start the front-camera tracker, or capture fresh face and gravity references without reloading the scene. The diagnostic heading reference is refreshed too, but does not affect rendering. |
| **Hold level** | Add a partial model roll/horizon hold relative to the Start/Recenter posture. True Window always retains a gentle reference-relative phone pitch (0.5 response, capped at 9°) so tipping the glass still changes elevation with Hold off without flipping a deep mesh far enough to expose its back; Hold does not rotate the tracked eye. Its X/Y values are reference-relative while Z is an absolute distance, so rotating that mixed-origin vector would create an orbit rather than a camera shift. Photo mode uses the same gentle Hold roll and no model pitch. Turning the phone is corrected separately from Hold and in both modes, because which way the glass faces is not a stabiliser but what makes it a window: a camera watching a face cannot tell a turned phone from a moved head, and reading the turn as the head alone showed the far edge of the mesh where the near one belonged. Heading additionally removes the portion of gravity roll/tip a turn around screen up explains, and a drifting heading is forbidden from creating or enlarging tilt. The screen-up axis is inferred from the fresh gravity reference, so landscape uses device X rather than the portrait-only device-Y assumption. True Window also applies this separation with Hold off because its pitch remains active then; photo mode with Hold off remains camera-only. Portrait/landscape changes automatically capture fresh sensor references without requesting permission again. |
| **Reverse tracking** | On by default to correct the unmirrored front-camera horizontal axis. Turn it off only if left/right feels reversed on the device. The preference is remembered. |
| **True Window** | Switch between a physically fixed aperture and photo-aligned relief; see below. |
| **Setback** | In True Window, move the complete uniformly scaled miniature 0/25/50/100/200 mm farther behind the glass. It is not relief-depth magnification. |
| **Paste image** | Read the current clipboard image. If clipboard access is unavailable or denied, keyboard paste and **Details → Choose image** remain available. |
| **Reset** | Reset touch rotation, pan, and scale without discarding the source or physical calibration. |
| **Details → Use size** | Enter the illuminated panel's longer side in millimetres, for a device the built-in table does not have or gets wrong. |
| **Details → Calibrate** | Correct the tracker's idea of how far away you are. Press **Start 3D** first and let the distance settle, enter your real eye-to-glass distance in millimetres (100 to 1500), then press it and hold still and centred while tracking recentres. The reading beside it stays at `scale 1.000×` until this has been done once, and the result is remembered across reloads. |
| **Hide UI** | Remove routine chrome. A clean double-tap on empty stage space hides or restores it; reload always starts visible. Build/FOV/error states reveal themselves so the page remains recoverable. |

**True Window on** treats the measured glass, physical eye, and metric mesh as one coordinate system. Its neutral pose is **Source exact**: the original capture-camera apex is mapped to the calibrated physical eye, while a robust 0.1-percent near-depth anchor lands on the glass. The transform is one equal X/Y/Z scale plus translation; there is no display-side 50 mm target or camera backoff. Every source-camera ray therefore returns to its original image coordinate at the neutral pose, which keeps a triangle spanning a depth edge hidden there instead of exposing it immediately. Away from that exact reference, lateral eye X uses the source-lens response with a comfort gain of 2.40 in portrait and 2.88 in landscape and a camera-X-only response ceiling of 1.50. This preserves the hardware-matched portrait/landscape feel while making left-edge/right-edge forward/back motion substantially stronger. The pitch-coupled eye Y/Z pair retains its separate depth/framing-matched response and 1.0 ceiling, so top-edge forward/back pitch, approach comfort, the mesh, and its neutral image are unchanged. Close approach remains bounded. These response gains affect camera motion, not model X/Y proportions, so faces are not stretched at rest. Head or device motion still creates a new view and can reveal surfaces that a single image never captured. Initial view and **Reset** automatically fit the complete source frame, using capture FOV, source/viewport aspect, and the reference-eye distance; Details labels this `auto fit`. This may select framing below 1.00×, which expands only a virtual overview aperture and does not move the mesh or source camera. At **1.00× framing** the phone glass is the literal aperture, reachable by zooming back toward 1.00×. The fitted overview is intentionally no longer a literal physical pane. Setback remains an explicit rigid millimetre translation and is included in the parallax depth.

**True Window off** also preserves the source photograph at the neutral view, but remaps arbitrary metric depth into a bounded, screen-fitted relief. Like StereoSplatViewer photo mode, it builds that relief around the source-camera apex and uniformly maps all three physically tracked eye axes from the comfortable holding distance into that camera space, with a close-approach bound. Its **Relief depth**, disparity blend, visible-front anchoring, and zoom-region refit controls are in Details. The two modes therefore look intentionally similar before movement: on keeps raw metric XYZ and offers the literal aperture at 1.00×, while off prioritizes a manageable relief thickness and can refit that depth to the zoomed region.

Touch works with or without the camera:

| Gesture | Effect |
| --- | --- |
| One finger | Rotate, within ±30° |
| Two fingers, pinch | True Window: change window framing; photo mode: scale the relief |
| Two fingers, move together | Pan |

In photo mode, zooming also refits the visible depth range: content still on screen is brought toward the glass and given the available relief, while zooming back out restores the complete range. Published scenes initialize that relief from desktop **Depth Magnification**; direct-paste scenes start from the mobile default.

**Details** holds the two physical calibrations above, the source FOV/lens, published-scene reload, photo Relief controls, fallback viewing distance, runtime readings, and **Stop camera**. For a raw pasted image without EXIF, Depth Pro estimates the capture focal length and embeds it in the returned RGBDE, so no pre-inference millimetre entry is required. The resulting familiar **Lens (35 mm equivalent)** value can be edited from 10–800 mm and applied with **Rebuild depth**; typing alone does not start inference. The button is available only for a source pasted or chosen in this tab, because a published GLB carries no original photograph. A legacy RGBDE/GLB without any capture FOV opens a blocking but recoverable vertical-FOV prompt before metric geometry is built.

The pasted ordinary image and returned RGBDE travel only to/from this application's same origin. The backend does not retain the upload after responding. The host serving these pages keeps the generated RGBDE in memory so the editor can open it, in the same single slot fashion as a published scene and with the same lifetime: it lives in the serving process, so reloading a page leaves it alone and stopping that process clears it. Only a request the phone marked as its own fills it, and the next one replaces it. To support an explicit lens rebuild, the active tab keeps one filename-free source Blob only in browser memory; a successful source replacement, loading a published scene, navigation, or tab close releases it. Camera frames and face landmarks never leave the phone and are never placed in status or logs. The pinned MediaPipe runtime/model need network access on first use; later loads can use the normal browser cache while it remains present, but clearing site data or an evicted cache requires another download.

**Publish to Mobile** sends a smaller asset than **Save glTF**: a JPEG texture capped at 2048 px and two megapixels, a resampled grid, and no normals. A reduced build is uploaded alongside it, and the viewer falls back to that only if the full one fails to load. The relay keeps one scene in the serving process's memory, which a page reload does not touch.

Add `?debug=1` to the viewer URL for expanded live tracking and performance readings. These settings can also be pinned on the URL:

| Parameter | Effect |
| --- | --- |
| `?flip=0` / `?flip=1` | Force the horizontal tracking direction |
| `?level=0` | Turn off keeping the view upright |
| `?trueWindow=0` | Start in photo-aligned relief instead of True Window |
| `?delegate=cpu` / `gpu` | Force which processor runs the face model |

An ordinary panel shows both eyes the same image, so viewing square-on, or with one eye, is where the geometry is most convincing. A single-view mesh has no information for surfaces hidden behind an occluding edge. Looking around can therefore reveal a stretched triangle or missing hidden surface; projection and calibration cannot reconstruct data that was absent from the source. The viewer deliberately keeps depth-discontinuity triangles rather than opening black holes. A Gaussian-splat viewer has the same missing-view limitation, but its independent soft blobs do not create a single connected bridge triangle, so the seam is usually less geometric and more softly spread.


### WebXR / XR playback
- The control panel now includes **Enter VR** and **Enter Looking Glass** buttons (requires a WebXR-enabled Chromium-based browser on HTTPS/localhost).
- **PC-tethered OpenXR headsets** (Meta Quest via Link, Valve Index, HTC Vive, Varjo, HP Reverb G2, etc.): launch the vendor’s OpenXR runtime (Meta Quest Link, SteamVR, Windows Mixed Reality, Varjo Base, …), open the viewer in Chrome/Edge on the host PC, then click *Enter VR*. Ending the session returns to the standard canvas.
- **Looking Glass displays:** install Looking Glass Bridge, connect the display, and click *Enter Looking Glass*. The viewer dynamically loads the official `@lookingglass/webxr` v0.6.0 polyfill to drive the multi-view quilt. Keep Bridge running so the polyfill detects the display. Looking Glass renders many viewpoints at once, so once in XR the model appears freely rotatable even though the mouse-driven offsets stay within the ±30° clamp.
- **VR controller mapping:** while in VR, the left controller mirrors the desktop interactions—trigger + move to orbit, grip + move to pan, trigger + forward/back to zoom, stick left/right adjusts Geometry FOV (15–120°, default 32°), stick up/down changes Depth Magnification (0.1×–100×), X decreases Far Clip, Y increases Far Clip. Controllers are not rendered in the scene, but inputs remain live. Double-click the canvas to reset if the view drifts.
- **Hint overlay:** the viewer shows a brief control cheat sheet when a VR session starts and single-line popups for subsequent inputs. If you prefer a clean view, untick *Show XR hints* next to the *Enter VR* button; you can re-enable it at any time.
- **Looking Glass to VR workflow:** the Looking Glass WebXR polyfill replaces `navigator.xr` and leaves it patched; after exiting a Looking Glass session, reload the page (Ctrl+F5) before starting a standard VR session. Skipping the reload typically yields “VR session blocked: click Enter VR again”.
- WebXR requires a secure origin; deploy behind HTTPS in production (self-signed certificates won’t satisfy Quest browsers). Local development on `http://localhost` works because browsers treat it as a secure context.
- While an XR session is active the 2D UI hides automatically—press the toggle on exit to restore it if needed.

### Repository Layout
- `webapp/index.html` – entry point and UI shell.
- `webapp/viewer.html` – head-tracked mobile viewer and touch-first startup shell.
- `webapp/perf-harness.html` – lightweight local benchmark page for RGBDE decode, preprocessing, mesh generation, and optional backend round-trip timing.
- `webapp/src/geometry.js` – RGBDE decoding, depth preprocessing, mesh density selection, and pinhole projection.
- `webapp/src/rendering.js` – WebGL2 renderer, shader setup, and camera math.
- `webapp/src/app.js` – event wiring, UI bindings, and interaction logic.
- `webapp/src/gltf-exporter.js` – binary glTF (`.glb`) writer used by the *Save glTF* workflow.
- `webapp/src/mobile-viewer.js` – mobile scene loading, touch presentation, camera tracking, and off-axis projection wiring.
- `webapp/src/mobile-depth-client.js` / `mobile-rgbde-worker.js` – same-origin image inference transport and transferable RGBDE mesh construction.
- `webapp/src/mobile-source-scene.js` / `mobile-window-placement.js` – shared source contract and physically uniform True Window placement.
- `webapp/src/mobile-relief.js` – screen-fitted, behind-glass relief generation for published scenes.
- `webapp/src/mobile-levelling.js` / `mobile-chrome.js` – pure device-attitude composition and recoverable UI visibility state.
- `webapp/src/mobile-publish-mesh.js` – mobile-only grid and texture budgets used during publish, including the reduced fallback profile.
- `webapp/src/device-metrics.js` – physical screen size per device and the viewing geometry derived from it.
- `webapp/src/device-tilt.js` – filtered gravity input used by Hold level, plus relative screen heading that may only subtract screen-up-coupled gravity tilt and never render yaw; the pure levelling boundary derives the portrait/landscape transport axis from the captured gravity reference.
- `webapp/src/webxr.js` – WebXR and Looking Glass session lifecycle, including the module preload that keeps the entry click's user activation intact.

### Third-Party Resources
- **Apple Depth Pro** – Pulled via `scripts/bootstrap.py` into `third_party/ml-depth-pro`. Usage is governed by Apple’s sample code license (`third_party/ml-depth-pro/LICENSE`). Installers must agree to that license before running the backend.
- **Looking Glass WebXR Polyfill** – Loaded at runtime from the official CDN (`@lookingglass/webxr`). The package is not bundled with this repo; when used, it remains subject to Looking Glass Factory’s license terms (see the package’s `LICENSE` on npm).
- **MediaPipe Tasks Vision / Face Landmarker** – The mobile viewer loads pinned Tasks Vision 1.0.0 code and the float16 Face Landmarker v1 model at runtime. Inference stays in the browser; camera frames and landmarks are not sent to the scene relay.
- These components are external dependencies and are not redistributed here. If you plan to bundle them, ensure your distribution complies with each provider’s license terms (including any redistribution restrictions).


## 日本語

### 概要
本リポジトリは WebGL ビューア (`webapp/`) と Python/FastAPI バックエンド (`server/`) をセットで提供します。フロントエンドから JPG / PNG をアップロードすると、バックエンドが submodule で取り込んだ Apple Depth Pro（`third_party/ml-depth-pro` と `depth-pro_rgbde.py`）を実行し、右半分に little-endian の uint32 深度を埋め込んだデプス付き PNG（RGBDE PNG）を生成、即座にブラウザへ返します。生成される RGBDE PNG には Depth Pro の推定焦点距離メタデータも埋め込まれ、メタデータを持つ RGBDE を読み込むと、そのカメラ推定値から Geometry FOV が初期化されます。既存の RGBDE PNG をドラッグ＆ドロップで読み込むこともできます。UI では線形／対数デプス、拡大率（0.1×〜100×）、最大距離クロップ（1〜1000 m）、再構成・表示 FOV を調整でき、調整済みメッシュとテクスチャをバイナリ glTF (`.glb`) として書き出して Blender などで再利用できます。

### 使い方
1. まず依存関係と Submodule をまとめてセットアップします。
   ```bash
   python scripts/bootstrap.py
   ```
   上記で `.venv` が作成され、`requirements.txt` と Depth Pro パッケージ（`pip install -e third_party/ml-depth-pro`）がインストールされます。
   サブモジュール初期化に失敗した場合でもスクリプトが直接 clone を試みますが、`git submodule update --init --recursive` を手動で実行してから再度ブートストラップすることもできます。

2. 仮想環境を有効化します。
   ```bash
   # Linux / macOS
   source .venv/bin/activate
   # Windows PowerShell / CMD
   .\.venv\Scripts\activate
   ```
   起動時に `checkpoints/depth_pro.pt` が存在しない場合は Hugging Face (`apple/DepthPro`) から自動ダウンロードします。デバイスを固定したい場合は起動前に `DEPTH_DEVICE=cuda`（または `cpu` など）を設定してください。

3. 開発用サーバーを起動します。おすすめの方法:
   ```bash
   python scripts/run.py
   ```
   1つのターミナルでバックエンド (`http://localhost:8000`) とフロントエンド (`http://localhost:5173`) が一括起動します。
   個別に起動したい場合は、先にバックエンドを立ち上げてから別ターミナルでフロントエンドを起動してください。
   ```bash
   python scripts/run_backend.py
   # 別ターミナル
   python scripts/run_frontend.py
   ```
   どちらの場合も `RGBDE_FRONTEND_PORT` でフロントエンドのポートを変更できます。
   ローカルで処理時間をざっと確認したい場合は、フロントエンド起動後に `http://localhost:5173/perf-harness.html` を開いてください。リポジトリ同梱の RGBDE fixture を使って、デコード・前処理・メッシュ生成を計測でき、バックエンド起動中なら `/api/process` の往復時間も確認できます。
   
4. ブラウザ (Chrome / Edge / Safari) で `http://localhost:5173` を開き、以下を操作します。
   - **2D Image (JPEG or PNG)** で元画像を選び、**Generate Depth** でバックエンド経由の Depth Pro 推論を実行します。サーバー側の一時ファイルはレスポンス後に削除されます。
   - **Save RGBDE** は表示中の RGBDE PNG を保存し、**Save glTF** は現在のメッシュとテクスチャを `.glb` としてエクスポートします。`KHR_materials_unlit` 拡張を使ったアンリットマテリアル付きです。
   - **Load RGBDE PNG file** / **Open file...** で作成済み RGBDE PNG を読み込めます。ドラッグ＆ドロップにも対応します。Depth Pro の推定焦点距離メタデータを含む場合は、2D / SBS / XR の表示方式に関係なく **Geom FOV** の初期値に反映されます。
   - **Display Mode** は 2D / 3D SBS の切り替えです。**Stereo Separation** は SBS の目間距離、**Swap Left/Right for Cross-Eyed Viewing** は SBS の左右入れ替えを調整します。
   - **Geom FOV** は再構成用の視野角です。横のコンパクトな **Mesh** セレクタで再構成密度を 1x / 2x / 4x に切り替えられます。**Screen FOV** は表示カメラ側の視野角です。
   - **Depth Magnification**、**Depth Mode**、**Log Power**、**Far Crop Distance**、**Model Z Offset** はデプス変形、クロップ、配置を調整します。マウスホイールでズーム、左ドラッグで回転、右ドラッグで平行移動、ダブルクリックでリセットします。
   - **Enter VR**、**Enter Looking Glass**、**Show XR hints** は下の WebXR セクションで説明しています。バックエンドを別ホスト／別ポートで稼働させる場合は、ページ読込前に `window.__RGBDE_API_BASE__ = "http://host:port"` を設定するか、`webapp/src/app.js` の `API_BASE` を編集してください。

### ヘッドトラッキング対応モバイルビューア

<img width="270" height="480" alt="Head-tracked mobile viewer running on an iPhone" src="https://github.com/user-attachments/assets/2d58b740-3433-4033-a32a-1b32f11c906f" />

スマホ／タブレットで `/viewer.html` を開き、前面カメラで視点を動かします。シーンを渡す方法は独立した2種類です。

- **公開シーン:** デスクトップエディタで RGBDE を読み込むか生成し、調整して **Publish to Mobile** を押します。relay は最適化した完全版 GLB と縮小フォールバックを1組だけ、**ページを配信しているプロセスのメモリ**に保持します。ページの再読込では消えません。消えるのはそのプロセスを停止したときです。
- **画像を貼り付け:** モバイルの **Paste image**、キーボード貼り付け、または **Details → Choose image** から通常の JPEG/PNG を選びます。画像は同一オリジンの `/api/process` へ送られ、既存の Depth Pro バックエンドが RGBDE PNG を返し、端末上の Web Worker が実寸メッシュを組み立てます。デスクトップで Publish する必要はありません。

経路は逆向きにも通ります。デプス推定はこのマシンで走るので、スマホで貼り付けた画像もここで生成され、RGBDE は出ていく途中でこの host を通ります。その写しを保持しておき、エディタの **Open mobile image** で開きます。スマホで貼った画像をそのままデスクトップの経路（Depth Magnification、Geometry FOV、glTF 書き出し、VR、Looking Glass）に載せられて、**スマホからは何もアップロードしません**。従量回線に二重の課金が発生しません。pull なので、エディタで作業中のシーンが、誰かがスマホを触ったせいで置き換わることもありません。ボタンには渡せるファイル名・レンズ・時刻が出て、スマホがまだ何も生成していないあいだは押せません。

スマホで配信元 PC のページを開きます（例: `https://192.168.1.5:5173/viewer.html`）。

**HTTPS である必要があります。** ブラウザはセキュアオリジンでしかカメラを許可せず、素の `http://` の LAN アドレスはこれに当たりません（`localhost` は例外扱いですが、スマホで開いた `localhost` はスマホ自身であって PC ではありません）。方法は2つあります。

```bash
python scripts/run.py --https
```

初回に自己署名証明書を作り、開くべきアドレスを表示します。スマホでは証明書の警告が1度出るので、そのまま進んでください。

```bash
tailscale serve 5173
```

Tailscale を使っている場合はこちらが簡単です。tailnet 内に正規の証明書付きで公開されるため警告は出ず、スマホ側に入れるものもありません。インターネットには出ず tailnet 内に閉じます。`tailscale cert` で証明書ファイルを発行し、`--https` に `--cert` / `--key` で渡すこともできます。

シーンの準備後に **Start 3D** を押し、顔の較正が終わるまで静止します。Start を別のタップにしているのは、Depth Pro の長い処理中に iOS のユーザー操作権限が失効し、完了後の自動カメラ要求が拒否されるためです。対応環境では Start の同じ操作からモーションと向きの許可を要求します。モーションを拒否してもカメラ追跡は使え、**Hold level** はオフになります。画面の縦軸まわりに端末を回した分は、全モード・Hold の両状態で補正します。追跡した目を heading 基準で読み、シーンには逆回転を与えるので、ガラスの奥の世界は部屋に対して静止します。heading は同時に、その回転で説明できる重力傾斜を差し引く用途にも使い、これを Hold と Hold off でも残る True Window のピッチが利用します。**Stop camera** は Details にあり、後で **Start 3D** から再開できます。

主なボタンの意味は次のとおりです。

| ボタン | 効果 |
| --- | --- |
| **Start 3D / Recenter** | 前面カメラ追跡を開始します。動作中はシーンを再読込せず、顔・重力の基準を取り直します。診断用heading基準も更新しますが、描画には使いません。 |
| **Hold level** | Start／Recenter時の持ち方を基準に、モデル側へ弱めの水平／ロール維持を追加します。True WindowではHold offでもガラスを前後に倒した仰角が弱め（0.5倍、最大9°）に残るため、反応を失わず、深いメッシュが裏返るほどは回りません。Holdは追跡した目を回転させません。目のX/Yは基準からの差分、Zは絶対距離なので、原点の異なる3成分を一緒に回すとカメラ移動ではなくオービットになるためです。写真モードも同じ弱めのHoldロールだけを使い、モデルのピッチは加えません。端末を左右に向けた分はHoldとは独立に、両モードで補正します。ガラスがどちらを向いているかは安定化機能ではなく、窓が窓であるための情報だからです。顔を見るカメラは「端末が回った」と「頭が動いた」を区別できず、頭だけと解釈するとメッシュの手前側ではなく奥側の端が見えていました。headingはこれに加えて、画面の縦軸まわりの回転で説明できる重力roll/tipをゼロ方向へ差し引き、headingドリフトから新しい傾きを作ることは禁止します。縦軸は新しい重力基準から推定するため、横画面では縦画面用の端末Yではなく端末Xを使います。Hold offでもピッチが残るTrue Windowにはこの分離を適用し、写真モードのHold offは従来どおりカメラだけで動きます。縦／横画面の切替時は権限を再要求せずセンサー基準を取り直します。 |
| **Reverse tracking** | 前面カメラの非ミラー座標を補正するため、デフォルトでオンです。端末上で左右が逆に感じる場合だけオフにします。設定は保存されます。 |
| **True Window** | 実寸の固定窓と、元写真を再現する relief を切り替えます。下記参照。 |
| **Setback** | True Window で、均一スケールのミニチュア全体をガラスから 0/25/50/100/200 mm 奥へ移動します。relief の厚みとは別物です。 |
| **Paste image** | クリップボードの画像を読みます。許可されない場合も、キーボード貼り付けと **Details → Choose image** が使えます。 |
| **Reset** | 元画像や物理較正を捨てず、タッチ回転・移動・倍率だけを初期化します。 |
| **Details → Use size** | 内蔵の端末表に無い、または値が合わない機種で、発光パネルの長辺をミリメートルで入力します。 |
| **Details → Calibrate** | 追跡側が持っている「あなたまでの距離」を補正します。先に **Start 3D** を押して距離が落ち着くのを待ち、実際の目からガラスまでの距離をミリメートル（100〜1500）で入れて押し、再センタリングのあいだは中央で静止します。隣の表示は一度も較正していないあいだ `scale 1.000×` のままで、結果は再読込後も保存されます。 |
| **Hide UI** | 通常UIを消します。何もない表示領域を正しくダブルタップすると非表示／再表示できます。再読込時は必ず表示から始まり、生成・FOV・エラーは自動で現れるため復旧不能になりません。 |

**True Window on** では、実測したガラス面・観察者の目・メートル単位のメッシュを同じ座標系で扱います。基準姿勢は **Source exact** です。元の撮影カメラ頂点を較正済みの実際の目へ合わせ、カメラ軸深度の0.1パーセンタイルを安定した近接アンカーとしてガラスへ置きます。変換はx/y/zで同じ一様倍率と平行移動だけで、表示側の50mm目標やカメラ後退はありません。そのため基準姿勢では全撮影光線が元画像の座標へ戻り、深度境界を跨ぐ三角形も開始直後から別視点へ露出しません。この基準からの目移動では、横方向Xは撮影レンズ由来の応答へ縦画面2.40倍・横画面2.88倍の補正を加え、X専用の応答上限を1.50にします。実機で揃った縦横の体感比を保ちながら、左右端を奥／手前へ振る動きだけを大きくします。前後傾斜と結びつくY/Zは従来どおり同じ深度／framing補正と1.0上限を使うため、上端を奥／手前へ倒すPitch、接近時の快適性、メッシュ、基準画像は変わりません。これはカメラ移動の倍率であり、メッシュのX/Y比や基準姿勢の顔形状は変えません。過度な接近も制限し、Source exactは保持されます。実際に頭や端末を動かせば新しい視点になるため、1枚の画像に写っていない面が現れる可能性は残ります。初期表示と **Reset** は、撮影FOV、画像と画面の縦横比、基準となる目の距離から元画像全体を自動で収め、Detailsには `auto fit` と表示します。このとき1.00×未満になる場合は投影上の確認窓だけが広がり、メッシュや撮影カメラは動きません。**Framing 1.00×** は実物のガラスをそのまま窓にする表示で、ピンチで1.00×まで拡大すれば戻せます。自動フィットの全体表示は意図的に実物どおりの窓ではありません。Setbackは明示的なミリメートル単位の剛体移動で、視差計算の奥行きにも含まれます。

**True Window off** も中立視点では元写真を再現しますが、実深度を画面内へ収まる有限のreliefへ再割り当てます。StereoSplatViewerの写真モードと同様に、撮影カメラの頂点を基準にreliefを作り、実際の保持距離で得た目のX/Y/Zを同じ倍率でそのカメラ空間へ写像し、過度な接近を制限します。**Relief depth**、disparity blend、手前面の固定、ズーム範囲への深度再割当はDetailsにあります。そのため動かす前の両モードが似て見えるのは意図どおりです。onはメートルXYZを保持し1.00×で実物の窓を使えますが、offは扱いやすい厚みを優先し、ズーム範囲へ深度を再配分できます。

タッチ操作はカメラの有無にかかわらず使えます。

| 操作 | 効果 |
| --- | --- |
| 1本指 | ±30° 以内の回転 |
| 2本指ピンチ | True Windowでは窓の表示範囲、写真モードではrelief倍率を変更 |
| 2本指を一緒に動かす | 平行移動 |

写真モードでズームすると可視範囲の深度も再割当され、画面内のものがガラス側へ寄り、利用可能な relief を使います。ズームを戻すと全体の深度範囲へ復帰します。公開シーンはデスクトップの **Depth Magnification** から初期値を受け取り、直接貼り付けたシーンはモバイル既定値から始まります。

**Details** には、上の2つの物理較正のほか、ソースFOV／撮影レンズ、公開シーンの再読込、写真 Relief、予備の視距離、実行時測定値、**Stop camera** があります。EXIFのない通常画像を貼り付けた場合はDepth Proが撮影焦点距離を推定して返却RGBDEへ埋め込むため、推論前のmm入力は必須ではありません。表示された **Lens (35 mm equivalent)** は10〜800mmの範囲で編集でき、**Rebuild depth** を押したときだけ再推論します。入力中に勝手に推論は始まりません。このボタンは同じタブで貼り付け／選択した元画像にだけ使え、公開GLBには元写真がないため無効です。撮影FOVを一切持たない古い RGBDE/GLB は、実寸メッシュを作る前に復旧可能な垂直FOV確認画面を出します。

貼り付けた通常画像と返却RGBDEが通信するのは、このアプリの同一オリジンだけです。バックエンドは応答後にアップロードを保持しません。ページを配信している host 側は、エディタから開けるように生成された RGBDE をメモリに保持します。公開シーンと同じ1枠方式・同じ寿命です。**配信プロセスの中にあるので、ページを再読込しても残り、そのプロセスを停止すると消えます。**入るのはスマホが自分のものとして印を付けたリクエストの結果だけで、次の生成が来れば置き換わります。焦点距離の明示的な再推論のため、現在のタブはファイル名を持たない元画像Blobを1つだけブラウザメモリに保持します。別の元画像の生成成功、公開シーン読込、移動、タブ終了で解放されます。カメラ映像と顔ランドマークは端末外へ出ず、ステータスやログにも入りません。固定版 MediaPipe ランタイム／モデルは初回だけネットワーク取得が必要です。以後は残っている通常のブラウザキャッシュを利用できますが、サイトデータ消去やキャッシュ退避後は再取得が必要です。

**Publish to Mobile** は **Save glTF** より小さいデータを送ります（JPEG テクスチャ・一辺2048px かつ200万画素以下、再サンプリングしたグリッド、法線なし）。同時に縮小版もアップロードし、完全版の読み込みに失敗したときだけそちらへ切り替えます。relay が保持するのは1シーンのみで、**配信プロセスのメモリ**にあります。ページの再読込では消えません。

URL に `?debug=1` を付けると、追跡と性能の詳細な実測値が表示されます。以下は URL で固定できます。

| パラメータ | 効果 |
| --- | --- |
| `?flip=0` / `?flip=1` | 左右方向を強制 |
| `?level=0` | 水平維持を無効化 |
| `?trueWindow=0` | True Window ではなく写真 relief で開始 |
| `?delegate=cpu` / `gpu` | 顔モデルを実行するプロセッサを強制 |

通常のパネルは両眼に同じ像を出すため、**画面を正対させるか片目で見る**と幾何学的に最も整合します。単一視点メッシュには、遮蔽物の裏に隠れていた面の情報がありません。横から見ると三角形の引き伸ばしや隠れ面の欠落が見える場合があり、投影や較正だけで元画像に無い形状を復元することはできません。このビューアは黒い穴を開けないため、深度不連続をまたぐ三角形を意図的に残します。Gaussian Splatにも隠れ面不足はありますが、互いに独立した柔らかい粒子なので、1枚の連結三角形として伸びず、境界が幾何学的な板より柔らかく広がって見える傾向があります。


### WebXR / XR 再生
- コントロールパネルに **Enter VR** / **Enter Looking Glass** ボタンを追加しました（WebXR 対応の Chromium 系ブラウザ + HTTPS/localhost が必要）。
- **PC 接続型 OpenXR ヘッドセット**（Meta Quest + Link、Valve Index、HTC Vive、Varjo、HP Reverb G2 など）: 各ベンダーの OpenXR ランタイム（Quest Link、SteamVR、Windows Mixed Reality、Varjo Base など）を起動し、PC の Chrome / Edge でビューアを開いて *Enter VR* を押すと没入セッションが開始します。終了すると通常表示に戻ります。
- **Looking Glass displays**: Looking Glass Bridge を起動しディスプレイを接続してから *Enter Looking Glass* を押すと、公式 `@lookingglass/webxr` v0.6.0 polyfill を動的に読み込み、多視点キルト描画に切り替わります。Bridge を常時起動しておいてください。多視点キルトにより表示側で広い角度が補間されるため、XR中はモデルを自由に回しているように見えます（マウス操作の回転制限自体は従来どおり ±30° です）。
- **VR コントローラー操作**: 左コントローラーでマウス操作に相当するインタラクションが行えます。トリガー＋左右／上下で回転、グリップ＋移動で平行移動、トリガー＋前後でズーム、スティック左右で再構成 FOV、スティック上下で Depth Magnification、X ボタンで Far Clip を短く、Y ボタンで Far Clip を大きくできます。コントローラー自体は描画されませんが、入力は反映されます。ビューが崩れた場合はキャンバスをダブルクリックで初期状態に戻せます。
- **ヒント表示**: VR セッション開始時に操作チートシートが表示され、その後は操作に応じて 1 行のヒントがポップアップします。不要な場合は *Enter VR* の横にある *Show XR hints* のチェックを外すと非表示にでき、必要になったら再度チェックを入れて表示を戻せます。
- **Looking Glass と VR の切り替え**: Looking Glass の WebXR ポリフィルは `navigator.xr` を差し替えたまま復元しないため、Looking Glass を Exit した直後に *Enter VR* を押すとブラウザがセッションを拒否して「VR session blocked: click Enter VR again」と表示されます。現状はページをリロード（例: `Ctrl+F5`）した後に VR を開始してください。
- WebXR API は HTTPS などのセキュアオリジンでのみ利用可能です。Quest ブラウザでは自己署名証明書は使えないため、本番では正規証明書を用意してください。ローカル開発での `http://localhost` アクセスは例外的にセキュア扱いとなるため、その場合は従来どおり動作します。
- XR セッション中は 2D UI が自動的に非表示になります。終了後に必要なら「Hide UI」ボタンで再表示できます。

### ディレクトリ構成
- `webapp/index.html` – 画面レイアウトと UI。
- `webapp/viewer.html` – ヘッドトラッキング／タッチ対応モバイルビューア。
- `webapp/perf-harness.html` – RGBDE デコード、前処理、メッシュ生成、必要に応じてバックエンド往復時間を確認するための軽量なローカル計測ページ。
- `webapp/src/geometry.js` – RGBDE の展開、デプス前処理、メッシュ分割と投影ロジック。
- `webapp/src/rendering.js` – WebGL2 レンダラーとカメラ行列。
- `webapp/src/app.js` – UI イベントとインタラクション制御。
- `webapp/src/gltf-exporter.js` – *Save glTF* で使用する glTF (`.glb`) エクスポータ。
- `webapp/src/mobile-viewer.js` – モバイルシーン読込、タッチ表示 transform、カメラ追跡、off-axis 投影の接続。
- `webapp/src/mobile-depth-client.js` / `mobile-rgbde-worker.js` – 同一オリジン画像推論の通信と、transferable buffer を使う RGBDE メッシュ生成。
- `webapp/src/mobile-source-scene.js` / `mobile-window-placement.js` – 共通ソース契約と、均一スケールの実寸 True Window 配置。
- `webapp/src/mobile-relief.js` – 公開シーンを画面内・ガラス面より奥へ収める relief 生成。
- `webapp/src/mobile-levelling.js` / `mobile-chrome.js` – 端末姿勢の純粋な合成と、復旧可能なUI表示状態。
- `webapp/src/mobile-publish-mesh.js` – Publish時にだけ使うモバイル用グリッド／テクスチャ上限と、縮小フォールバックプロファイル。
- `webapp/src/device-metrics.js` – 端末ごとの画面実寸と、そこから導出する視距離ジオメトリ。
- `webapp/src/device-tilt.js` – Hold level が使うフィルタ済み重力ベクトルと、画面縦軸由来の重力傾斜を差し引くだけでyaw描画しない相対画面方位。純粋なlevelling境界が、保存した重力基準から縦／横画面の回転軸を導出します。
- `webapp/src/webxr.js` – VR / Looking Glass 向け WebXR セッション管理。

### サードパーティリソース
- **Apple Depth Pro** – `scripts/bootstrap.py` 実行時に `third_party/ml-depth-pro` として取得されます。利用には Apple のサンプルコードライセンス (`third_party/ml-depth-pro/LICENSE`) への同意が必要です。
- **Looking Glass WebXR Polyfill** – 実行時に CDN (`@lookingglass/webxr`) から読み込みます。このリポジトリには同梱していませんが、利用時は Looking Glass Factory のライセンス（パッケージの `LICENSE` 参照）に従ってください。
- **MediaPipe Tasks Vision / Face Landmarker** – モバイルビューアが固定バージョンの Tasks Vision 1.0.0 と float16 Face Landmarker v1 モデルを実行時に読み込みます。推論はブラウザ内で完結し、カメラ映像やランドマークはシーン relay へ送信されません。
- これら外部コンポーネントを成果物に含める場合は、各提供元のライセンス条件（再配布可否や同梱義務を含む）に従ってください。
