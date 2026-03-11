# Companion v0.1.8 Release Prep

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prepare the next companion release with the fixed Ghast extension ID, installer-driven daemon takeover, and user-facing release copy/checklist.

**Architecture:** This release is a patch bump from `0.1.6` to `0.1.8`. It ships two user-visible fixes: installers now re-register Native Messaging for the official Chrome Web Store extension ID `nnhdkkgpoeojjddikcjadgpkbfbjhcal`, and package installs hand off to the newly installed daemon instead of leaving an older process running.

**Tech Stack:** npm package metadata, Rust tray metadata, GitHub Releases workflow copy, markdown release notes, Node/Rust test suites

---

## Version Bumps

- `package.json` -> `0.1.8`
- `tray/Cargo.toml` -> `0.1.8`
- `tray/tauri.conf.json` -> `0.1.8`
- `tray/Cargo.lock` local crate entry -> `0.1.8`

## Suggested GitHub Release Title

`Trapezohe Companion v0.1.8`

## Suggested GitHub Release Body

```md
## Trapezohe Companion v0.1.8

This patch release fixes Companion auto-detection for the official Ghast Chrome extension and makes package upgrades take over older running daemons more reliably.

### Highlights

- Fixed Native Messaging registration to always target the official Ghast extension ID `nnhdkkgpoeojjddikcjadgpkbfbjhcal`
- Fixed macOS installer manifests that could still point to a stale legacy extension ID on clean machines
- Fixed package installs so the newly installed Companion daemon replaces an older running daemon automatically
- Kept the tray/control path pointed at the installed Companion CLI instead of a source-tree fallback
- Simplified user-facing install guidance: no manual `--ext-id` step is required anymore

### Upgrade Notes

- Existing users should install the new macOS `.pkg` or Windows `.msi` over the old version
- The installer rewrites Native Messaging manifests and restarts the local Companion daemon as part of the upgrade path
- If a browser was left open through multiple failed installs, a full browser restart is still recommended after upgrade
```

## Verification Checklist

### Targeted checks

```bash
node --test src/native-host-bootstrap.test.mjs src/installer-surface.test.mjs src/config.test.mjs
"$HOME/.cargo/bin/cargo" test --manifest-path tray/Cargo.toml daemon::tests
```

Expected:
- all Native Messaging / installer / tray CLI precedence tests pass

### Full companion suite

```bash
npm test
```

Expected:
- full Node test suite passes

### Optional manual smoke test

1. Install the new package on a machine that previously had `0.1.6` or `0.1.7` builds
2. Confirm Chrome native host manifests contain `chrome-extension://nnhdkkgpoeojjddikcjadgpkbfbjhcal/`
3. Open the Ghast extension Settings -> Companion page
4. Confirm auto-detect succeeds without manually entering an extension ID
5. Confirm the tray shows the new version and the daemon responds to restart/stop/start
