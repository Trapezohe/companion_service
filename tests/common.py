from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Mapping

ROOT = Path(__file__).resolve().parents[1]


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def read_json(relative_path: str):
    return json.loads(read(relative_path))


def assert_matches(testcase, text: str, pattern: str, flags: int = 0) -> None:
    if re.search(pattern, text, flags) is None:
        testcase.fail(f"pattern not found: {pattern}")


def assert_not_matches(testcase, text: str, pattern: str, flags: int = 0) -> None:
    if re.search(pattern, text, flags) is not None:
        testcase.fail(f"unexpected pattern found: {pattern}")


def run_bash(script: str, *, env: Mapping[str, str] | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    return subprocess.run(
        ["bash", "-lc", script],
        cwd=ROOT,
        env=merged_env,
        text=True,
        capture_output=True,
        check=check,
    )
