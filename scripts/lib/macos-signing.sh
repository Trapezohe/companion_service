#!/usr/bin/env bash

if [[ -n "${TRAPEZOHE_MACOS_SIGNING_ENV_FILE:-}" && -f "${TRAPEZOHE_MACOS_SIGNING_ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${TRAPEZOHE_MACOS_SIGNING_ENV_FILE}"
  set +a
fi

macos_has_command() {
  command -v "$1" >/dev/null 2>&1
}

macos_normalize_identity_name() {
  local identity="${1:-}"
  identity="${identity%%,UID=*}"
  printf '%s' "${identity}"
}

macos_has_codesigning_identity() {
  local identity
  identity="$(macos_normalize_identity_name "${1:-}")"
  [[ -n "${identity}" ]] || return 1
  macos_has_command security || return 1
  security find-identity -v -p codesigning 2>/dev/null | grep -F "${identity}" >/dev/null 2>&1
}

macos_has_installer_identity() {
  local identity
  identity="$(macos_normalize_identity_name "${1:-}")"
  [[ -n "${identity}" ]] || return 1
  macos_has_command security || return 1
  security find-certificate -a -c "${identity}" 2>/dev/null | grep -F "alis" >/dev/null 2>&1
}

macos_app_signing_enabled() {
  macos_has_command codesign || return 1
  macos_has_codesigning_identity "${APPLE_DEVELOPER_ID_APP_IDENTITY:-}"
}

macos_pkg_signing_enabled() {
  macos_has_command productsign || return 1
  macos_has_installer_identity "${APPLE_DEVELOPER_ID_INSTALLER_IDENTITY:-}"
}

macos_notary_enabled() {
  macos_has_command xcrun || return 1
  [[ -n "${APPLE_ID:-}" ]] || return 1
  [[ -n "${APPLE_TEAM_ID:-}" ]] || return 1
  [[ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]] || return 1
}

macos_sign_app_bundle() {
  local app_path="${1:?app path is required}"
  local identity
  identity="$(macos_normalize_identity_name "${APPLE_DEVELOPER_ID_APP_IDENTITY:-}")"

  if ! macos_app_signing_enabled; then
    echo "Skipping macOS app signing: Developer ID Application identity is not available."
    return 0
  fi

  /usr/bin/xattr -cr "${app_path}" 2>/dev/null || true
  codesign --force --sign "${identity}" --options runtime --timestamp --deep "${app_path}"
  codesign --verify --deep --strict --verbose=2 "${app_path}"
}

macos_sign_pkg() {
  local input_pkg="${1:?input pkg is required}"
  local output_pkg="${2:?output pkg is required}"
  local identity
  identity="$(macos_normalize_identity_name "${APPLE_DEVELOPER_ID_INSTALLER_IDENTITY:-}")"

  if ! macos_pkg_signing_enabled; then
    echo "Skipping macOS pkg signing: Developer ID Installer identity is not available."
    return 0
  fi

  rm -f "${output_pkg}"
  productsign --sign "${identity}" "${input_pkg}" "${output_pkg}"
  pkgutil --check-signature "${output_pkg}" >/dev/null
}

macos_notarize_artifact() {
  local artifact_path="${1:?artifact path is required}"

  if ! macos_notary_enabled; then
    echo "Skipping macOS notarization: notary credentials are not available."
    return 0
  fi

  xcrun notarytool submit "${artifact_path}" \
    --apple-id "${APPLE_ID}" \
    --password "${APPLE_APP_SPECIFIC_PASSWORD}" \
    --team-id "${APPLE_TEAM_ID}" \
    --wait

  xcrun stapler staple "${artifact_path}"
}

macos_notarize_app_bundle() {
  local app_path="${1:?app path is required}"
  local temp_dir=""
  local archive_path=""

  if ! macos_notary_enabled; then
    echo "Skipping macOS notarization: notary credentials are not available."
    return 0
  fi

  temp_dir="$(mktemp -d)"
  archive_path="${temp_dir}/$(basename "${app_path}").zip"
  COPYFILE_DISABLE=1 /usr/bin/ditto -c -k --sequesterRsrc --keepParent "${app_path}" "${archive_path}"

  xcrun notarytool submit "${archive_path}" \
    --apple-id "${APPLE_ID}" \
    --password "${APPLE_APP_SPECIFIC_PASSWORD}" \
    --team-id "${APPLE_TEAM_ID}" \
    --wait

  xcrun stapler staple "${app_path}"
  rm -rf "${temp_dir}"
}
