#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


INSTALLER_ASSETS = {
    "macos": "trapezohe-companion-macos.pkg",
    "windows": "trapezohe-companion-windows.msi",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the public installer download manifest.")
    parser.add_argument("--version", required=True)
    parser.add_argument("--sha256-file", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--fallback-root", required=True)
    parser.add_argument("--release-page", required=True)
    parser.add_argument("--primary-root", default="")
    return parser.parse_args()


def read_sha256_map(path: Path) -> dict[str, str]:
    digests: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 2:
            raise SystemExit(f"Invalid SHA256SUMS line: {raw_line!r}")
        digest, filename = parts[0], Path(parts[-1]).name
        digests[filename] = digest
    return digests


def build_asset_url(root: str, asset_name: str) -> str:
    normalized_root = root.rstrip("/")
    return f"{normalized_root}/{asset_name}"


def main() -> int:
    args = parse_args()
    sha256_map = read_sha256_map(Path(args.sha256_file))
    fallback_root = args.fallback_root.rstrip("/")
    primary_root = args.primary_root.rstrip("/")

    platforms: dict[str, dict[str, str]] = {}
    for platform, asset_name in INSTALLER_ASSETS.items():
        digest = sha256_map.get(asset_name)
        if not digest:
            raise SystemExit(f"Missing SHA256 for {asset_name} in {args.sha256_file}")

        fallback_url = build_asset_url(fallback_root, asset_name)
        primary_url = build_asset_url(primary_root, asset_name) if primary_root else fallback_url
        platforms[platform] = {
            "asset_name": asset_name,
            "primary_url": primary_url,
            "fallback_url": fallback_url,
            "sha256": digest,
        }

    manifest = {
        "manifest_version": 1,
        "version": args.version,
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "release_page_url": args.release_page,
        "platforms": platforms,
    }

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Built {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
