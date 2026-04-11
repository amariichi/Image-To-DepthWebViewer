#!/usr/bin/env python3
"""Generate deterministic local assets for performance benchmarking."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "webapp" / "test-assets"


def build_source_rgba(width: int, height: int) -> np.ndarray:
    xs = np.linspace(0.0, 1.0, width, dtype=np.float32)
    ys = np.linspace(0.0, 1.0, height, dtype=np.float32)
    xv, yv = np.meshgrid(xs, ys)

    red = np.clip((0.2 + 0.8 * xv) * 255.0, 0, 255).astype(np.uint8)
    green = np.clip((0.1 + 0.9 * yv) * 255.0, 0, 255).astype(np.uint8)
    blue_wave = 0.5 + 0.25 * np.sin(xv * np.pi * 6.0) + 0.25 * np.cos(yv * np.pi * 5.0)
    blue = np.clip(blue_wave * 255.0, 0, 255).astype(np.uint8)

    center_x = xv - 0.5
    center_y = yv - 0.5
    radius = np.sqrt(center_x * center_x + center_y * center_y)
    vignette = np.clip(1.1 - radius * 1.4, 0.45, 1.0)

    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    rgba[..., 0] = np.clip(red * vignette, 0, 255).astype(np.uint8)
    rgba[..., 1] = np.clip(green * vignette, 0, 255).astype(np.uint8)
    rgba[..., 2] = np.clip(blue * vignette, 0, 255).astype(np.uint8)
    rgba[..., 3] = 255
    return rgba


def build_depth(width: int, height: int) -> np.ndarray:
    xs = np.linspace(0.0, 1.0, width, dtype=np.float32)
    ys = np.linspace(0.0, 1.0, height, dtype=np.float32)
    xv, yv = np.meshgrid(xs, ys)

    radial = np.sqrt((xv - 0.5) ** 2 + (yv - 0.5) ** 2)
    ridge = 0.25 * np.sin(xv * np.pi * 7.0) + 0.15 * np.cos(yv * np.pi * 5.0)
    gradient = 0.8 + 4.2 * yv
    depth = gradient + ridge + radial * 1.4
    depth = np.clip(depth, 0.2, None)
    return depth.astype(np.float32)


def encode_depth(depth: np.ndarray) -> np.ndarray:
    scaled = np.round(depth * 10000.0).astype("<u4")
    return scaled.view(np.uint8).reshape(depth.shape + (4,))


def write_fixture(name: str, width: int, height: int) -> None:
    rgba = build_source_rgba(width, height)
    depth = build_depth(width, height)
    combined = np.concatenate([rgba, encode_depth(depth)], axis=1)
    Image.fromarray(combined, mode="RGBA").save(ASSET_DIR / name)


def write_source_fixture(name: str, width: int, height: int) -> None:
    rgba = build_source_rgba(width, height)
    Image.fromarray(rgba, mode="RGBA").save(ASSET_DIR / name)


def main() -> None:
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    write_source_fixture("source-gradient.png", 768, 512)
    write_fixture("rgbde-small.png", 160, 120)
    write_fixture("rgbde-large.png", 1280, 720)
    print(f"Wrote fixtures to {ASSET_DIR}")


if __name__ == "__main__":
    main()
