#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT_DIR}/scripts/lib/macos-signing.sh"
source "${ROOT_DIR}/scripts/lib/tauri-updater.sh"

VERSION="${1:-$(ROOT_DIR_ENV="${ROOT_DIR}" python3 - <<'PY'
import tomllib
import os
from pathlib import Path

root = Path(os.environ["ROOT_DIR_ENV"])
data = tomllib.loads(root.joinpath("Cargo.toml").read_text())
print(data["workspace"]["package"]["version"])
PY
)}"
OUT_DIR="${ROOT_DIR}/dist/installers"
STAGE_ROOT="${TRAPEZOHE_MACOS_STAGE_ROOT:-${ROOT_DIR}/dist/stage/macos-tray/${VERSION}}"
APP_NAME="GhastAI Companion.app"
APP_PATH="${STAGE_ROOT}/${APP_NAME}"
ARCHIVE_NAME="trapezohe-companion-macos.app.tar.gz"
ARCHIVE_PATH="${OUT_DIR}/${ARCHIVE_NAME}"
SIGNATURE_PATH="${ARCHIVE_PATH}.sig"
LATEST_JSON_PATH="${OUT_DIR}/latest.json"
PLATFORM_KEY="$(tauri_updater_platform_key)"
PUB_DATE="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
RELEASE_BASE_URL="${TRAPEZOHE_UPDATER_BASE_URL:-}"
if [[ -z "${RELEASE_BASE_URL}" ]]; then
  RELEASE_BASE_URL="https://github.com/Trapezohe/companion_service/releases/download/v${VERSION}"
fi
NOTES="GhastAI Companion v${VERSION} macOS in-app update."

mkdir -p "${OUT_DIR}"

if [[ ! -d "${APP_PATH}" ]]; then
  "${ROOT_DIR}/scripts/build-tray-macos.sh" "${VERSION}" --stage-only
fi

if [[ ! -d "${APP_PATH}" ]]; then
  echo "Tray app bundle not found at ${APP_PATH}" >&2
  exit 1
fi

if ! tauri_updater_has_signing_key; then
  echo "Missing updater signing key; cannot build macOS updater artifacts." >&2
  exit 1
fi

/usr/bin/xattr -cr "${APP_PATH}" 2>/dev/null || true
macos_notarize_app_bundle "${APP_PATH}"
rm -f "${ARCHIVE_PATH}" "${SIGNATURE_PATH}" "${LATEST_JSON_PATH}"
COPYFILE_DISABLE=1 /usr/bin/tar -C "${STAGE_ROOT}" -czf "${ARCHIVE_PATH}" "${APP_NAME}"
tauri_sign_archive "${ARCHIVE_PATH}" "${SIGNATURE_PATH}"
SIGNATURE_CONTENT="$(tr -d '\n' < "${SIGNATURE_PATH}")"

python3 - <<PY
import json
from pathlib import Path

latest = {
    "version": "${VERSION}",
    "notes": "${NOTES}",
    "pub_date": "${PUB_DATE}",
    "platforms": {
        "${PLATFORM_KEY}": {
            "signature": "${SIGNATURE_CONTENT}",
            "url": "${RELEASE_BASE_URL}/${ARCHIVE_NAME}"
        }
    }
}
Path("${LATEST_JSON_PATH}").write_text(json.dumps(latest, indent=2) + "\n")
PY

echo "Built ${ARCHIVE_PATH}"
echo "Built ${SIGNATURE_PATH}"
echo "Built ${LATEST_JSON_PATH}"
