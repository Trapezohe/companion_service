#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT_DIR}/scripts/lib/macos-signing.sh"

VERSION="${1:-$(node -p "JSON.parse(require('fs').readFileSync('${ROOT_DIR}/package.json','utf8')).version")}"
OUT_DIR="${ROOT_DIR}/dist/installers"
STAGE_ROOT="${TRAPEZOHE_MACOS_STAGE_ROOT:-${ROOT_DIR}/dist/stage/macos-tray}"
WORK_DIR="$(mktemp -d)"
PKG_ROOT="${WORK_DIR}/root"
PKG_SCRIPTS="${WORK_DIR}/scripts"
APPLICATIONS_DIR="${PKG_ROOT}/Applications"
PACKAGE_FILE="${OUT_DIR}/trapezohe-companion-macos.pkg"
SIGNED_PACKAGE_FILE="${OUT_DIR}/trapezohe-companion-macos-signed.pkg"
TRAY_APP_NAME="Trapezohe Companion.app"
TRAY_APP_PATH="${STAGE_ROOT}/${TRAY_APP_NAME}"

cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

mkdir -p "${PKG_SCRIPTS}" "${OUT_DIR}" "${APPLICATIONS_DIR}"

"${ROOT_DIR}/scripts/build-tray-macos.sh" "${VERSION}" --stage-only

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

if macos_pkg_signing_enabled; then
  macos_sign_pkg "${PACKAGE_FILE}" "${SIGNED_PACKAGE_FILE}"
  mv -f "${SIGNED_PACKAGE_FILE}" "${PACKAGE_FILE}"
fi

macos_notarize_artifact "${PACKAGE_FILE}"

echo "Built ${PACKAGE_FILE}"
