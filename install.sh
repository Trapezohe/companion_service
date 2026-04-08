#!/usr/bin/env bash
set -euo pipefail

RELEASE_BASE_URL="https://github.com/Trapezohe/companion_service/releases/latest/download"
REPO_GIT_URL="https://github.com/Trapezohe/companion_service.git"

NON_INTERACTIVE=0
MODE="workspace"
WORKSPACE_ROOT=""
ENABLE_AUTOSTART=1
START_NOW=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --non-interactive|-y|--yes)
      NON_INTERACTIVE=1
      shift
      ;;
    --mode)
      MODE="${2:-workspace}"
      shift 2
      ;;
    --workspace)
      WORKSPACE_ROOT="${2:-}"
      shift 2
      ;;
    --no-autostart)
      ENABLE_AUTOSTART=0
      shift
      ;;
    --no-start)
      START_NOW=0
      shift
      ;;
    *)
      shift
      ;;
  esac
done

info() {
  printf '%s\n' "$*"
}

warn() {
  printf 'Warning: %s\n' "$*" >&2
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

resolve_cli_path() {
  local cargo_bin_dir="${CARGO_HOME:-$HOME/.cargo}/bin"
  if command -v trapezohe-companion >/dev/null 2>&1; then
    command -v trapezohe-companion
    return 0
  fi
  if [[ -x "${cargo_bin_dir}/trapezohe-companion" ]]; then
    printf '%s\n' "${cargo_bin_dir}/trapezohe-companion"
    return 0
  fi
  if [[ -x "$HOME/.trapezohe/bin/trapezohe-companion" ]]; then
    printf '%s\n' "$HOME/.trapezohe/bin/trapezohe-companion"
    return 0
  fi
  return 1
}

run_bootstrap() {
  local cli_path="$1"
  local cmd=("${cli_path}" bootstrap --mode "${MODE}")

  if [[ -n "${WORKSPACE_ROOT}" ]]; then
    cmd+=(--workspace "${WORKSPACE_ROOT}")
  fi
  if [[ "${ENABLE_AUTOSTART}" -eq 0 ]]; then
    cmd+=(--no-autostart)
  fi
  if [[ "${START_NOW}" -eq 0 ]]; then
    cmd+=(--no-start)
  fi

  info "Running companion bootstrap..."
  "${cmd[@]}"
}

install_macos_pkg() {
  local pkg_url="${RELEASE_BASE_URL}/trapezohe-companion-macos.pkg"
  local tmp_pkg
  tmp_pkg="$(mktemp /tmp/ghastai-companion.XXXXXX.pkg)"
  trap 'rm -f "${tmp_pkg}"' RETURN

  info "Downloading latest macOS installer..."
  curl -fL "${pkg_url}" -o "${tmp_pkg}"

  info "Installing GhastAI Companion..."
  sudo installer -pkg "${tmp_pkg}" -target /

  if [[ "${MODE}" != "workspace" || -n "${WORKSPACE_ROOT}" || "${ENABLE_AUTOSTART}" -eq 0 || "${START_NOW}" -eq 0 ]]; then
    local cli_path=""
    if cli_path="$(resolve_cli_path)"; then
      info "Applying requested bootstrap options..."
      run_bootstrap "${cli_path}"
    else
      warn "The packaged installer completed, but the local CLI was not found to apply custom bootstrap options."
      warn "Open GhastAI Companion once, then rerun bootstrap manually if you need a custom workspace or startup policy."
    fi
  fi

  info ""
  info "GhastAI Companion installation complete."
  info "Installed app: /Applications/GhastAI Companion.app"
}

install_linux_cli() {
  if ! command -v cargo >/dev/null 2>&1; then
    fail "Linux manual install now requires Rust/Cargo. Install rustup first, then rerun this script."
  fi

  if [[ -f "$(pwd)/crates/companion-cli/Cargo.toml" ]]; then
    info "Installing companion CLI from the current repository checkout..."
    cargo install --path "$(pwd)/crates/companion-cli" --bin trapezohe-companion --locked --force
  else
    info "Installing companion CLI from the GitHub repository..."
    cargo install --git "${REPO_GIT_URL}" --locked --force --bin trapezohe-companion companion-cli
  fi

  local cli_path=""
  cli_path="$(resolve_cli_path)" || fail "Companion CLI was installed, but the executable could not be found."
  run_bootstrap "${cli_path}"

  info ""
  info "GhastAI Companion installation complete."
  info "CLI: ${cli_path}"
  info "Config: $HOME/.trapezohe/companion.json"
}

main() {
  local os_name
  os_name="$(uname -s)"

  info ""
  info "GhastAI Companion installer"
  info ""

  case "${os_name}" in
    Darwin)
      install_macos_pkg
      ;;
    Linux)
      install_linux_cli
      ;;
    *)
      fail "Unsupported platform: ${os_name}"
      ;;
  esac

  if [[ "${NON_INTERACTIVE}" -eq 0 ]]; then
    info ""
    info "Quick start:"
    info "  trapezohe-companion status"
    info "  trapezohe-companion self-check"
  fi
}

main
