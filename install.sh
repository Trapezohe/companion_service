#!/usr/bin/env bash
set -euo pipefail

# Trapezohe Companion — One-click installer for macOS / Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/trapezohe/companion/main/install.sh | bash

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

NON_INTERACTIVE=0
EXT_ID=""
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
    --ext-id)
      EXT_ID="${2:-}"
      shift 2
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

echo ""
echo -e "${CYAN}${BOLD}  ╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}${BOLD}  ║     Trapezohe Companion — Installer          ║${NC}"
echo -e "${CYAN}${BOLD}  ╚══════════════════════════════════════════════╝${NC}"
echo ""

# ── Check Node.js ──

check_node() {
  if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed.${NC}"
    echo ""
    echo "  Install Node.js 18+ using one of:"
    echo "    • nvm:  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
    echo "    • fnm:  curl -fsSL https://fnm.vercel.app/install | bash"
    echo "    • brew: brew install node"
    echo ""
    exit 1
  fi

  NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}Error: Node.js 18+ is required (found: $(node -v))${NC}"
    echo "  Please upgrade Node.js and try again."
    exit 1
  fi

  echo -e "  ${GREEN}✓${NC} Node.js $(node -v) detected"
}

# ── Install package ──

install_companion() {
  echo -e "  ${YELLOW}→${NC} Installing trapezohe-companion globally..."
  npm install -g trapezohe-companion 2>&1 | sed 's/^/    /'
  echo -e "  ${GREEN}✓${NC} Package installed"
}

# ── Initialize config ──

init_config() {
  echo -e "  ${YELLOW}→${NC} Initializing configuration..."
  trapezohe-companion init 2>&1 | sed 's/^/    /'
  echo -e "  ${GREEN}✓${NC} Config created"
}

run_bootstrap() {
  echo -e "  ${YELLOW}→${NC} Running one-shot bootstrap..."
  local cmd=(trapezohe-companion bootstrap --mode "$MODE")

  if [[ -n "$WORKSPACE_ROOT" ]]; then
    cmd+=(--workspace "$WORKSPACE_ROOT")
  fi
  if [[ -n "$EXT_ID" ]]; then
    cmd+=(--ext-id "$EXT_ID")
  fi
  if [[ "$ENABLE_AUTOSTART" -eq 0 ]]; then
    cmd+=(--no-autostart)
  fi
  if [[ "$START_NOW" -eq 0 ]]; then
    cmd+=(--no-start)
  fi

  "${cmd[@]}" 2>&1 | sed 's/^/    /'
  echo -e "  ${GREEN}✓${NC} Bootstrap complete"
}

# ── Register Native Messaging Host ──

register_native_host() {
  echo ""
  echo -e "  ${BOLD}Chrome Native Messaging (auto-pairing)${NC}"
  echo ""
  echo "  To enable automatic pairing with the Trapezohe extension,"
  echo "  enter your extension ID (find it at chrome://extensions/)."
  echo ""
  read -p "  Extension ID (or press Enter to skip): " EXT_ID

  if [ -z "$EXT_ID" ]; then
    echo -e "  ${YELLOW}⚠${NC} Skipped. You can register later with:"
    echo "    trapezohe-companion register <extension-id>"
    return
  fi

  trapezohe-companion register "$EXT_ID" 2>&1 | sed 's/^/    /'
  echo -e "  ${GREEN}✓${NC} Native messaging host registered"
}

# ── Auto-start setup (default: enabled) ──

setup_autostart() {
  echo ""
  echo -e "  ${BOLD}Auto-start on login${NC}"
  read -p "  Enable auto-start? (Y/n) " -n 1 -r
  echo ""

  if [[ $REPLY =~ ^[Nn]$ ]]; then
    echo -e "  ${YELLOW}⚠${NC} Skipped. You can set it up later manually."
    return
  fi

  if [[ "$OSTYPE" == "darwin"* ]]; then
    setup_launchd
  elif [[ "$OSTYPE" == "linux"* ]]; then
    setup_systemd
  fi
}

setup_launchd() {
  local PLIST_DIR="$HOME/Library/LaunchAgents"
  local PLIST_FILE="$PLIST_DIR/ai.trapezohe.companion.plist"
  local CLI_PATH
  CLI_PATH=$(which trapezohe-companion 2>/dev/null || echo "")

  if [ -z "$CLI_PATH" ]; then
    echo -e "  ${YELLOW}⚠${NC} Could not locate trapezohe-companion binary. Skipping auto-start."
    return
  fi

  mkdir -p "$PLIST_DIR"

  cat > "$PLIST_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.trapezohe.companion</string>
  <key>ProgramArguments</key>
  <array>
    <string>${CLI_PATH}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${HOME}/.trapezohe/companion.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/.trapezohe/companion.error.log</string>
</dict>
</plist>
EOF

  launchctl load "$PLIST_FILE" 2>/dev/null || true
  echo -e "  ${GREEN}✓${NC} macOS LaunchAgent created"
  echo -e "    Companion will auto-start on login"
}

setup_systemd() {
  local SERVICE_DIR="$HOME/.config/systemd/user"
  local SERVICE_FILE="$SERVICE_DIR/trapezohe-companion.service"
  local CLI_PATH
  CLI_PATH=$(which trapezohe-companion 2>/dev/null || echo "")

  if [ -z "$CLI_PATH" ]; then
    echo -e "  ${YELLOW}⚠${NC} Could not locate trapezohe-companion binary. Skipping auto-start."
    return
  fi

  mkdir -p "$SERVICE_DIR"

  cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Trapezohe Companion - Local MCP Server Host
After=network.target

[Service]
ExecStart=${CLI_PATH} start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable trapezohe-companion 2>/dev/null || true
  systemctl --user start trapezohe-companion 2>/dev/null || true
  echo -e "  ${GREEN}✓${NC} systemd user service created and started"
}

# ── Main ──

check_node
install_companion

if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
  run_bootstrap
  echo ""
  echo -e "  ${GREEN}${BOLD}Installation complete!${NC}"
  echo ""
  echo "  Companion has been set up in non-interactive mode."
  echo "  Config: ~/.trapezohe/companion.json"
  echo ""
  exit 0
fi

init_config
register_native_host
setup_autostart

if [[ "$START_NOW" -eq 1 ]]; then
  trapezohe-companion start -d >/dev/null 2>&1 || true
fi

echo ""
echo -e "  ${GREEN}${BOLD}Installation complete!${NC}"
echo ""
echo "  Quick start:"
echo "    trapezohe-companion start      # Start in foreground"
echo "    trapezohe-companion start -d   # Start as daemon"
echo "    trapezohe-companion status     # Check status"
echo ""
echo "  Config: ~/.trapezohe/companion.json"
echo "  Docs:   https://github.com/trapezohe/companion"
echo ""
