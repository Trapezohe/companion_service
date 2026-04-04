#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "${ROOT_DIR}/scripts/lib/macos-signing.sh"

VERSION="${1:-$(node -p "require('${ROOT_DIR}/package.json').version")}"
MODE="${2:---stage-only}"
STAGE_ROOT="${TRAPEZOHE_MACOS_STAGE_ROOT:-${ROOT_DIR}/dist/stage/macos-tray}"
ARCHIVE_ROOT="${ROOT_DIR}/dist/debug-artifacts"
BUILD_DIR="${ROOT_DIR}/tray/target/release"
APP_NAME="Trapezohe Companion.app"
APP_DIR="${STAGE_ROOT}/${APP_NAME}"
MACOS_DIR="${APP_DIR}/Contents/MacOS"
RESOURCES_DIR="${APP_DIR}/Contents/Resources"
COMPANION_DIR="${RESOURCES_DIR}/companion"
RUNTIME_NODE_DIR="${RESOURCES_DIR}/runtime/node"
BIN_NAME="trapezohe-companion-tray"
ZIP_PATH="${ARCHIVE_ROOT}/trapezohe-companion-tray-macos.zip"
NODE_BIN="${TRAPEZOHE_MACOS_NODE_BIN:-$(command -v node || true)}"

rm -rf "${APP_DIR}" "${ZIP_PATH}"
mkdir -p "${STAGE_ROOT}"
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}" "${COMPANION_DIR}/bin" "${COMPANION_DIR}/src" "${RUNTIME_NODE_DIR}/bin"

if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "Node.js executable not found for macOS app bundling." >&2
  exit 1
fi

cargo build --manifest-path "${ROOT_DIR}/tray/Cargo.toml" --release

cp "${BUILD_DIR}/${BIN_NAME}" "${MACOS_DIR}/${BIN_NAME}"
cp "${ROOT_DIR}/tray/icons/icon.png" "${RESOURCES_DIR}/icon.png"
cp "${ROOT_DIR}/bin/cli.mjs" "${COMPANION_DIR}/bin/cli.mjs"
cp "${ROOT_DIR}/bin/native-host.mjs" "${COMPANION_DIR}/bin/native-host.mjs"
cp "${ROOT_DIR}/package.json" "${COMPANION_DIR}/package.json"
while IFS= read -r -d '' source_file; do
  cp "${source_file}" "${COMPANION_DIR}/src/"
done < <(
  find "${ROOT_DIR}/src" -maxdepth 1 -type f -name '*.mjs' ! -name '*.test.mjs' -print0 | sort -z
)
cp "${NODE_BIN}" "${RUNTIME_NODE_DIR}/bin/node"
chmod 755 "${COMPANION_DIR}/bin/cli.mjs" "${COMPANION_DIR}/bin/native-host.mjs" "${RUNTIME_NODE_DIR}/bin/node"

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
