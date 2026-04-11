This directory contains deterministic local assets for the in-repo performance harness.

Generate or refresh the fixtures from the repository root with:

    .venv/bin/python scripts/generate_perf_fixtures.py

The files created by that script are:

- `source-gradient.png` for backend round-trip timing.
- `rgbde-small.png` for a fast frontend smoke benchmark.
- `rgbde-large.png` for a heavier frontend benchmark.
