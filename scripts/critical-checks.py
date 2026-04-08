#!/usr/bin/env python3
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def resolve_cargo() -> str:
    env_cargo = os.environ.get("CARGO")
    if env_cargo:
        return env_cargo

    cargo_name = "cargo.exe" if os.name == "nt" else "cargo"
    bundled = Path.home() / ".cargo" / "bin" / cargo_name
    if bundled.exists():
        return str(bundled)

    found = shutil.which(cargo_name)
    if found:
        return found

    return cargo_name


def run_step(command: list[str]) -> None:
    subprocess.run(command, cwd=ROOT, check=True)


if __name__ == "__main__":
    cargo = resolve_cargo()
    run_step([cargo, "test", "--manifest-path", "Cargo.toml", "-p", "companion-cli", "--locked"])
    run_step([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "*_test.py"])
