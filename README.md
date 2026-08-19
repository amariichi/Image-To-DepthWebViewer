# Image-to-Depth Web Viewer
![AppImage1](https://github.com/user-attachments/assets/92bbe04c-fc68-477a-be74-612d1e930189)![AppImage2](https://github.com/user-attachments/assets/241659fc-060d-49b3-9832-d0fd4689f8fc)

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

The desktop editor can publish its current baked scene to a separate, touch-friendly viewer for iPhone and iPad:

1. Open the editor at `http://localhost:5173/`, load or generate an RGBDE scene, finish the reconstruction/depth adjustments, and press **Publish to Mobile**.
2. On the phone or tablet, open the same frontend host with `/viewer.html` appended—for example, `https://your-frontend-address/viewer.html`. Camera access requires a secure context. `http://localhost` is allowed on the same device, but an ordinary `http://` LAN address generally is not; use an HTTPS reverse proxy or your existing trusted HTTPS mapping to port 5173.
3. Press **Start 3D**, hold the device steady while the centered pose calibrates, then move your head to look around the baked scene. **Recenter** repeats the short calibration without reloading the model. Landscape is recommended for the widest tracked-window effect. Current iPhone testing found that Safari and iOS Chrome need the same horizontal correction, so both now start in that direction. If a device still runs backwards, press **Flip L/R**; that choice is saved in the browser.
4. One-finger drag rotates within ±30°. A two-finger pinch scales the miniature uniformly, including its depth, until the relief would be thicker than a quarter of your measured viewing distance; beyond that the image keeps growing but depth stops, which is what prevents the crescent-shaped foreground distortion that unbounded depth growth produces. Moving two fingers together pans. Touch remains available when camera permission is denied or tracking is stopped.
5. Zooming in re-targets the depth budget at whatever you are looking at. Whatever is on screen is pulled forward onto the glass, and once the gesture settles the relief is rebuilt over just the visible depth range. This is what makes distant detail inspectable: in a room with a person at 1 m and balloons on a wall at 4 m, the balloons hold under one percent of the scene's depth budget and stay flat however far you zoom, but rebuilt over their own range they receive nearly half of it. Zooming back out restores the whole scene.

Front-camera frames and face landmarks are processed locally in the mobile browser and are never published to the PC relay. The viewer does not request gyroscope, DeviceOrientation, or DeviceMotion access. It downloads the pinned MediaPipe Tasks Vision runtime/model on first use, but does not upload camera data to that provider. Add `?debug=1` to the viewer URL to show the local camera preview, eye pose, render/inference cadence, camera resolution, first-pose latency, the resolved physical screen size and viewing geometry, and sliders for viewing distance, relief depth, and disparity blend.

The mobile projection is intentionally separate from the desktop, SBS, WebXR, and Looking Glass render paths. The published GLB already contains the desktop depth adjustments. On mobile, its baked depth becomes a bounded, screen-fitted relief: UVs define the image rectangle, the nearest sample is anchored to the glass plane, and all other samples stay behind it. This prevents very distant sky or background samples from shrinking the foreground into the tip of a large pyramid.

Source depth is mapped by disparity, meaning the relief position is proportional to `1 / distance` rather than to distance itself. Equal steps of `1 / distance` are equal steps of perceived depth, and they match the pinhole reconstruction the mesh came from. This is what keeps a near subject solid in a scene whose far field is thousands of times more distant: for a coastal portrait with a subject at 2 m and a horizon at 10 km, disparity gives the subject about 13% of the relief budget where a linear mapping would give it 0.003%. For a macro or microscope subject with almost no depth ratio the two mappings agree, so no separate mode is needed. Depth outliers are rejected at both ends of the range and flattened onto the near or far plane rather than dropped, so the mesh stays a closed sheet.

Triangles that straddle a depth discontinuity are deliberately kept. Where the source has no data behind an occluding edge, the stretched textured triangle is a more plausible reconstruction than a hole, so the mesh is never cut.

**Depth Magnification** controls the relief span at publish time; the default is `1.0` world units with a bounded range of `0.2`–`1.8`. One world unit is half the physical screen height, so the default places a miniature about half a screen height deep behind the glass — the thickness at which a typical near subject's relief is proportional to its size on screen, which is what makes it read as a solid object rather than a flat card.

The off-axis projection uses a cyclopean eye at the midpoint between the detected eyes. For eye distance `E`, a point `D` behind the glass projects as `x_screen = X × E / (E + D)`: a point on the glass stays fixed when the face approaches, while a farther point moves slightly toward the image center. The model stays square-on to the glass and never rotates toward the viewer; the vanishing point of depth-parallel lines already follows the eye, because that is what an off-axis frustum does. A normal phone or tablet cannot show a separate correct perspective to each physical eye, so close, strongly tilted, two-eye viewing cannot be fully binocular-correct. Viewing roughly square-on or briefly closing one eye gives the most geometrically consistent result.

At the calibrated pose the rendered image reproduces the source image exactly. Every vertex sits on the ray from the calibrated eye through its own image-plane anchor, so projecting from that eye returns each vertex to its original pixel regardless of how deep the relief is or how depth was mapped. Both the relief span and the disparity blend can therefore be changed freely without disturbing what you see before moving.

Head tracking is metric. MediaPipe's facial transformation matrix reports the head position in centimetres, and the viewer converts that into world units using the device's real screen size, so there is no tuned gain anywhere in the path. The virtual screen is two world units tall and fills the canvas, so one world unit is half the canvas's physical height. Because a browser cannot report physical size, `webapp/src/device-metrics.js` carries a small table (iPhone 17 and iPad mini A17 Pro) and falls back to a density estimate for unknown devices; a measured value stored in the browser always wins. Devices that do not supply the metric matrix fall back to the older landmark-ratio estimate and its gains (`0.325`, or `0.65` on iOS Chrome).

**Publish to Mobile** creates a memory-bounded mobile asset rather than sending the full desktop export. The texture is the dominant consumer, not the mesh: at a quarter-million vertices the geometry is a few megabytes, while a 2048-square texture is 16 MB once decoded. So the mobile profile ships the texture as JPEG rather than lossless PNG, limits it to 2048 pixels on either side and two million pixels total, and the viewer decodes it with `createImageBitmap` and releases the bitmap as soon as it reaches the GPU. The grid is resampled to at most 262,144 vertices with 32-bit indices, which WebGL2 draws without an extension, and normals the unlit mobile renderer never consumes are omitted. Normal **Save glTF** exports keep their original mesh, normals, 32-bit indices, and lossless PNG texture.

Publishing also uploads a smaller fallback build alongside the full one. No browser API on iOS reports available memory, so the viewer cannot predict whether a device will cope; instead it loads the full build and requests the reduced one only after that has genuinely failed, reporting `Scene ready (reduced build)` when it does.

The viewer does not request device orientation. Screen rotation cancels any active touch contacts, rebuilds the relief for the new aspect ratio, and requests recentering while preserving the accumulated touch pose.

Looking Glass framing is the display's own business rather than the model's: the polyfill frames a volume of `targetDiam` around `targetX/Y/Z` and renders it with `fovy`, so moving the model only shifts it inside a frame that is already fixed. Those five values can be set on the editor URL, for example `?lgTargetY=0.92&lgTargetDiam=0.9`, and the live values are reported when a session starts. The library looks at 1.6 above the floor by default, which leaves a model sitting near the origin low in frame, so the default here is 0; `targetZ` defaults to -0.575, measured on a Looking Glass Go. The height and size are scene-dependent — two pictures settled at 0.11 and 0.92, and at 2.00 and 0.90 — so they are yours to set rather than derived.

The port-5173 relay keeps only the latest published scene in memory. Restarting the frontend clears it; press **Publish to Mobile** again. Publishing a new scene replaces the current revision and open viewers pick it up automatically.

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

PC エディタで調整したシーンを、iPhone / iPad 向けのタッチ対応ビューアへ明示的に Publish できます。

1. PC で `http://localhost:5173/` を開き、RGBDE を読み込むか生成して、再構成・デプス調整を終えてから **Publish to Mobile** を押します。
2. スマホ／タブレットでは、同じフロントエンドホストの末尾に `/viewer.html` を付けて開きます（例: `https://your-frontend-address/viewer.html`）。カメラにはセキュアコンテキストが必要です。同じ端末上の `http://localhost` は例外ですが、通常の LAN 内 `http://` アドレスでは許可されないため、ポート 5173 に向けた HTTPS リバースプロキシまたは既存の信頼済み HTTPS マッピングを使用してください。
3. **Start 3D** を押し、正面姿勢の短いキャリブレーション中は端末を安定させます。その後、頭を動かすと焼き込み済みシーンの視点が変化します。**Recenter** はモデルを再読込せずにキャリブレーションだけをやり直します。今回の iPhone 実機確認では Safari と iOS Chrome に同じ左右補正が必要だったため、両方を同じ初期方向にしました。端末によってまだ逆なら **Flip L/R** を押してください。この選択はブラウザ内に保存されます。Tracked Window の効果を広く感じるには横画面がおすすめです。
4. 1本指ドラッグは ±30° 以内の回転です。2本指ピンチはミニチュア全体を奥行きも含めて等方拡大します。ただし relief の厚みが実測視距離の1/4を超える手前で奥行きの成長は止まり、以降は画像だけが拡大します。奥行きが視距離に対して無制限に増えることが、報告された手前側の三日月状の破綻の原因でした。2本指を一緒に動かす操作は平行移動です。カメラを拒否／停止してもタッチ操作は使えます。
5. ズームすると深度バジェットが「今見ているもの」に振り直されます。画面内の最近点がガラス面へ引き寄せられ、操作が落ち着いた時点で可視範囲の深度だけで relief を組み直します。奥のものを立体的に見るにはこれが必須です。手前に人物（1m）、奥の壁に風船（4m）という室内なら、風船自身の奥行きはシーン全体の深度バジェットの1%未満しかないため、いくらズームしても平らなままでした。可視範囲で組み直すと風船がバジェットのほぼ半分を受け取ります。ズームを戻せば全景に復帰します。

前面カメラ映像と顔ランドマークはモバイルブラウザ内だけで処理され、PC のシーン relay には送信されません。ジャイロ、DeviceOrientation、DeviceMotion の許可も要求しません。初回は固定バージョンの MediaPipe Tasks Vision とモデルをダウンロードしますが、カメラデータをその提供元へアップロードする処理はありません。URL に `?debug=1` を付けると、端末内カメラプレビュー、eye pose、描画／推論 cadence、実カメラ解像度、最初の pose までの時間に加えて、判定された画面実寸と視距離ジオメトリ、そして視距離・relief 厚・disparity blend の調整スライダが表示されます。

モバイル投影は Desktop / SBS / WebXR / Looking Glass の描画経路から分離されています。公開 GLB には PC 側のデプス調整がすでに焼き込まれています。モバイルではそのデプスを、画面内に収まる有限厚の relief に変換します。UV が画像枠を決め、最近点をガラス面に固定し、残りをすべて奥側に配置するため、空などの超遠景によって手前が四角錐の頂点のように小さくなることを防ぎます。ソース深度は disparity（`1 / 距離` に比例）でマッピングします。`1 / 距離` の等間隔が知覚される奥行きの等間隔であり、元のピンホール再構成とも整合するためです。これにより、遠景が数千倍遠いシーンでも手前の被写体が立体として残ります。被写体2m・水平線10kmの海岸ポートレイトの場合、disparity なら被写体が relief バジェットの約13%を得ますが、従来の線形マッピングでは0.003%しか得られませんでした。マクロや顕微鏡写真のように深度比が小さい被写体では両者はほぼ一致するので、モード切り替えは不要です。深度の外れ値は近側・遠側の両方で除外し、破棄せず近／遠平面に平坦化するため、メッシュは閉じたシートのまま保たれます。

深度が不連続な箇所をまたぐ三角形は意図的に残します。遮蔽の裏側にはデータが存在しないため、引き伸ばされたテクスチャ付き三角形のほうが穴よりも妥当な推定であり、メッシュを切ることはしません。

公開時の **Depth Magnification** が relief の厚みに反映されます。標準は `1.0` world unit、範囲は `0.2`〜`1.8` です。1 world unit は画面の物理高さの半分なので、標準ではガラスの奥に画面高さの約半分の厚みのミニチュアが置かれます。これは手前の被写体の凹凸が画面上の見かけの大きさに対して実物と同じ比率になる厚みで、板ではなく立体として見えるための条件です。

off-axis 投影は左右の目の中点にある仮想的な単眼（cyclopean eye）を使います。ガラスから眼までの距離を `E`、ガラスより奥の距離を `D` とすると、点は `x_screen = X × E / (E + D)` に投影されます。このため顔を近づけてもガラス面の点は不変で、遠い点だけが僅かに画像中央へ縮むのが本来の挙動です。モデルは常にガラス面に正対し、視点に向かって回転することはありません。奥行き方向に伸びる直線の消失点は off-axis 錐台の性質としてすでに眼の位置に追従します。通常のスマホ／タブレットは左右の物理的な目へ別々の正しい像を同時表示できないので、近距離・強い傾斜・両眼視を完全な立体として一致させることはできません。画面を概ね正対させるか、片目で確認すると幾何学的には最も整合します。

キャリブレーション姿勢では、描画結果は元画像と厳密に一致します。各頂点は「キャリブレーション眼からその頂点の画像面アンカーへ向かう光線」の上に置かれるため、その眼から投影すると relief の厚みや深度マッピングに関係なく元の画素位置へ戻ります。したがって relief 厚も disparity blend も、動く前に見える絵を乱すことなく自由に変更できます。

ヘッドトラッキングは実寸ベースです。MediaPipe の facial transformation matrix が頭部位置をセンチメートル単位で返すので、ビューアは端末の実画面サイズを使って world unit へ変換します。経路のどこにも調整ゲインはありません。仮想スクリーンは高さ 2 world unit でキャンバス全体に対応するため、1 world unit はキャンバスの物理高さの半分です。ブラウザは物理サイズを取得できないので、`webapp/src/device-metrics.js` が小さなテーブル（iPhone 17 / iPad mini A17 Pro）を持ち、未知の端末には密度からの推定値を使います。ブラウザに保存された実測値があれば常にそちらが優先されます。matrix を返さない端末では従来のランドマーク比推定とそのゲイン（`0.325`、iOS Chrome は `0.65`）にフォールバックします。

**Publish to Mobile** は Desktop 用の完全な glTF とは別に、メモリ上限を設けたモバイル専用データを作ります。支配的なのはメッシュではなくテクスチャです。25万頂点でもジオメトリは数MBですが、2048角のテクスチャは展開後16MBになります。そこでモバイルプロファイルはテクスチャを可逆PNGではなくJPEGで送り、一辺2048px以下・合計200万画素以下に制限し、ビューア側は `createImageBitmap` でデコードして GPU に載った時点で即座に解放します。グリッドは最大262,144頂点に再サンプリングし、WebGL2 が拡張なしで扱える32bit index を使い、モバイルの unlit 描画で使わない法線は省きます。通常の **Save glTF** は元のメッシュ、法線、32bit index、可逆PNGテクスチャの挙動を維持します。

Publish 時には縮小版のフォールバックも同時にアップロードします。iOS のブラウザには利用可能メモリを返す API が存在せず、端末が耐えられるかを事前に予測できないためです。ビューアはまず完全版を読み込み、それが実際に失敗した場合にだけ縮小版を要求し、その際は `Scene ready (reduced build)` と表示します。

DeviceOrientation は要求しません。画面回転時は進行中のタッチ接触を解除し、新しい縦横比に合わせて relief を組み直し、積み上げたタッチ姿勢を保ったまま Recenter を行います。

Looking Glass のフレーミングはモデル側ではなくディスプレイ側の管轄です。polyfill は `targetX/Y/Z` を中心に `targetDiam` の体積を `fovy` で切り取るため、モデルを動かしても既に固定されたフレームの中で動くだけです。この5つの値はエディタの URL で指定でき（例: `?lgTargetY=0.92&lgTargetDiam=0.9`）、セッション開始時に現在値が表示されます。ライブラリの既定は床から 1.6 の高さを見るため、原点付近に置かれたモデルは低く映ります。そのため既定値は 0 とし、`targetZ` は Looking Glass Go での実測値 −0.575 にしています。高さと大きさはシーン依存で（2枚の画像でそれぞれ 0.11 と 0.92、2.00 と 0.90）、導出せず利用者が指定します。

ポート 5173 の relay が保持するのは最新の1シーンだけで、メモリ内保存です。フロントエンドを再起動した場合は **Publish to Mobile** を再度押してください。別シーンを Publish すると revision が置き換わり、開いているモバイルビューアも自動更新します。

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
- `webapp/src/webxr.js` – VR / Looking Glass 向け WebXR セッション管理。

### サードパーティリソース
- **Apple Depth Pro** – `scripts/bootstrap.py` 実行時に `third_party/ml-depth-pro` として取得されます。利用には Apple のサンプルコードライセンス (`third_party/ml-depth-pro/LICENSE`) への同意が必要です。
- **Looking Glass WebXR Polyfill** – 実行時に CDN (`@lookingglass/webxr`) から読み込みます。このリポジトリには同梱していませんが、利用時は Looking Glass Factory のライセンス（パッケージの `LICENSE` 参照）に従ってください。
- **MediaPipe Tasks Vision / Face Landmarker** – モバイルビューアが固定バージョンの Tasks Vision 1.0.0 と float16 Face Landmarker v1 モデルを実行時に読み込みます。推論はブラウザ内で完結し、カメラ映像やランドマークはシーン relay へ送信されません。
- これら外部コンポーネントを成果物に含める場合は、各提供元のライセンス条件（再配布可否や同梱義務を含む）に従ってください。
