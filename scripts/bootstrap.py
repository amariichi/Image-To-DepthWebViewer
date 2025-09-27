#!/usr/bin/env python3
"""Convenience bootstrap script for setting up the RGBDE workspace."""

from __future__ import annotations

import os
import subprocess
import sys
import venv
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
VENV_DIR = PROJECT_ROOT / ".venv"
DEPTH_PRO_DIR = PROJECT_ROOT / "third_party" / "ml-depth-pro"


def run(cmd: list[str], *, cwd: Path | None = None) -> None:
    print("::", " ".join(cmd))
    subprocess.check_call(cmd, cwd=str(cwd) if cwd else None)


def ensure_submodules() -> None:
    if (DEPTH_PRO_DIR / "README.md").exists():
        print(":: Depth Pro sources already present")
        return

    print(":: Initialising git submodules (Depth Pro)…")
    try:
        run(["git", "submodule", "update", "--init", "--recursive"], cwd=PROJECT_ROOT)
    except subprocess.CalledProcessError as exc:
        print(":: Submodule update failed (", exc, ")")

    if (DEPTH_PRO_DIR / "README.md").exists():
        print(":: Depth Pro submodule checked out")
        return

    print(":: Submodule checkout missing; cloning Depth Pro repository directly…")
    run([
        "git",
        "clone",
        "https://github.com/apple/ml-depth-pro.git",
        str(DEPTH_PRO_DIR),
    ])

    if not (DEPTH_PRO_DIR / "README.md").exists():
        raise RuntimeError(
            "Depth Pro sources could not be obtained. Check your network access and rerun"
        )


def ensure_venv() -> Path:
    if not VENV_DIR.exists():
        print(":: Creating virtual environment at", VENV_DIR)
        venv.create(VENV_DIR, with_pip=True)
    else:
        print(":: Reusing virtual environment at", VENV_DIR)

    python_path = VENV_DIR / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python_path.exists():
        raise RuntimeError("Virtual environment python binary not found")
    run([str(python_path), "-m", "pip", "install", "--upgrade", "pip"])
    run([str(python_path), "-m", "pip", "install", "-r", "requirements.txt"], cwd=PROJECT_ROOT)

    depth_requirements = DEPTH_PRO_DIR / "requirements.txt"
    if depth_requirements.exists():
        run([str(python_path), "-m", "pip", "install", "-r", str(depth_requirements)])
    else:
        print(":: Depth Pro requirements file not found; skipping optional install")

    print(":: Installing Depth Pro package (editable)")
    run([str(python_path), "-m", "pip", "install", "-e", str(DEPTH_PRO_DIR)])

    return python_path


def main() -> None:
    ensure_submodules()
    python_path = ensure_venv()
    print(":: Setup complete. Next steps:\n")
    if os.name == "nt":
        activate = VENV_DIR / "Scripts" / "activate"
    else:
        activate = VENV_DIR / "bin" / "activate"
    print(f"    1. source {activate}")
    print("    2. python scripts/run.py    # launches backend + frontend together")
    print("       # or start them separately if you prefer:")
    print(f"       {python_path} -m uvicorn server.main:app --host 0.0.0.0 --port 8000")
    print("       python scripts/run_frontend.py")
    print("\n:: If you need a specific CUDA/PyTorch build, install it manually after this script.")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        sys.exit(exc.returncode)
