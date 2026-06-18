## Context

Argus already ships a fully working updater pipeline (see `openspec/specs/app-updater/spec.md` and `src/platform/updater/UpdaterProvider.tsx`). Once an update is detected, it downloads silently in the background and is held in memory via a ref (`pendingRef`). The binary swap is gated on a `beforeunload` handler that runs only when the user quits the app. The status bar's `VersionIndicator` already shows the pending version (`v0.1.6 → v0.1.7`) and exposes "Check for updates now", "Skip this version", and "Clear skipped version" actions.

Two real-world friction points motivate this change:
1. Argus is a long-lived desktop tool — users keep it open for days and rarely cold-restart.
2. The current "quit to apply" model is implicit; new users don't know an update is waiting and never trigger it.

We want the *minimum* UX change: a single, additive menu item right next to the existing version label, visible only when an update is actually downloaded.

## Goals / Non-Goals

**Goals:**
- One-click apply + relaunch from the status bar dropdown when a pending update exists.
- Reuse the in-memory `Update` object from `pendingRef`; do **not** re-download.
- Idempotent: if the user spams the button, only one install runs and the relaunch fires once.
- Preserve all existing updater behavior (silent background download, quit-time apply, skip semantics).

**Non-Goals:**
- A confirmation dialog. The button label is explicit ("Install update & restart"); a modal would add friction without information.
- Surfacing per-window save state or warning about unsaved scratch buffers. Out of scope; query history & saved queries already persist.
- A separate large CTA / toast / banner. The dropdown affordance is enough for V1; we can elevate later if telemetry shows low discovery.
- A progress bar. The download already completed in the background; `install()` on macOS is fast enough (sub-second to a few seconds) that a spinner + disabled state is sufficient.
- Windows/Linux work. Argus currently ships only macOS (beta DMG via R2). The `relaunch()` API is cross-platform but we only test mac.

## Decisions

### Decision 1: Use `@tauri-apps/plugin-process` `relaunch()` instead of a custom Rust command

**Choice:** Add the `process` plugin (JS + Rust + capability) and call `relaunch()` from the frontend after `Update.install()` resolves.

**Why:** `relaunch()` is the official Tauri 2 API for restarting the app process and handles platform differences (re-execing on macOS, spawning a new instance on Windows). Writing a custom `#[tauri::command]` would duplicate this logic and require us to maintain platform quirks.

**Alternatives considered:**
- *Custom Rust command using `std::process::Command`*: rejected — re-implements `relaunch()` worse.
- *Simulate the existing `beforeunload` path by calling `window.close()` after `install()` resolves*: rejected — `install()` is async and the beforeunload handler is sync-gated; racing them is brittle, and `close()` would not actually relaunch, just quit.

### Decision 2: Place the action in the existing `VersionIndicator` dropdown, not a new banner/toast

**Choice:** A new `DropdownMenu.Item` labeled "Install update & restart" rendered above the "Skip" item when `pendingVersion` is set.

**Why:** The version label already changes to `v0.1.6 → v0.1.7` and has a "pending" data attribute (`data-pending="true"`). Users who notice the pending indicator naturally click it; the menu is the discoverability path that already exists. Adding a toast/banner is a much bigger UX change and conflicts with the project's "no AI slop, minimal chrome" design stance in `DESIGN.md`.

**Alternatives considered:**
- *Persistent toast when pending*: rejected as too loud for a data tool that should fade into the background.
- *Inline button next to version label*: rejected — clutters the status bar, breaks the single-trigger model.

### Decision 3: New `installAndRestart()` action on `UpdaterCtx`, gated by an `isInstalling` flag

**Choice:** Add `installAndRestart: () => Promise<void>` and `isInstalling: boolean` to the context. The action:
1. Returns early if `pendingRef.current` is null or `installingRef.current` is true.
2. Sets `installingRef.current = true` and `setIsInstalling(true)`.
3. Awaits `pendingRef.current.install()`.
4. Calls `relaunch()` from `@tauri-apps/plugin-process`.
5. On error, logs and resets `installingRef` + `isInstalling` so the user can retry.

**Why:** Mirrors the existing `pendingRef` / `installingRef` pattern used by the quit-time handler, so the two paths cannot fight each other (the ref guard blocks the `beforeunload` handler from also calling `install()` if the user happens to quit mid-install).

**Alternatives considered:**
- *Reuse the `beforeunload` handler by dispatching a synthetic event*: brittle, depends on browser internals.
- *Drop `installingRef` and rely on React state only*: race-y — React state updates are async, and we need a synchronous guard against double-clicks across renders.

### Decision 4: Disabled menu item while installing, no separate spinner UI

**Choice:** The `DropdownMenu.Item` reads "Installing…" and has `disabled={isInstalling}` while in flight. The relaunch typically fires within ~1–2 seconds, after which the window is gone and the user sees the new build's launch.

**Why:** Adding a toast or modal spinner is more chrome than the action warrants. The disabled-item-with-label-change pattern is consistent with how Radix dropdowns handle in-progress states elsewhere in the app.

### Decision 5: Capability scope — `process:default` vs narrower `process:allow-restart`

**Choice:** Use `process:allow-restart` only (not `process:default`) so we don't accidentally grant `process:exit` permission, which would let the frontend kill the app without applying any update.

**Why:** Least privilege. We only need `relaunch`, never `exit`.

## Risks / Trade-offs

- **Unsaved scratch query buffers lost on relaunch** → Mitigation: button label is explicit ("restart"); Argus's `query-history` already records executed queries so users can recover their work. Adding a confirm dialog is out of scope for V1; we'll reconsider if user feedback says otherwise.
- **`install()` could hang or fail silently** → Mitigation: wrap in try/catch, log via `console.debug` like existing updater code, reset `isInstalling` so the user can retry or fall back to quit-and-apply.
- **`relaunch()` fires before `install()` actually finishes flushing to disk** → Per Tauri docs, `Update.install()` resolves only after the swap completes on macOS, so awaiting it is sufficient. We do **not** add an artificial delay.
- **Two install paths could race (user clicks button then ⌘Q immediately)** → Mitigation: shared `installingRef` guard between the two handlers ensures only one `install()` call ever runs.
- **Capability change is a Tauri permission expansion** → Reviewed: `process:allow-restart` is narrowly scoped and signed builds enforce it; no broader attack surface.

## Migration Plan

No data migration. Deployment is a normal release:
1. Land the change; bump VERSION; publish a new build to the R2 endpoint.
2. Users on the previous build receive the new build through the existing silent download path.
3. Once on the new build, the menu item is available on the next pending update.

Rollback: revert the PR. The old quit-to-apply path is unchanged and continues to work for users who never invoke the new menu item.

## Open Questions

- Should we add a telemetry counter for "install-and-restart clicked" vs "applied on quit" to decide if a louder affordance is worth building later? *Out of scope for V1 but worth noting.*
- Should the menu item be hidden vs disabled when `pendingVersion` is null? *Resolved: hidden — matches the existing pattern for the "Skip vX.X.X" item.*
