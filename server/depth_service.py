from __future__ import annotations

import asyncio
import io
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from shutil import copy2
from tempfile import TemporaryDirectory
from typing import Tuple

import numpy as np
from PIL import Image

# Ensure the Depth Pro submodule is importable before pulling in torch/depth_pro.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
SUBMODULE_PATH = PROJECT_ROOT / "third_party" / "ml-depth-pro"
if SUBMODULE_PATH.exists() and str(SUBMODULE_PATH) not in sys.path:
    sys.path.insert(0, str(SUBMODULE_PATH))

try:  # pragma: no cover - import guard for clearer error messaging
  import torch  # noqa: E402
except ImportError as exc:  # pragma: no cover
  raise RuntimeError(
    'PyTorch is required. Run scripts/bootstrap.py and install a torch build for your '
    'platform (e.g. `pip install torch --index-url https://download.pytorch.org/whl/cpu`).'
  ) from exc

try:  # pragma: no cover - import guard
  import depth_pro  # noqa: E402
except ImportError as exc:  # pragma: no cover
  raise RuntimeError(
    'depth_pro package not found. Ensure the ml-depth-pro sources are available '
    '(git submodule update --init --recursive or clone the repository into '
    'third_party/ml-depth-pro).'
  ) from exc

DepthProConfig = getattr(depth_pro, "DepthProConfig", None)

try:  # pragma: no cover - optional dependency installed with depth_pro
  from huggingface_hub import hf_hub_download
except ImportError:  # pragma: no cover
  hf_hub_download = None


@dataclass
class DepthResult:
    """Container for generated RGBDE payload."""

    png_bytes: bytes
    filename: str


class DepthProService:
    """Wraps Apple Depth Pro inference for RGBDE generation."""

    def __init__(self) -> None:
        device_name = os.environ.get("DEPTH_DEVICE")
        if device_name:
            self.device = torch.device(device_name)
        else:
            self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        checkpoint_path = ensure_checkpoint()
        if DepthProConfig is not None:
            try:
                config = DepthProConfig(checkpoint_uri=str(checkpoint_path))
                self.model, self.transform = depth_pro.create_model_and_transforms(config=config)
            except TypeError:
                self.model, self.transform = self._load_without_config(checkpoint_path)
        else:
            self.model, self.transform = self._load_without_config(checkpoint_path)
        self.model = self.model.to(self.device)
        self.model.eval()

    def _load_without_config(self, checkpoint_path: Path):
        original_cwd = Path.cwd()
        try:
            expected = PROJECT_ROOT / "checkpoints" / CHECKPOINT_FILENAME
            if expected != checkpoint_path:
                expected.parent.mkdir(parents=True, exist_ok=True)
                copy2(checkpoint_path, expected)
            os.chdir(PROJECT_ROOT)
            return depth_pro.create_model_and_transforms()
        finally:
            os.chdir(original_cwd)

    @property
    def device_label(self) -> str:
        return str(self.device)

    async def generate_rgbde(self, data: bytes, original_name: str) -> DepthResult:
        return await asyncio.to_thread(self._generate_rgbde_sync, data, original_name)

    def _generate_rgbde_sync(self, data: bytes, original_name: str) -> DepthResult:
        suffix = Path(original_name).suffix.lower()
        if suffix not in {".jpg", ".jpeg", ".png"}:
            raise ValueError("Only JPG and PNG inputs are supported.")

        with TemporaryDirectory(prefix="rgbde_") as temp_dir:
            input_path = Path(temp_dir) / f"source{suffix if suffix else '.png'}"
            input_path.write_bytes(data)

            image_data, _, focal_px = depth_pro.load_rgb(str(input_path))
            tensor = self.transform(image_data).unsqueeze(0).to(self.device)

            with torch.no_grad():
                prediction = self.model.infer(tensor, f_px=focal_px)

            depth = prediction["depth"].squeeze().cpu().numpy()
            depth = np.nan_to_num(depth, nan=0.0, posinf=0.0, neginf=0.0)
            depth = np.maximum(depth, 0.0)

            rgb_array = np.array(image_data, dtype=np.uint8)
            if rgb_array.ndim == 3 and rgb_array.shape[2] == 3:
                rgb_array = np.concatenate([rgb_array, np.full_like(rgb_array[..., :1], 255)], axis=2)
            elif rgb_array.ndim == 2:
                rgb_array = np.stack([rgb_array, rgb_array, rgb_array, np.full_like(rgb_array, 255)], axis=2)

            depth_rgb = self._encode_depth(depth)
            combined = np.concatenate([rgb_array, depth_rgb], axis=1)

            output = Image.fromarray(combined, mode="RGBA")
            buffer = io.BytesIO()
            output.save(buffer, format="PNG", compress_level=9)
            buffer.seek(0)

            output_name = f"{Path(original_name).stem}_RGBDE.png"
            return DepthResult(png_bytes=buffer.read(), filename=output_name)

    @staticmethod
    def _encode_depth(depth: np.ndarray) -> np.ndarray:
        scaled = np.round(depth * 10000.0).astype("<u4")
        rgba = scaled.view(np.uint8).reshape(depth.shape + (4,))
        return rgba


_service: DepthProService | None = None


def get_depth_service() -> DepthProService:
    global _service
    if _service is None:
        _service = DepthProService()
    return _service
CHECKPOINT_REPO = os.environ.get("DEPTH_PRO_REPO_ID", "apple/DepthPro")
CHECKPOINT_FILENAME = os.environ.get("DEPTH_PRO_CHECKPOINT_FILE", "depth_pro.pt")
CHECKPOINT_DIR = PROJECT_ROOT / "checkpoints"


def ensure_checkpoint() -> Path:
  """Download the Depth Pro checkpoint from Hugging Face if missing."""

  target = CHECKPOINT_DIR / CHECKPOINT_FILENAME
  if target.exists():
      return target

  CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)
  if hf_hub_download is None:
      raise RuntimeError(
          "huggingface_hub is required to fetch Depth Pro checkpoints. Ensure Depth Pro "
          "dependencies are installed."
      )

  print(":: Downloading Depth Pro checkpoint…")
  downloaded = hf_hub_download(
      repo_id=CHECKPOINT_REPO,
      filename=CHECKPOINT_FILENAME,
      local_dir=str(CHECKPOINT_DIR),
      local_dir_use_symlinks=False,
  )
  downloaded_path = Path(downloaded)
  if downloaded_path != target:
      copy2(downloaded_path, target)
  return target
