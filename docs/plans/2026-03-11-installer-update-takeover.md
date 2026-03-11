# Installer Update Takeover Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure a newly installed Trapezohe Companion package takes over from an older running daemon instead of leaving the old runtime active until a manual restart.

**Architecture:** Keep the fix narrow. Make the platform installers hand off to the newly installed CLI by stopping any existing daemon and starting the installed one, and make the tray prefer installed CLI binaries over a source-tree CLI when both exist. Verify with regression tests that lock in the script surface and CLI-resolution behavior.

**Tech Stack:** Node.js `node:test`, shell/PowerShell installer scripts, Rust tray shell tests

---

### Task 1: Lock in installer takeover expectations with failing tests

**Files:**
- Modify: `src/installer-surface.test.mjs`
- Test: `src/installer-surface.test.mjs`

**Step 1: Write the failing tests**
- Add a macOS surface test asserting the postinstall script uses the installed CLI wrapper to `stop --force` and `start -d` after deployment.
- Add a Windows surface test asserting the installer runs the installed CLI to stop any existing daemon and start the new one after bootstrap.

**Step 2: Run test to verify it fails**
Run: `node --test src/installer-surface.test.mjs`
Expected: FAIL because the installer scripts do not yet contain the takeover commands.

**Step 3: Keep the assertions narrow**
- Assert only the required handoff behavior and call order markers.
- Avoid brittle full-script snapshots.

**Step 4: Re-run once the tests are in place**
Run: `node --test src/installer-surface.test.mjs`
Expected: still FAIL until implementation lands.

### Task 2: Implement installer-driven daemon handoff

**Files:**
- Modify: `packaging/macos/postinstall`
- Modify: `packaging/windows/install-companion.ps1`
- Test: `src/installer-surface.test.mjs`

**Step 1: Add a macOS handoff helper**
- Introduce a helper that resolves the installed CLI wrapper, logs clearly, and calls `stop --force` then `start -d`.
- Invoke it after the service payload is deployed so it always targets the newly installed bits.

**Step 2: Add a Windows handoff helper**
- Introduce a helper that runs after `npm install -g`/bootstrap, using the installed `trapezohe-companion` command to stop any old daemon and start the new one.
- Keep failures non-fatal but logged, matching the installer's current resilience.

**Step 3: Re-run the surface tests**
Run: `node --test src/installer-surface.test.mjs`
Expected: PASS.

### Task 3: Keep tray control paths pointed at the installed CLI

**Files:**
- Modify: `tray/src/daemon.rs`
- Test: `tray/src/daemon.rs`

**Step 1: Keep the installed CLI precedence change**
- Preserve the existing preference for installed CLI candidates over the repo CLI.
- Confirm the regression tests cover both installed-preferred and repo-fallback paths.

**Step 2: Run focused Rust tests**
Run: `cargo test --manifest-path tray/Cargo.toml daemon::tests`
Expected: PASS.

### Task 4: Verify the combined behavior

**Files:**
- Verify only

**Step 1: Run targeted verification**
Run: `node --test src/installer-surface.test.mjs && cargo test --manifest-path tray/Cargo.toml daemon::tests`
Expected: both suites PASS.

**Step 2: Run broader project checks for touched surfaces**
Run: `npm test`
Expected: PASS.
