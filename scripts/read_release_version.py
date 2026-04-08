#!/usr/bin/env python3

import json
import tomllib
from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    cargo = tomllib.loads(root.joinpath("Cargo.toml").read_text())
    tray_cargo = tomllib.loads(root.joinpath("tray/Cargo.toml").read_text())
    tauri = json.loads(root.joinpath("tray/tauri.conf.json").read_text())

    version = cargo["workspace"]["package"]["version"]
    tray_version = tray_cargo["package"]["version"]
    tauri_version = tauri["version"]

    if tray_version != version:
        raise SystemExit(
            f"Version mismatch: Cargo.toml={version} tray/Cargo.toml={tray_version}"
        )

    if tauri_version != version:
        raise SystemExit(
            f"Version mismatch: Cargo.toml={version} tray/tauri.conf.json={tauri_version}"
        )

    print(version)


if __name__ == "__main__":
    main()
