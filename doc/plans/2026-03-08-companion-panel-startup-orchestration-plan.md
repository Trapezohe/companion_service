# Companion Panel + Startup Orchestration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the tray status window into a real always-available management panel and unify tray/daemon startup orchestration so sign-in launch, manual panel launch, and daemon ensure all flow through one policy-aware path.

**Architecture:** Keep the tray shell as the single desktop entry point, but move panel/window lifecycle and startup decision-making into explicit modules. The tray icon becomes a fast entry to a persistent hidden panel, while startup orchestration becomes a policy-driven state machine that decides whether to stay silent, start the daemon, wait for readiness, or surface the panel when setup/repair is needed.

**Tech Stack:** Rust + Tauri 2 tray shell, existing reqwest/tokio polling, HTML/CSS/JS status panel, Node-based companion CLI.

---

### Task 1: Add failing tests for startup/panel policy decisions

**Files:**
- Create: `tray/src/startup.rs`
- Modify: `tray/src/lib.rs`

**Steps:**
1. Write focused tests in `tray/src/startup.rs` for startup decisions:
   - policy-enabled + stopped + config-present => ensure daemon
   - already healthy => no ensure
   - misconfigured on startup => reveal panel
   - stopped without config => reveal panel, do not ensure
   - degraded after failed ensure => reveal panel
2. Run `cargo test --manifest-path tray/Cargo.toml startup::tests` and verify RED.

### Task 2: Implement unified startup orchestration module

**Files:**
- Create: `tray/src/startup.rs`
- Modify: `tray/src/lib.rs`
- Modify: `tray/src/daemon.rs`
- Modify: `tray/src/models.rs`

**Steps:**
1. Add a small `StartupDecision` / `StartupAction` model that translates current snapshot + policy + config availability into one explicit action plan.
2. Add a daemon readiness helper that polls health after `start -d` instead of relying only on fixed sleep.
3. Replace `run_startup_reconciliation` branching in `tray/src/lib.rs` with the startup module.
4. Make startup orchestration decide when to silently reconcile and when to surface the panel.
5. Re-run the new startup tests and keep them green.

### Task 3: Add failing tests for the real panel behavior contract

**Files:**
- Modify: `tray/src/tray.rs`
- Modify: `tray/src/window.rs`
- Modify: `tray/src/lib.rs`

**Steps:**
1. Add pure tests for the panel exposure policy:
   - tray left click opens panel instead of only opening the tray menu
   - close requests should hide the panel instead of destroying it
   - setup-needed / startup-error snapshots request panel reveal
2. Run targeted `cargo test --manifest-path tray/Cargo.toml panel` or the closest matching test filters and verify RED.

### Task 4: Implement the real panel lifecycle

**Files:**
- Modify: `tray/src/window.rs`
- Modify: `tray/src/tray.rs`
- Modify: `tray/src/lib.rs`
- Modify: `tray/tauri.conf.json`

**Steps:**
1. Pre-create or ensure the status window early so the tray owns a persistent panel instance.
2. Intercept window close requests and hide the panel instead of tearing it down.
3. Make tray left click open/focus the panel; keep menu access on the tray icon for management actions.
4. Make startup/setup errors auto-surface the panel once so ordinary users see actionable state instead of a silent background failure.
5. Re-run the new panel tests and keep them green.

### Task 5: Tighten panel UX for startup/repair flows

**Files:**
- Modify: `tray/ui/index.html`
- Modify: `tray/src/models.rs`

**Steps:**
1. Add explicit startup/reconciliation copy so the panel distinguishes checking, ensuring daemon, and repair-needed states.
2. Add a small launch/status hint that explains whether the tray started on sign-in and whether the daemon ensure path ran.
3. Keep the UI changes minimal and driven by the new startup/panel data model.
4. Verify there is no broken command wiring in the panel.

### Task 6: Full verification and commit

**Files:**
- No new source files expected.

**Steps:**
1. Run `npm test` in the repo root.
2. Run `cargo test --manifest-path tray/Cargo.toml`.
3. If the tray still builds cleanly, run a local `cargo build --manifest-path tray/Cargo.toml` sanity check.
4. Commit the implementation in the worktree with a focused message.
