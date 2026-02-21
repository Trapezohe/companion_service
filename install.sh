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

# ── Optional: Auto-start setup ──

setup_autostart() {
  echo ""
  echo -e "  ${BOLD}Auto-start on login?${NC}"
  read -p "  Set up auto-start? (y/N) " -n 1 -r
  echo ""

  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
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
init_config
setup_autostart

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
