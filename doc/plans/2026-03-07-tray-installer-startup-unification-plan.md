# Tray Installer + Startup Unification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship the tray as part of the real macOS `.pkg` / Windows `.msi` installers, and make the tray the single desktop login entry that ensures the Companion daemon is running on launch.

**Architecture:** Replace tray-only autostart preferences with a unified startup policy persisted under `~/.trapezohe`, keep tray as the only desktop login item, and let tray perform a one-shot daemon ensure during startup when config exists and policy allows it. Packaging changes stage tray binaries into the installer payloads and remove the separate portable-bundle release narrative.

**Tech Stack:** Rust + Tauri tray shell, Node-based Companion bootstrap, shell/PowerShell installer scripts, WiX, GitHub Actions.

---

### Task 1: Write failing tests for unified startup policy and daemon ensure

**Files:**
- Modify: `tray/src/autostart.rs`
- Modify: `tray/src/lib.rs`

**Steps:**
1. Add tests proving legacy `companion-tray.json` is migrated into a new unified startup-policy file.
2. Add tests proving legacy daemon login artifacts are enumerated for cleanup on macOS / Windows / Linux.
3. Add tests proving tray startup only requests daemon launch when policy enables it, config is loaded, and snapshot starts in `Stopped` / degraded-offline state.
4. Run `cargo test` scoped to the new tests and verify RED.

### Task 2: Implement unified startup policy and tray-side daemon orchestration

**Files:**
- Modify: `tray/src/autostart.rs`
- Modify: `tray/src/lib.rs`
- Modify: `tray/src/models.rs`
- Modify: `tray/src/tray.rs`
- Modify: `tray/ui/index.html`

**Steps:**
1. Replace tray-only prefs with a unified startup-policy shape that records login-item ownership and daemon ensure policy.
2. Migrate legacy tray preference files forward automatically.
3. When autostart is toggled, register/unregister tray login items and remove legacy daemon login registrations.
4. During tray boot, evaluate startup policy once and start the daemon if config exists and status indicates it is not running.
5. Update panel/menu wording from “tray shell autostart” to “Companion desktop startup via tray”.
6. Run `cargo test` and keep the entire tray suite green.

### Task 3: Stage tray binaries into real installers

**Files:**
- Modify: `scripts/build-macos-pkg.sh`
- Modify: `scripts/build-windows-msi.ps1`
- Modify: `packaging/macos/postinstall`
- Modify: `packaging/windows/install-companion.ps1`
- Modify: `packaging/windows/installer.wxs`

**Steps:**
1. Build tray release binaries inside installer build scripts.
2. Copy the macOS `.app` bundle into the pkg payload and the Windows tray executable/assets into the MSI source directory.
3. Update post-install/bootstrap scripts to write unified startup policy, remove legacy daemon login registrations, register tray login startup, and best-effort launch tray once for the logged-in user.
4. Ensure `.pkg` / `.msi` remain the public install surface for both daemon + tray.

### Task 4: Remove separate portable-bundle release narrative

**Files:**
- Modify: `.github/workflows/release-installers.yml`
- Modify: `README.md`
- Optionally retain helper scripts: `scripts/build-tray-macos.sh`, `scripts/build-tray-windows.ps1`

**Steps:**
1. Remove standalone tray zip artifacts from the release workflow.
2. Update release notes / checksums / README so `.pkg` and `.msi` are described as the installer story.
3. Keep internal tray build helpers only if they remain useful for local debugging, but stop surfacing them as user-facing release assets.

### Task 5: Verify builds and regression surface

**Files:**
- No new source files expected.

**Steps:**
1. Run `cargo test` in `tray/`.
2. Run `npm test` in the repo root.
3. Build macOS pkg locally with `./scripts/build-macos-pkg.sh` and verify tray assets are included.
4. If PowerShell/WiX are available, run `./scripts/build-windows-msi.ps1`; otherwise document the local limitation.
5. Commit once verification is green.
