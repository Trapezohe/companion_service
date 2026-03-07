# Installer Surface + Mainline Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `.pkg` / `.msi` the only first-class public Companion desktop deliverables, demote tray artifacts into internal stage outputs, and integrate the panel/startup branch back into the main Companion repo flow without disturbing user-owned local changes.

**Architecture:** Centralize installer-vs-stage artifact naming in a small Node helper that both tests and shell scripts can consume, move tray staging outputs out of `dist/installers` into an internal `dist/stage` tree, and update package scripts/docs/release copy so public distribution only talks about installers. After verification, cherry-pick the panel/startup commits into the main repo so the mainline Companion history includes the tray panelization work.

**Tech Stack:** Node.js test runner, shell/PowerShell installer scripts, GitHub Actions release workflow, Git cherry-pick.

---

### Task 1: Add failing tests for installer artifact taxonomy

**Files:**
- Create: `src/installer-artifacts.test.mjs`
- Create: `src/installer-artifacts.mjs`

**Steps:**
1. Write tests proving public release artifacts only include `trapezohe-companion-macos.pkg`, `trapezohe-companion-windows.msi`, and `SHA256SUMS.txt`.
2. Write tests proving tray stage outputs live under `dist/stage/...` rather than `dist/installers/...`.
3. Run `node --test src/installer-artifacts.test.mjs` and verify RED.

### Task 2: Implement installer/stage artifact helper and wire build scripts

**Files:**
- Create: `src/installer-artifacts.mjs`
- Modify: `scripts/build-tray-macos.sh`
- Modify: `scripts/build-tray-windows.ps1`
- Modify: `scripts/build-macos-pkg.sh`
- Modify: `scripts/build-windows-msi.ps1`

**Steps:**
1. Implement a small helper that returns public release artifact names and tray stage paths.
2. Move tray stage outputs from `dist/installers` to `dist/stage`.
3. Keep optional debug archives explicit rather than default/public.
4. Re-run `node --test src/installer-artifacts.test.mjs` and keep it green.

### Task 3: Tighten the public installer narrative

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `.github/workflows/release-installers.yml`

**Steps:**
1. Rename user-facing tray build scripts to `stage:*` so they read as internal staging helpers, not public release commands.
2. Update README and release notes so the tray panel is described as part of the installer, not an optional side artifact.
3. Keep checksums and release assets scoped to `.pkg` / `.msi` only.

### Task 4: Verify the integrated branch and land it into mainline

**Files:**
- No new source files expected.

**Steps:**
1. Run `npm test` in the Companion repo.
2. Run `~/.cargo/bin/cargo test --manifest-path tray/Cargo.toml`.
3. If available on this host, run `~/.cargo/bin/cargo build --manifest-path tray/Cargo.toml` and a local macOS installer build sanity check.
4. Commit the installer-surface changes in the worktree.
5. Cherry-pick the panel/startup commit and installer-surface commit onto `/Users/songsu/Desktop/trapezohe-companion` mainline, preserving the user-owned `.gitignore` modification.
