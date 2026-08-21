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

Publish the scene you are looking at to a phone or tablet, then use its front camera to move the viewpoint: the display behaves like a window onto a miniature sitting just behind the glass.

1. In the editor, load or generate an RGBDE scene, adjust it, and press **Publish to Mobile**.
2. On the phone or tablet, open the same host with `/viewer.html` appended. The camera needs a secure context, so `http://localhost` works on the same device but a plain `http://` LAN address usually does not — put an HTTPS proxy in front of port 5173.
3. Press **Start 3D** and hold still while it calibrates. iOS asks for camera and motion access; refusing motion costs only the levelling, and a **Level** button appears so you can grant it later.
4. Move your head to look around. **Recenter** re-calibrates without reloading. **Flip L/R** reverses the horizontal direction if a device reports its camera the other way round, and remembers the choice.

Touch works with or without the camera:

| Gesture | Effect |
| --- | --- |
| One finger | Rotate, within ±30° |
| Two fingers, pinch | Scale the miniature, depth included |
| Two fingers, move together | Pan |

Zooming in also re-aims the depth: whatever is on screen is brought forward onto the glass and the relief is rebuilt over just the depth range in view, so distant detail becomes inspectable instead of staying flat. Zooming back out restores the whole scene.

**Depth Magnification** in the editor sets how deep the published relief is, as a proportion of the picture's height on screen, so the same scene keeps its depth when you turn the device. Everything else adapts on the device: eye distance comes from a table of physical screen sizes, head position from MediaPipe's metric face pose, and the horizon stays level using gravity.

Camera frames and face landmarks never leave the phone. The viewer downloads the pinned MediaPipe runtime and model on first use and nothing else; no gyroscope is requested, and motion access is used only to keep the view upright.

**Publish to Mobile** sends a smaller asset than **Save glTF**: a JPEG texture capped at 2048 px and two megapixels, a resampled grid, and no normals. A reduced build is uploaded alongside it, and the viewer falls back to that only if the full one fails to load. The relay keeps one scene in memory; restarting the frontend clears it.

Add `?debug=1` to the viewer URL for live readings and sliders for viewing distance, relief depth and depth allocation. These can also be pinned on the URL:

| Parameter | Effect |
| --- | --- |
| `?flip=0` / `?flip=1` | Force the horizontal tracking direction |
| `?level=0` | Turn off keeping the view upright |
| `?levelFlip=1` | Reverse the levelling direction |
| `?delegate=cpu` / `gpu` | Force which processor runs the face model |

An ordinary panel shows both eyes the same image, so viewing square-on, or with one eye, is where the geometry is most convincing. Triangles stretched across a depth edge are kept on purpose: where the source has nothing behind an occluding edge, a smeared surface reads better than a hole.


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
- `webapp/src/mobile-relief.js` – screen-fitted, behind-glass relief generation for published scenes.
- `webapp/src/mobile-publish-mesh.js` – mobile-only grid and texture budgets used during publish, including the reduced fallback profile.
- `webapp/src/device-metrics.js` – physical screen size per device and the viewing geometry derived from it.
- `webapp/src/device-tilt.js` – gravity-referenced screen roll, used to keep the miniature upright as the device turns.
- `webapp/src/webxr.js` – WebXR and Looking Glass session lifecycle, including the module preload that keeps the entry click's user activation intact.
- `webapp/src/webxr.js` – WebXR session orchestration for VR and Looking Glass.

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

いま見ているシーンをスマホ／タブレットへ Publish し、前面カメラで視点を動かします。画面がガラス窓のようになり、その奥にミニチュアが置かれているように見えます。

1. エディタで RGBDE を読み込むか生成し、調整してから **Publish to Mobile** を押します。
2. スマホ／タブレットで同じホストの末尾に `/viewer.html` を付けて開きます。カメラにはセキュアコンテキストが必要なので、同一端末の `http://localhost` は使えますが、LAN 内の素の `http://` では通常使えません。ポート 5173 の前段に HTTPS プロキシを置いてください。
3. **Start 3D** を押し、キャリブレーション中は静止します。iOS はカメラとモーションの許可を求めます。モーションを拒否しても失われるのは水平維持だけで、あとから許可できるよう **Level** ボタンが現れます。
4. 頭を動かすと視点が変わります。**Recenter** は再読込せずにキャリブレーションをやり直します。**Flip L/R** は左右方向を反転し（端末がカメラ座標を逆に報告する場合）、選択は保存されます。

タッチ操作はカメラの有無にかかわらず使えます。

| 操作 | 効果 |
| --- | --- |
| 1本指 | ±30° 以内の回転 |
| 2本指ピンチ | ミニチュアを奥行きごと拡大縮小 |
| 2本指を一緒に動かす | 平行移動 |

ズームすると深度の割り当ても追従します。画面内のものが手前のガラス面へ引き寄せられ、可視範囲の深度だけで relief が組み直されるので、奥のものが平らなままにならず立体的に見られます。ズームを戻せば全景に復帰します。

エディタの **Depth Magnification** が公開時の relief の厚みを決めます。画面上の画像の高さに対する比率なので、端末を回しても奥行き感は変わりません。それ以外は端末側で自動調整されます ── 視距離は画面実寸のテーブルから、頭部位置は MediaPipe の実寸フェイスポーズから、水平は重力から求めます。

カメラ映像と顔ランドマークは端末外へ出ません。初回に固定バージョンの MediaPipe とモデルを取得するだけです。ジャイロは要求せず、モーション許可は水平維持にのみ使います。

**Publish to Mobile** は **Save glTF** より小さいデータを送ります（JPEG テクスチャ・一辺2048px かつ200万画素以下、再サンプリングしたグリッド、法線なし）。同時に縮小版もアップロードし、完全版の読み込みに失敗したときだけそちらへ切り替えます。relay が保持するのは1シーンのみで、フロントエンドを再起動すると消えます。

URL に `?debug=1` を付けると、実測値の表示と、視距離・relief 厚・深度配分のスライダーが出ます。以下は URL で固定できます。

| パラメータ | 効果 |
| --- | --- |
| `?flip=0` / `?flip=1` | 左右方向を強制 |
| `?level=0` | 水平維持を無効化 |
| `?levelFlip=1` | 水平維持の回転方向を反転 |
| `?delegate=cpu` / `gpu` | 顔モデルを実行するプロセッサを強制 |

通常のパネルは両眼に同じ像を出すため、**画面を正対させるか片目で見る**と幾何学的に最も整合します。深度が不連続な箇所で引き伸ばされる三角形は意図的に残しています。遮蔽の裏側にデータが無い以上、穴より引き伸ばされた面のほうが妥当な推定だからです。


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
- `webapp/src/mobile-relief.js` – 公開シーンを画面内・ガラス面より奥へ収める relief 生成。
- `webapp/src/mobile-publish-mesh.js` – Publish時にだけ使うモバイル用グリッド／テクスチャ上限と、縮小フォールバックプロファイル。
- `webapp/src/device-metrics.js` – 端末ごとの画面実寸と、そこから導出する視距離ジオメトリ。
- `webapp/src/device-tilt.js` – 重力基準の画面内ロール角。端末を傾けてもミニチュアを垂直に保つために使用。
- `webapp/src/webxr.js` – VR / Looking Glass 向け WebXR セッション管理。

### サードパーティリソース
- **Apple Depth Pro** – `scripts/bootstrap.py` 実行時に `third_party/ml-depth-pro` として取得されます。利用には Apple のサンプルコードライセンス (`third_party/ml-depth-pro/LICENSE`) への同意が必要です。
- **Looking Glass WebXR Polyfill** – 実行時に CDN (`@lookingglass/webxr`) から読み込みます。このリポジトリには同梱していませんが、利用時は Looking Glass Factory のライセンス（パッケージの `LICENSE` 参照）に従ってください。
- **MediaPipe Tasks Vision / Face Landmarker** – モバイルビューアが固定バージョンの Tasks Vision 1.0.0 と float16 Face Landmarker v1 モデルを実行時に読み込みます。推論はブラウザ内で完結し、カメラ映像やランドマークはシーン relay へ送信されません。
- これら外部コンポーネントを成果物に含める場合は、各提供元のライセンス条件（再配布可否や同梱義務を含む）に従ってください。
