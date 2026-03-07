#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-$(node -p "JSON.parse(require('fs').readFileSync('${ROOT_DIR}/package.json','utf8')).version")}"
OUT_DIR="${ROOT_DIR}/dist/installers"
WORK_DIR="$(mktemp -d)"
PKG_ROOT="${WORK_DIR}/root"
PKG_SCRIPTS="${WORK_DIR}/scripts"
PAYLOAD_DIR="${PKG_ROOT}/usr/local/lib/trapezohe-companion-installer"
APPLICATIONS_DIR="${PKG_ROOT}/Applications"
PACKAGE_FILE="${OUT_DIR}/trapezohe-companion-macos.pkg"
TRAY_APP_NAME="Trapezohe Companion.app"
TRAY_APP_PATH="${OUT_DIR}/${TRAY_APP_NAME}"

cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

mkdir -p "${PAYLOAD_DIR}" "${PKG_SCRIPTS}" "${OUT_DIR}" "${APPLICATIONS_DIR}"

"${ROOT_DIR}/scripts/build-tray-macos.sh" "${VERSION}" --stage-only

cp "${ROOT_DIR}/README.md" "${PAYLOAD_DIR}/README.md"
cp "${ROOT_DIR}/packaging/macos/postinstall" "${PKG_SCRIPTS}/postinstall"
chmod +x "${PKG_SCRIPTS}/postinstall"
sed -i '' "s/__COMPANION_VERSION__/${VERSION}/g" "${PKG_SCRIPTS}/postinstall"
if [[ ! -d "${TRAY_APP_PATH}" ]]; then
  echo "Tray app bundle not found at ${TRAY_APP_PATH}" >&2
  exit 1
fi
cp -R "${TRAY_APP_PATH}" "${APPLICATIONS_DIR}/${TRAY_APP_NAME}"

pkgbuild \
  --identifier "ai.trapezohe.companion.installer" \
  --version "${VERSION}" \
  --root "${PKG_ROOT}" \
  --scripts "${PKG_SCRIPTS}" \
  "${PACKAGE_FILE}"

echo "Built ${PACKAGE_FILE}"
