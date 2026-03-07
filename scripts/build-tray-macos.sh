#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-$(node -p "require('${ROOT_DIR}/package.json').version")}"
STAGE_ONLY="${2:-}"
OUT_DIR="${ROOT_DIR}/dist/installers"
BUILD_DIR="${ROOT_DIR}/tray/target/release"
APP_NAME="Trapezohe Companion.app"
APP_DIR="${OUT_DIR}/${APP_NAME}"
MACOS_DIR="${APP_DIR}/Contents/MacOS"
RESOURCES_DIR="${APP_DIR}/Contents/Resources"
BIN_NAME="trapezohe-companion-tray"
ZIP_PATH="${OUT_DIR}/trapezohe-companion-tray-macos.zip"

rm -rf "${APP_DIR}" "${ZIP_PATH}"
mkdir -p "${OUT_DIR}"
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}"

cargo build --manifest-path "${ROOT_DIR}/tray/Cargo.toml" --release

cp "${BUILD_DIR}/${BIN_NAME}" "${MACOS_DIR}/${BIN_NAME}"
cp "${ROOT_DIR}/tray/icons/icon.png" "${RESOURCES_DIR}/icon.png"

cat > "${APP_DIR}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Trapezohe Companion</string>
  <key>CFBundleExecutable</key>
  <string>${BIN_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>ai.trapezohe.companion.tray</string>
  <key>CFBundleIconFile</key>
  <string>icon.png</string>
  <key>CFBundleName</key>
  <string>Trapezohe Companion</string>
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

if [[ "${STAGE_ONLY}" != "--stage-only" ]]; then
  COPYFILE_DISABLE=1 /usr/bin/ditto -c -k --norsrc --keepParent "${APP_DIR}" "${ZIP_PATH}"
  echo "Built ${ZIP_PATH}"
else
  echo "Staged ${APP_DIR}"
fi
