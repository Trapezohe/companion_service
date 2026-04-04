#!/usr/bin/env bash

if [[ -n "${TRAPEZOHE_UPDATER_ENV_FILE:-}" && -f "${TRAPEZOHE_UPDATER_ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${TRAPEZOHE_UPDATER_ENV_FILE}"
  set +a
elif [[ -n "${TRAPEZOHE_MACOS_SIGNING_ENV_FILE:-}" && -f "${TRAPEZOHE_MACOS_SIGNING_ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${TRAPEZOHE_MACOS_SIGNING_ENV_FILE}"
  set +a
fi

tauri_updater_normalize_env() {
  if [[ -n "${TRAPEZOHE_UPDATER_PRIVATE_KEY:-}" && -z "${TAURI_PRIVATE_KEY:-}" ]]; then
    export TAURI_PRIVATE_KEY="${TRAPEZOHE_UPDATER_PRIVATE_KEY}"
  fi
  if [[ -n "${TRAPEZOHE_UPDATER_PRIVATE_KEY_PATH:-}" && -z "${TAURI_PRIVATE_KEY_PATH:-}" ]]; then
    export TAURI_PRIVATE_KEY_PATH="${TRAPEZOHE_UPDATER_PRIVATE_KEY_PATH}"
  fi
  if [[ -n "${TRAPEZOHE_UPDATER_PRIVATE_KEY_PASSWORD+x}" && -z "${TAURI_PRIVATE_KEY_PASSWORD+x}" ]]; then
    export TAURI_PRIVATE_KEY_PASSWORD="${TRAPEZOHE_UPDATER_PRIVATE_KEY_PASSWORD}"
  fi

  if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" && -z "${TAURI_PRIVATE_KEY:-}" ]]; then
    export TAURI_PRIVATE_KEY="${TAURI_SIGNING_PRIVATE_KEY}"
  fi
  if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" && -z "${TAURI_PRIVATE_KEY_PATH:-}" ]]; then
    export TAURI_PRIVATE_KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH}"
  fi
  if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+x}" && -z "${TAURI_PRIVATE_KEY_PASSWORD+x}" ]]; then
    export TAURI_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD}"
  fi

  case "${TAURI_PRIVATE_KEY_PASSWORD:-}" in
    EMPTY|__EMPTY__)
      export TAURI_PRIVATE_KEY_PASSWORD=""
      ;;
  esac
}

tauri_updater_has_signing_key() {
  tauri_updater_normalize_env
  [[ -n "${TAURI_PRIVATE_KEY:-}" || -n "${TAURI_PRIVATE_KEY_PATH:-}" ]]
}

tauri_updater_platform_key() {
  case "$(uname -m)" in
    arm64|aarch64)
      echo "darwin-aarch64"
      ;;
    x86_64)
      echo "darwin-x86_64"
      ;;
    *)
      echo "Unsupported macOS updater architecture: $(uname -m)" >&2
      return 1
      ;;
  esac
}

tauri_sign_archive() {
  local archive_path="${1:?archive path is required}"
  local signature_path="${2:?signature path is required}"
  local private_key_path=""
  local temp_key_file=""
  local password=""
  local -a signer_cmd=()

  tauri_updater_normalize_env
  private_key_path="${TAURI_PRIVATE_KEY_PATH:-}"
  password="${TAURI_PRIVATE_KEY_PASSWORD-}"

  if [[ -z "${private_key_path}" && -n "${TAURI_PRIVATE_KEY:-}" ]]; then
    temp_key_file="$(mktemp /tmp/trapezohe-updater-key.XXXXXX)"
    printf '%s' "${TAURI_PRIVATE_KEY}" > "${temp_key_file}"
    private_key_path="${temp_key_file}"
  fi

  if [[ -z "${private_key_path}" ]]; then
    echo "Missing Tauri updater private key. Set TAURI_PRIVATE_KEY_PATH or TAURI_PRIVATE_KEY." >&2
    rm -f "${temp_key_file}"
    return 1
  fi

  rm -f "${archive_path}.sig" "${signature_path}"
  signer_cmd=(
    env
    -u TAURI_SIGNING_PRIVATE_KEY
    -u TAURI_SIGNING_PRIVATE_KEY_PATH
    -u TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    -u TAURI_PRIVATE_KEY
    -u TAURI_PRIVATE_KEY_PATH
    -u TAURI_PRIVATE_KEY_PASSWORD
    npx
    -y
    @tauri-apps/cli@2.10.1
    signer
    sign
    -f
    "${private_key_path}"
    -p
    "${password}"
    "${archive_path}"
  )
  "${signer_cmd[@]}"
  mv -f "${archive_path}.sig" "${signature_path}"
  rm -f "${temp_key_file}"
}
