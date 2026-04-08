#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "${ROOT_DIR}/scripts/lib/macos-signing.sh"

VERSION="${1:-$(ROOT_DIR_ENV="${ROOT_DIR}" python3 - <<'PY'
import tomllib
import os
from pathlib import Path

root = Path(os.environ["ROOT_DIR_ENV"])
data = tomllib.loads(root.joinpath("Cargo.toml").read_text())
print(data["workspace"]["package"]["version"])
PY
)}"
MODE="${2:---stage-only}"
STAGE_ROOT="${TRAPEZOHE_MACOS_STAGE_ROOT:-${ROOT_DIR}/dist/stage/macos-tray/${VERSION}}"
ARCHIVE_ROOT="${ROOT_DIR}/dist/debug-artifacts"
BUILD_DIR="${ROOT_DIR}/target/release"
CLI_BUILD_DIR="${ROOT_DIR}/target/release"
UI_DIR="${ROOT_DIR}/tray/ui-react"
APP_NAME="GhastAI Companion.app"
APP_DIR="${STAGE_ROOT}/${APP_NAME}"
MACOS_DIR="${APP_DIR}/Contents/MacOS"
RESOURCES_DIR="${APP_DIR}/Contents/Resources"
COMPANION_DIR="${RESOURCES_DIR}/companion"
BIN_NAME="trapezohe-companion-tray"
ZIP_PATH="${ARCHIVE_ROOT}/trapezohe-companion-tray-macos.zip"
NPM_BIN="${TRAPEZOHE_MACOS_NPM_BIN:-$(command -v npm || true)}"
CARGO_BIN="${CARGO:-$(command -v cargo || true)}"

if [[ -z "${CARGO_BIN}" && -x "${HOME}/.cargo/bin/cargo" ]]; then
  CARGO_BIN="${HOME}/.cargo/bin/cargo"
fi

rm -rf "${APP_DIR}" "${ZIP_PATH}"
mkdir -p "${STAGE_ROOT}"
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}" "${COMPANION_DIR}/bin"

if [[ -z "${NPM_BIN}" || ! -x "${NPM_BIN}" ]]; then
  echo "npm executable not found for macOS app bundling." >&2
  exit 1
fi

if [[ -z "${CARGO_BIN}" || ! -x "${CARGO_BIN}" ]]; then
  echo "cargo executable not found for macOS app bundling." >&2
  exit 1
fi

"${NPM_BIN}" --prefix "${UI_DIR}" run build

"${CARGO_BIN}" build --manifest-path "${ROOT_DIR}/tray/Cargo.toml" --release --features custom-protocol
"${CARGO_BIN}" build --manifest-path "${ROOT_DIR}/Cargo.toml" -p companion-cli --release

cp "${BUILD_DIR}/${BIN_NAME}" "${MACOS_DIR}/${BIN_NAME}"
cp "${ROOT_DIR}/tray/icons/icon.png" "${RESOURCES_DIR}/icon.png"
cp "${CLI_BUILD_DIR}/trapezohe-companion" "${COMPANION_DIR}/bin/trapezohe-companion"
chmod 755 \
  "${COMPANION_DIR}/bin/trapezohe-companion"

macos_sign_binary "${COMPANION_DIR}/bin/trapezohe-companion"

cat > "${APP_DIR}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>GhastAI Companion</string>
  <key>CFBundleExecutable</key>
  <string>${BIN_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>ai.trapezohe.companion.tray</string>
  <key>CFBundleIconFile</key>
  <string>icon.png</string>
  <key>CFBundleName</key>
  <string>GhastAI Companion</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

/usr/bin/xattr -cr "${APP_DIR}" 2>/dev/null || true
macos_sign_app_bundle "${APP_DIR}"

case "${MODE}" in
  --stage-only)
    echo "Staged ${APP_DIR}"
    ;;
  --archive)
    mkdir -p "${ARCHIVE_ROOT}"
    COPYFILE_DISABLE=1 /usr/bin/ditto -c -k --norsrc --keepParent "${APP_DIR}" "${ZIP_PATH}"
    echo "Built ${ZIP_PATH}"
    ;;
  *)
    echo "Unsupported mode: ${MODE}" >&2
    exit 1
    ;;
esac
