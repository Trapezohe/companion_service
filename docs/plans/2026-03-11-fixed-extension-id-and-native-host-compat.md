# Fixed Extension ID And Native Host Compatibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Hardcode the production Ghast extension ID in companion native-host registration and bootstrap flows so the released browser extension can always detect the installed companion without manual extension-id configuration.

**Architecture:** Introduce a single fixed extension-id constant in the companion native-host layer, route all allowed-origin generation and bootstrap/register flows through it, and update the macOS installer’s manual manifest writer to emit the same fixed origin. Keep the change narrow: preserve host aliases, preserve existing repair/start flows, but remove runtime dependence on configurable `extensionIds` for discovery.

**Tech Stack:** Node.js ESM, `node:test`, shell installer script, existing companion CLI/native-host tests

---

### Task 1: Add failing regression tests for fixed extension-id behavior

**Files:**
- Modify: `src/native-host-bootstrap.test.mjs`
- Modify: `src/installer-surface.test.mjs`
- Test: `src/native-host-bootstrap.test.mjs`
- Test: `src/installer-surface.test.mjs`

**Step 1: Write the failing tests**
- Assert bootstrap/register behavior resolves to `nnhdkkgpoeojjddikcjadgpkbfbjhcal` even when no CLI/config extension ids are provided.
- Assert the macOS postinstall script writes the fixed extension origin instead of the stale legacy ID.

**Step 2: Run tests to verify they fail**
Run: `node --test src/native-host-bootstrap.test.mjs src/installer-surface.test.mjs`
Expected: FAIL because bootstrap still skips when IDs are absent and the installer still references the stale old extension ID.

**Step 3: Keep assertions focused**
- Test only the fixed ID/origin behavior.
- Avoid full output snapshots.

### Task 2: Implement fixed extension-id resolution in the companion runtime

**Files:**
- Modify: `src/native-host.mjs`
- Modify: `bin/cli.mjs`
- Modify: `src/diagnostics.mjs`
- Test: `src/native-host-bootstrap.test.mjs`

**Step 1: Add the fixed extension-id constant**
- Define the production extension ID once in `src/native-host.mjs`.
- Make native-host origin resolution default to that constant.

**Step 2: Remove bootstrap/register dependence on dynamic extension ids**
- Ensure bootstrap/register/repair write manifests for the fixed ID even without `--ext-id` or config state.
- Keep CLI/config compatibility narrow; ignore or normalize user-provided extension ids instead of requiring them.

**Step 3: Update diagnostics expectations**
- Make native-host diagnostics/self-check treat the fixed extension ID as required by default.

**Step 4: Re-run targeted tests**
Run: `node --test src/native-host-bootstrap.test.mjs`
Expected: PASS.

### Task 3: Fix the installer package surface

**Files:**
- Modify: `packaging/macos/postinstall`
- Test: `src/installer-surface.test.mjs`

**Step 1: Replace the stale legacy extension ID in the manual macOS manifest writer**
- Emit the fixed extension origin `chrome-extension://nnhdkkgpoeojjddikcjadgpkbfbjhcal/` for both host aliases and supported Chromium browser directories.

**Step 2: Re-run the installer surface tests**
Run: `node --test src/installer-surface.test.mjs`
Expected: PASS.

### Task 4: Verify end-to-end touched surfaces

**Files:**
- Verify only

**Step 1: Run focused verification**
Run: `node --test src/native-host-bootstrap.test.mjs src/installer-surface.test.mjs`
Expected: PASS.

**Step 2: Run broader companion verification**
Run: `npm test`
Expected: May reveal unrelated pre-existing failures; record them explicitly if so.
