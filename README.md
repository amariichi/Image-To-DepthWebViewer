# Image-to-Depth Web Viewer
![AppImage1](https://github.com/user-attachments/assets/92bbe04c-fc68-477a-be74-612d1e930189)![AppImage2](https://github.com/user-attachments/assets/241659fc-060d-49b3-9832-d0fd4689f8fc)

Language / 言語: [English](#english) | [日本語](#日本語)

## English

### Overview
This repository now ships a two-part toolchain: a WebGL viewer in `webapp/` and a FastAPI backend in `server/`. Raw JPG/PNG images are uploaded through the UI, the backend runs Apple Depth Pro (pulled in as the `third_party/ml-depth-pro` submodule plus `depth-pro_rgbde.py`) to infer depth, and the resulting depth-augmented PNG (RGBDE PNG) streams straight back to the browser for preview and download. Precomputed RGBDE assets remain fully supported. From the viewer you can export the adjusted mesh and texture as a binary glTF (`.glb`) with an unlit material (`KHR_materials_unlit`) for DCC packages such as Blender. While inspecting the scene you can switch between linear/log depth, apply magnification (0.1×–100×), clamp the far plane (1–1000 m), and tune both reconstruction and display FOVs in real time.

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
   - Use **2D Image (JPEG or PNG) → Generate Depth** to run Depth Pro on a JPG/PNG; the backend never keeps files after responding.
   - Drop an existing RGBDE PNG anywhere in the window to load it instantly.
   - **Save RGBDE** downloads the in-memory PNG (generated or uploaded).
  - **Save glTF** exports the currently displayed mesh (including your slider tweaks) as a `.glb` with embedded texture and an unlit material (`KHR_materials_unlit`)—ready for Blender or any other tool that accepts glTF 2.0.
   - Choose **Display Mode** (2D or 3D SBS), tweak **Stereo Separation** (0–0.10 m) and optionally **Swap Left/Right** before donning glasses. Sliders cover reconstruction/display FOV, magnification, depth mode/log power, far crop (1–1000 m), and Model Z Offset (±5 m). Mouse wheel zooms (scale 0.05–25), left-drag rotates (±30° per axis), right-drag pans, double-click resets.
   - Running the backend elsewhere? Set `window.__RGBDE_API_BASE__ = 'http://host:port'` before loading, or adjust `API_BASE` in `webapp/src/app.js`.

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
- `webapp/perf-harness.html` – lightweight local benchmark page for RGBDE decode, preprocessing, mesh generation, and optional backend round-trip timing.
- `webapp/src/geometry.js` – RGBDE decoding, depth preprocessing, mesh density selection, and pinhole projection.
- `webapp/src/rendering.js` – WebGL2 renderer, shader setup, and camera math.
- `webapp/src/app.js` – event wiring, UI bindings, and interaction logic.
- `webapp/src/gltf-exporter.js` – binary glTF (`.glb`) writer used by the *Save glTF* workflow.
- `webapp/src/webxr.js` – WebXR session orchestration for VR and Looking Glass.

### Third-Party Resources
- **Apple Depth Pro** – Pulled via `scripts/bootstrap.py` into `third_party/ml-depth-pro`. Usage is governed by Apple’s sample code license (`third_party/ml-depth-pro/LICENSE`). Installers must agree to that license before running the backend.
- **Looking Glass WebXR Polyfill** – Loaded at runtime from the official CDN (`@lookingglass/webxr`). The package is not bundled with this repo; when used, it remains subject to Looking Glass Factory’s license terms (see the package’s `LICENSE` on npm).
- These components are external dependencies and are not redistributed here. If you plan to bundle them, ensure your distribution complies with each provider’s license terms (including any redistribution restrictions).


## 日本語

### 概要
本リポジトリは WebGL ビューア (`webapp/`) と Python/FastAPI バックエンド (`server/`) をセットで提供します。フロントエンドから JPG / PNG をアップロードすると、バックエンドが submodule で取り込んだ Apple Depth Pro（`third_party/ml-depth-pro` と `depth-pro_rgbde.py`）を実行し、右半分に little-endian の uint32 深度を埋め込んだデプス付き PNG（RGBDE PNG）を生成、即座にブラウザへ返します。既存の RGBDE PNG をドラッグ＆ドロップで読み込むこともできます。UI では線形／対数デプス、拡大率（0.1×〜100×）、最大距離クロップ（1〜1000 m）、再構成・表示 FOV を調整でき、調整済みメッシュとテクスチャをバイナリ glTF (`.glb`) として書き出して Blender などで再利用できます。

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
   - **2D Image (JPEG or PNG) → Generate Depth**: JPG/PNG をアップロードすると Depth Pro が実行され、生成した RGBDE が即表示されます（サーバー側の一時ファイルはレスポンス後に削除）。
   - **Save RGBDE**: 表示中の RGBDE をローカルにダウンロードします。
   - **Save glTF**: 現在のメッシュとテクスチャ（スライダー調整込み）を `.glb` としてエクスポートします。`KHR_materials_unlit` 拡張を使ったアンリットマテリアル付きで、glTF 2.0 対応の DCC やツールでそのまま利用できます。
   - 既存の RGBDE PNG はドラッグ＆ドロップでも読み込めます。
   - **Display Mode** で 2D / 3D (SBS) を切り替え、**Stereo Separation**（0〜0.10 m）や **Swap Left/Right** を必要に応じて設定してください。再構成／表示 FOV、Depth Magnification、Depth Mode + Log Power、Far Crop Distance（1〜1000 m）、Model Z Offset（±5 m）はスライダーで調整可能です。マウスホイールでズーム（0.05〜25）、左ドラッグで回転、右ドラッグで平行移動、ダブルクリックでリセットします。
   - バックエンドを別ホスト／別ポートで稼働させる場合は、ページ読込前に `window.__RGBDE_API_BASE__ = "http://host:port"` を設定するか、`webapp/src/app.js` の `API_BASE` を編集してください。

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
- `webapp/perf-harness.html` – RGBDE デコード、前処理、メッシュ生成、必要に応じてバックエンド往復時間を確認するための軽量なローカル計測ページ。
- `webapp/src/geometry.js` – RGBDE の展開、デプス前処理、メッシュ分割と投影ロジック。
- `webapp/src/rendering.js` – WebGL2 レンダラーとカメラ行列。
- `webapp/src/app.js` – UI イベントとインタラクション制御。
- `webapp/src/gltf-exporter.js` – *Save glTF* で使用する glTF (`.glb`) エクスポータ。
- `webapp/src/webxr.js` – VR / Looking Glass 向け WebXR セッション管理。

### サードパーティリソース
- **Apple Depth Pro** – `scripts/bootstrap.py` 実行時に `third_party/ml-depth-pro` として取得されます。利用には Apple のサンプルコードライセンス (`third_party/ml-depth-pro/LICENSE`) への同意が必要です。
- **Looking Glass WebXR Polyfill** – 実行時に CDN (`@lookingglass/webxr`) から読み込みます。このリポジトリには同梱していませんが、利用時は Looking Glass Factory のライセンス（パッケージの `LICENSE` 参照）に従ってください。
- これら外部コンポーネントを成果物に含める場合は、各提供元のライセンス条件（再配布可否や同梱義務を含む）に従ってください。
