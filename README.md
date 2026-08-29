# Image-to-Depth Web Viewer
<img width="400" height="225" alt="Desktop editor" src="https://github.com/user-attachments/assets/92bbe04c-fc68-477a-be74-612d1e930189" /><img width="400" height="225" alt="Side-by-side stereo view" src="https://github.com/user-attachments/assets/241659fc-060d-49b3-9832-d0fd4689f8fc" />

Language / 言語: [English](#english) | [日本語](#日本語)

## English

### Overview
Turn one photograph into a scene you can look around. A FastAPI backend (`server/`) runs Apple Depth Pro over a JPEG or PNG, and a WebGL viewer (`webapp/`) rebuilds the result as a metric 3D mesh. On a phone, the front camera then tracks your head, so the screen behaves like a window onto that scene at life size.

Two front ends share the pipeline:

- **Desktop editor** (`webapp/index.html`) — generate depth and shape it live: linear or log depth, 0.1×–100× magnification, a 1–1000 m far clip, and separate reconstruction and display FOVs. Preview in 2D or side-by-side stereo, view it in a VR headset or on a Looking Glass display, and export the adjusted mesh and texture as binary glTF (`.glb`) with an unlit material (`KHR_materials_unlit`) for Blender and other DCC packages.
- **Mobile viewer** (`webapp/viewer.html`) — head-tracked and touch-first. Paste an image on the phone, or publish a scene from the editor.

Depth travels as an **RGBDE PNG**: one PNG carrying the source image in its left half and, in the right half, depth in metres × 10000 as a little-endian uint32 packed across the four RGBA bytes. Depth Pro's focal-length estimate goes into the file's metadata, so reopening a file restores the reconstruction FOV it was built with. Existing RGBDE files load by drag and drop. Depth Pro itself arrives as the `third_party/ml-depth-pro` submodule, driven by `depth-pro_rgbde.py`.

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

A scene pasted on the phone can also come back to the desktop. Depth inference runs on this machine either way, so the RGBDE for a phone-pasted image passes through this host on its way out, and a copy stays behind. **Open mobile image** in the editor opens that copy, putting the phone's scene into the full desktop pipeline — Depth Magnification, Geometry FOV, glTF export, VR, Looking Glass — without the phone uploading anything or spending data. It is a pull, not a push, so a scene you are working on in the editor is never replaced because someone picked up the phone. The button shows the file, lens, and time it is offering, and stays greyed out until the phone has generated something.

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

When the scene is ready, press **Start 3D** and hold still while face calibration completes. Start is deliberately a separate tap: a long Depth Pro request can outlive iOS user activation, so the viewer does not pretend it can ask for the camera by itself afterwards. Motion and orientation permission is requested from that same gesture where the platform requires it. Denying motion still leaves camera tracking usable, with **Hold level** off. **Stop camera** is in Details, and **Start 3D** restarts it later.

Turning the phone about the screen's vertical axis is always corrected, in both modes and with Hold on or off. A camera watching your face cannot tell a turned phone from a moved head, so without this the scene would swing with the phone instead of staying put in the room.

The primary controls have these meanings:

| Control | Effect |
| --- | --- |
| **Start 3D / Recenter** | Start the front-camera tracker, or take fresh face and gravity references without reloading the scene. |
| **Hold level** | Keep the scene roughly upright when you tilt the phone, measured against how you were holding it at Start/Recenter. It is a partial hold rather than a hard lock, so tilting still changes the view. True Window keeps a gentle pitch response even with this off, which is why tipping the top edge away still raises or lowers your eye level there; photo mode with it off is camera-only. Rotating between portrait and landscape re-captures the sensor references automatically, without asking for permission again. |
| **Reverse tracking** | On by default to correct the unmirrored front-camera horizontal axis. Turn it off only if left/right feels reversed on the device. The preference is remembered. |
| **True Window** | Switch between a physically fixed aperture and photo-aligned relief; see below. |
| **Setback** | In True Window, push the whole life-size miniature 0/25/50/100/200 mm further behind the glass. It moves the scene back; it does not stretch its depth. |
| **Paste image** | Read the current clipboard image. If clipboard access is unavailable or denied, keyboard paste and **Details → Choose image** remain available. |
| **Reset** | Reset touch rotation, pan, and scale without discarding the source or physical calibration. |
| **Details → Use size** | Enter the illuminated panel's longer side in millimetres, for a device the built-in table does not have or gets wrong. |
| **Details → Calibrate** | Correct the tracker's idea of how far away you are. Press **Start 3D** first and let the distance settle, enter your real eye-to-glass distance in millimetres (100 to 1500), then press it and hold still and centred while tracking recentres. The reading beside it stays at `scale 1.000×` until this has been done once, and the result is remembered across reloads. |
| **Hide UI** | Hide the normal controls. A clean double-tap on empty stage space hides or restores them; reload always starts visible. Build/FOV/error states reveal themselves so the page remains recoverable. |

#### True Window on — the metric window

The screen becomes a window. The glass, your eye, and the subject share one life-size space, so leaning to one side lets you see past a near edge and moving closer makes things bigger, the way a real window behaves.

You start from the pose where your eye sits exactly where the camera stood, so the screen shows the original photograph. From there the view changes by however much you move your head or the phone. Sideways movement is boosted slightly, because leaning past an edge is the motion people actually want; portrait and landscape are tuned to feel the same. Up/down and forward/back stay life-size, and coming very close is bounded so it stays comfortable.

Move far enough and you can see round the edges of what the photograph captured, including places it never recorded.

**Reset** and the first view pick a zoom that fits the whole photograph on screen; Details labels this `auto fit`. That view is deliberately wider than the real glass so you can see the entire frame. Pinch back to **1.00×** and the phone's glass is the window at true size.

**Setback** pushes the whole life-size miniature further behind the glass.

#### True Window off — photo-aligned relief

This mode also starts out looking exactly like the photograph, but compresses depth into a thickness that fits the screen. It stays comfortable when the real depth range of a photo is extreme, and it can redistribute that thickness across the region you have zoomed into. **Relief depth** and the related controls are in Details.

The two modes looking identical before you move is intentional; the difference appears once you do. Use on when you want a true-size window, off when you want a comfortable sense of depth.

Touch works with or without the camera:

| Gesture | Effect |
| --- | --- |
| One finger | Rotate, within ±30° |
| Two fingers, pinch | True Window: change window framing; photo mode: scale the relief |
| Two fingers, move together | Pan |

In photo mode, zooming also refits the visible depth range: content still on screen is brought toward the glass and given the available relief, while zooming back out restores the complete range. Published scenes initialize that relief from desktop **Depth Magnification**; direct-paste scenes start from the mobile default.

**Details** holds the two physical calibrations above, the source FOV/lens, published-scene reload, photo Relief controls, fallback viewing distance, runtime readings, and **Stop camera**. For a raw pasted image without EXIF, Depth Pro estimates the capture focal length and embeds it in the returned RGBDE, so no pre-inference millimetre entry is required. The resulting familiar **Lens (35 mm equivalent)** value can be edited from 10–800 mm and applied with **Rebuild depth**; typing alone does not start inference. The button is available only for a source pasted or chosen in this tab, because a published GLB carries no original photograph. A legacy RGBDE/GLB without any capture FOV opens a blocking but recoverable vertical-FOV prompt before metric geometry is built.

What is kept, and where:

- The pasted image and the returned RGBDE travel only to and from this application's own origin. The backend does not retain the upload after responding.
- The host serving these pages keeps the generated RGBDE in memory so the editor can open it. One slot, like a published scene and with the same lifetime: only a request the phone marked as its own fills it, the next generation replaces it, and because it lives in the serving process, reloading a page leaves it alone while stopping that process clears it.
- The active tab keeps one filename-free copy of the source image in browser memory, so **Rebuild depth** can re-run inference at a different lens. Generating from another source, loading a published scene, navigating away, or closing the tab releases it.
- Camera frames and face landmarks never leave the phone, and never appear in status text or logs.
- The pinned MediaPipe runtime and model need network access on first use. Later loads reuse the normal browser cache while it survives; clearing site data or an evicted cache means another download.

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
- The control panel has **Enter VR** and **Enter Looking Glass** buttons (requires a WebXR-enabled Chromium-based browser on HTTPS/localhost).
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
- `webapp/src/device-tilt.js` – filtered gravity input for Hold level, plus the relative screen heading used to correct phone turns.
- `webapp/src/webxr.js` – WebXR and Looking Glass session lifecycle, including the module preload that keeps the entry click's user activation intact.

### Third-Party Resources
- **Apple Depth Pro** – Pulled via `scripts/bootstrap.py` into `third_party/ml-depth-pro`. Usage is governed by Apple’s sample code license (`third_party/ml-depth-pro/LICENSE`). Installers must agree to that license before running the backend.
- **Looking Glass WebXR Polyfill** – Loaded at runtime from unpkg (`@lookingglass/webxr` v0.6.0). The package is not bundled with this repo; when used, it remains subject to Looking Glass Factory’s license terms (see the package’s `LICENSE` on npm).
- **MediaPipe Tasks Vision / Face Landmarker** – The mobile viewer loads pinned Tasks Vision 1.0.0 code and the float16 Face Landmarker v1 model at runtime. Inference stays in the browser; camera frames and landmarks are not sent to the scene relay.
- These components are external dependencies and are not redistributed here. If you plan to bundle them, ensure your distribution complies with each provider’s license terms (including any redistribution restrictions).


## 日本語

### 概要
1枚の写真を、覗き込める風景に変えます。バックエンド（`server/`、FastAPI）が JPEG / PNG に Apple Depth Pro をかけ、WebGL ビューア（`webapp/`）がその結果をメートル単位の3Dメッシュへ組み直します。スマホでは前面カメラが頭の位置を追うので、画面が実寸の風景を覗く窓のように振る舞います。

同じパイプラインを2つのフロントエンドが共有します。

- **デスクトップエディタ**（`webapp/index.html`）— デプスを生成し、その場で調整します。線形／対数デプス、拡大率 0.1×〜100×、最大距離クロップ 1〜1000 m、再構成側と表示側の FOV は別々に指定できます。2D／サイドバイサイド立体のプレビュー、VR ヘッドセットや Looking Glass での表示に対応し、調整済みメッシュとテクスチャはバイナリ glTF（`.glb`、`KHR_materials_unlit` のアンリットマテリアル付き）として書き出して Blender などで再利用できます。
- **モバイルビューア**（`webapp/viewer.html`）— ヘッドトラッキング対応、タッチ操作前提です。スマホで画像を貼り付けるか、エディタから公開します。

デプスは **RGBDE PNG** で受け渡します。1枚の PNG の左半分に元画像、右半分に「メートル×10000」の深度を little-endian の uint32 として RGBA の4バイトへ詰めた形式です。Depth Pro の推定焦点距離はメタデータに入るため、ファイルを開き直せば、そのとき使った再構成 FOV が復元されます。既存の RGBDE PNG はドラッグ＆ドロップで読み込めます。Depth Pro 本体は submodule（`third_party/ml-depth-pro`）として取得し、`depth-pro_rgbde.py` から呼び出します。

### 使い方
1. まず依存関係と Submodule をまとめてセットアップします。
   ```bash
   python scripts/bootstrap.py
   ```
   `pip` を更新して `.venv` を作成し、`requirements.txt`（Depth Pro との互換のため NumPy は `<2` に固定）と Depth Pro パッケージ（`pip install -e third_party/ml-depth-pro`）をインストールします。PyTorch、torchvision、timm など Depth Pro が必要とする依存もここで入ります。
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

スマホで貼り付けたシーンは、デスクトップ側へ戻すこともできます。デプス推定はどちらの経路でもこのマシンで走るので、スマホで貼った画像の RGBDE も出ていく途中でこの host を通り、その写しが手元に残ります。エディタの **Open mobile image** はその写しを開くもので、スマホのシーンをそのままデスクトップの経路（Depth Magnification、Geometry FOV、glTF 書き出し、VR、Looking Glass）に載せられます。**スマホからは何もアップロードせず、通信量も使いません。** push ではなく pull なので、エディタで作業中のシーンが、誰かがスマホを触ったせいで置き換わることもありません。ボタンには渡せるファイル名・レンズ・時刻が表示され、スマホがまだ何も生成していないあいだは押せません。

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

シーンの準備ができたら **Start 3D** を押し、顔の較正が終わるまで静止します。Start を別のタップにしているのは、Depth Pro の処理が長引くと iOS のユーザー操作権限が失効し、完了後に自動でカメラを要求しても拒否されるからです。モーションと向きの許可も、対応環境では同じ操作から要求します。モーションを拒否してもカメラ追跡は使え、その場合 **Hold level** はオフになります。**Stop camera** は Details にあり、あとから **Start 3D** で再開できます。

画面の縦軸まわりに端末を回した分は、モードにも Hold の状態にもよらず常に補正します。顔を見ているカメラには「端末が回った」のか「頭が動いた」のかの区別がつかないため、補正しないとシーンが端末と一緒に振れてしまい、部屋に対して静止しません。

主なボタンの意味は次のとおりです。

| ボタン | 効果 |
| --- | --- |
| **Start 3D / Recenter** | 前面カメラ追跡を開始します。動作中に押すと、シーンを再読込せずに顔と重力の基準だけを取り直します。 |
| **Hold level** | 端末を傾けたとき、Start／Recenter 時の持ち方を基準にシーンの水平をおおむね保ちます。完全な固定ではなく部分的な維持なので、傾けた分の反応は残ります。True Window はこれをオフにしても弱い仰角の反応を残すため、上端を奥へ倒せば見下ろし／見上げが変わります。写真モードでオフにすると、カメラ追跡だけで動きます。縦画面と横画面を切り替えたときは、許可を取り直さずにセンサー基準を自動で取り直します。 |
| **Reverse tracking** | 前面カメラの非ミラー座標を補正するため、デフォルトでオンです。端末上で左右が逆に感じる場合だけオフにします。設定は保存されます。 |
| **True Window** | 実寸の固定窓と、元写真を再現する relief を切り替えます。下記参照。 |
| **Setback** | True Window で、実寸のミニチュア全体をガラスの奥へ 0/25/50/100/200 mm 下げます。奥に動かすだけで、奥行きを伸ばすものではありません。 |
| **Paste image** | クリップボードの画像を読みます。許可されない場合も、キーボード貼り付けと **Details → Choose image** が使えます。 |
| **Reset** | 元画像や物理較正を捨てず、タッチ回転・移動・倍率だけを初期化します。 |
| **Details → Use size** | 内蔵の端末表に無い、または値が合わない機種で、発光パネルの長辺をミリメートルで入力します。 |
| **Details → Calibrate** | 追跡側が持っている「あなたまでの距離」を補正します。先に **Start 3D** を押して距離が落ち着くのを待ち、実際の目からガラスまでの距離をミリメートル（100〜1500）で入れて押し、再センタリングのあいだは中央で静止します。隣の表示は一度も較正していないあいだ `scale 1.000×` のままで、結果は再読込後も保存されます。 |
| **Hide UI** | 通常UIを消します。何もない表示領域を正しくダブルタップすると非表示／再表示できます。再読込時は必ず表示から始まり、生成・FOV・エラーは自動で現れるため復旧不能になりません。 |

#### True Window on — 実寸の窓

画面を窓として扱うモードです。ガラス面・あなたの目・被写体が実寸の同じ空間にあるので、体を横にずらせば手前のものの向こう側が見え、近づけば大きく見えます。実際の窓と同じ振る舞いです。

最初は、撮影したカメラのあった位置にちょうどあなたの目が来る状態から始まります。そのため画面は元の写真そのもので、そこから頭や端末を動かした分だけ視点が変わります。左右方向は、端から奥を覗き込む動きが実際に使われるため、やや強めにしてあります（縦持ちと横持ちで体感が揃うよう調整済みです）。上下と前後は実寸どおりで、近づきすぎは快適さのため制限されます。

大きく動かせば、写真に写っている範囲の外側、つまり元画像が記録していない面が見えることもあります。

**Reset** と初期表示では、写真全体が画面に収まる倍率を自動で選びます（Details に `auto fit` と表示）。この表示は全体を見渡すためのもので、意図的に実物のガラスより広くなっています。ピンチで **1.00×** まで戻すと、端末のガラスがそのまま実寸の窓になります。

**Setback** は、実寸のミニチュア全体をガラスの奥へ下げる操作です。

#### True Window off — 写真基準の relief

こちらも最初は元の写真どおりに見えますが、奥行きを画面に収まる厚みへ圧縮します。奥行きの幅が極端な写真でも見やすく、ズームした範囲に合わせて厚みを配り直せます。**Relief depth** と関連する設定は Details にあります。

動かす前に両モードがそっくりなのは意図どおりで、違いは動かしてから出ます。実寸の窓が欲しいときは on、扱いやすい立体感が欲しいときは off です。

タッチ操作はカメラの有無にかかわらず使えます。

| 操作 | 効果 |
| --- | --- |
| 1本指 | ±30° 以内の回転 |
| 2本指ピンチ | True Windowでは窓の表示範囲、写真モードではrelief倍率を変更 |
| 2本指を一緒に動かす | 平行移動 |

写真モードでズームすると可視範囲の深度も再割当され、画面内のものがガラス側へ寄り、利用可能な relief を使います。ズームを戻すと全体の深度範囲へ復帰します。公開シーンはデスクトップの **Depth Magnification** から初期値を受け取り、直接貼り付けたシーンはモバイル既定値から始まります。

**Details** には、上の2つの物理較正のほか、ソースFOV／撮影レンズ、公開シーンの再読込、写真 Relief、予備の視距離、実行時測定値、**Stop camera** があります。EXIFのない通常画像を貼り付けた場合はDepth Proが撮影焦点距離を推定して返却RGBDEへ埋め込むため、推論前のmm入力は必須ではありません。表示された **Lens (35 mm equivalent)** は10〜800mmの範囲で編集でき、**Rebuild depth** を押したときだけ再推論します。入力中に勝手に推論は始まりません。このボタンは同じタブで貼り付け／選択した元画像にだけ使え、公開GLBには元写真がないため無効です。撮影FOVを一切持たない古い RGBDE/GLB は、実寸メッシュを作る前に復旧可能な垂直FOV確認画面を出します。

どこに何が残るか:

- 貼り付けた画像と返却された RGBDE が行き来するのは、このアプリの同一オリジンだけです。バックエンドは応答後にアップロードを保持しません。
- ページを配信している host は、エディタから開けるように生成された RGBDE をメモリに保持します。公開シーンと同じ1枠方式・同じ寿命で、入るのはスマホが自分のものとして印を付けたリクエストの結果だけ、次の生成が来れば置き換わります。配信プロセスの中にあるので、ページを再読込しても残り、そのプロセスを停止すると消えます。
- 現在のタブは、**Rebuild depth** で別のレンズ値から推論し直せるように、ファイル名を持たない元画像のコピーを1つだけブラウザメモリに保持します。別の元画像での生成成功、公開シーンの読込、ページ移動、タブを閉じるのいずれかで解放されます。
- カメラ映像と顔ランドマークは端末の外に出ず、ステータス表示にもログにも入りません。
- 固定版の MediaPipe ランタイムとモデルは、初回だけネットワークを使います。以後は通常のブラウザキャッシュが残っているあいだ再利用され、サイトデータの消去やキャッシュ退避のあとは再取得になります。

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
- コントロールパネルに **Enter VR** / **Enter Looking Glass** ボタンがあります（WebXR 対応の Chromium 系ブラウザ + HTTPS/localhost が必要）。
- **PC 接続型 OpenXR ヘッドセット**（Meta Quest + Link、Valve Index、HTC Vive、Varjo、HP Reverb G2 など）: 各ベンダーの OpenXR ランタイム（Quest Link、SteamVR、Windows Mixed Reality、Varjo Base など）を起動し、PC の Chrome / Edge でビューアを開いて *Enter VR* を押すと没入セッションが開始します。終了すると通常表示に戻ります。
- **Looking Glass displays**: Looking Glass Bridge を起動しディスプレイを接続してから *Enter Looking Glass* を押すと、公式 `@lookingglass/webxr` v0.6.0 polyfill を動的に読み込み、多視点キルト描画に切り替わります。Bridge を常時起動しておいてください。多視点キルトにより表示側で広い角度が補間されるため、XR中はモデルを自由に回しているように見えます（マウス操作の回転制限自体は ±30° のままです）。
- **VR コントローラー操作**: 左コントローラーでマウス操作に相当するインタラクションが行えます。トリガー＋左右／上下で回転、グリップ＋移動で平行移動、トリガー＋前後でズーム、スティック左右で再構成 FOV、スティック上下で Depth Magnification、X ボタンで Far Clip を短く、Y ボタンで Far Clip を大きくできます。コントローラー自体は描画されませんが、入力は反映されます。ビューが崩れた場合はキャンバスをダブルクリックで初期状態に戻せます。
- **ヒント表示**: VR セッション開始時に操作チートシートが表示され、その後は操作に応じて 1 行のヒントがポップアップします。不要な場合は *Enter VR* の横にある *Show XR hints* のチェックを外すと非表示にでき、必要になったら再度チェックを入れて表示を戻せます。
- **Looking Glass と VR の切り替え**: Looking Glass の WebXR ポリフィルは `navigator.xr` を差し替えたまま復元しないため、Looking Glass を Exit した直後に *Enter VR* を押すとブラウザがセッションを拒否して「VR session blocked: click Enter VR again」と表示されます。現状はページをリロード（例: `Ctrl+F5`）した後に VR を開始してください。
- WebXR API は HTTPS などのセキュアオリジンでのみ利用可能です。Quest ブラウザでは自己署名証明書は使えないため、本番では正規証明書を用意してください。ローカル開発での `http://localhost` アクセスはブラウザが例外的にセキュア扱いにするため、そのまま動作します。
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
- `webapp/src/device-tilt.js` – Hold level が使うフィルタ済み重力ベクトルと、端末の左右の向きを補正する相対画面方位。
- `webapp/src/webxr.js` – VR / Looking Glass 向け WebXR セッション管理。

### サードパーティリソース
- **Apple Depth Pro** – `scripts/bootstrap.py` 実行時に `third_party/ml-depth-pro` として取得されます。利用には Apple のサンプルコードライセンス (`third_party/ml-depth-pro/LICENSE`) への同意が必要です。
- **Looking Glass WebXR Polyfill** – 実行時に unpkg (`@lookingglass/webxr` v0.6.0) から読み込みます。このリポジトリには同梱していませんが、利用時は Looking Glass Factory のライセンス（パッケージの `LICENSE` 参照）に従ってください。
- **MediaPipe Tasks Vision / Face Landmarker** – モバイルビューアが固定バージョンの Tasks Vision 1.0.0 と float16 Face Landmarker v1 モデルを実行時に読み込みます。推論はブラウザ内で完結し、カメラ映像やランドマークはシーン relay へ送信されません。
- これら外部コンポーネントを成果物に含める場合は、各提供元のライセンス条件（再配布可否や同梱義務を含む）に従ってください。
