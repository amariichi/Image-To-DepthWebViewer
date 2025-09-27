#!/usr/bin/env python3
"""Launch the FastAPI backend using the project's virtual environment."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
VENV_DIR = PROJECT_ROOT / ".venv"


def venv_python() -> Path:
    candidate = VENV_DIR / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not candidate.exists():
        raise RuntimeError("Virtual environment not found. Run scripts/bootstrap.py first.")
    return candidate


def main() -> None:
    python_bin = venv_python()
    cmd = [str(python_bin), "-m", "uvicorn", "server.main:app", "--host", os.environ.get("RGBDE_BACKEND_HOST", "0.0.0.0"), "--port", os.environ.get("RGBDE_BACKEND_PORT", "8000"), "--reload"]
    print("::", " ".join(cmd))
    subprocess.check_call(cmd, cwd=str(PROJECT_ROOT))


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        sys.exit(exc.returncode)
