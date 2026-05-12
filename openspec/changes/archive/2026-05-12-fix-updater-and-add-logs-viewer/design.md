## Context

Argus ships as a Tauri 2 desktop app with auto-updates served from Cloudflare R2 (`latest.json` + signed archives). The current implementation, after the in-flight `install-update-restart-button` change, has two real-world failure modes that we have confirmed by hand on macOS release builds:

1. **Quit-time apply silently fails.** `UpdaterProvider.tsx` listens for `beforeunload`, calls `event.preventDefault()`, fires `update.install()` without awaiting, and calls `window.close()` from a `.finally()`. On macOS, the WebView destruction kicks off before `install()` (which rewrites the `.app` bundle on disk) has actually swapped the binary. The user sees the badge disappear, but the next launch comes up on the old version because the swap was aborted mid-flight.
2. **"Install update & restart" appears to do nothing.** When the user clicks the action, `installAndRestart()` awaits `pendingRef.current.install()` then awaits `relaunch()`. In practice we have observed: (a) `install()` throws with an opaque error (often a code-signing or quarantine attribute issue on aarch64) that is caught and swallowed into `console.debug`; (b) when `install()` succeeds, the JS `relaunch()` call sometimes does not actually restart the process because the webview is being torn down by `install()` before the relaunch IPC reaches Rust. The user gets a dead-end UI: "Installing…" appears for a beat, then nothing.

The deeper structural issue: **all updater state lives in the renderer**, all error reporting goes to `console.debug` (which is invisible in release), and the only durable log file (`~/Library/Logs/Argus/argus.log` via `tracing-appender`) is unreachable without opening a terminal. We cannot debug user reports without remote access to the machine.

**Stakeholders**: every user running v0.1.7+, since the bug blocks the auto-update mechanism itself. Self-host operator (Gabriel) needs production debuggability.

**Constraints**:
- Must respect existing capability surface (`process:allow-restart` only — no `process:allow-exit`).
- Must not break the existing `beforeunload` quit flow for users without a pending update (no extra delay on normal quit).
- Must continue to work with the existing R2-hosted manifest and Ed25519 signature flow.
- Renderer cannot reliably hold the `Update` handle across an `install()` call — we have evidence the JS object is invalidated mid-install on at least one platform.

## Goals / Non-Goals

**Goals:**
- Make the quit-time apply reliable: when the user quits with a pending update, the binary swap MUST complete before the process exits.
- Make "Install update & restart" reliable: clicking it MUST either result in a relaunch onto the new version, or a user-visible error explaining why.
- Make every updater step observable in `argus.log` with `target=updater`, including renderer-originated events.
- Give the user (and us, during support) a one-click way to view recent updater logs from inside the running app and reveal the log folder in Finder/Explorer.
- Keep the new logs viewer usable on a "production" build (i.e. a non-developer's machine) with no extra setup.

**Non-Goals:**
- No live `tail -f` streaming in the modal. A snapshot of the last ~200 lines on open + a manual "Refresh" button is enough for debugging.
- No log shipping to a remote service. Logs stay on disk; the user copies and pastes them to us if needed.
- No new spec or change to the existing R2 release pipeline, signing, or manifest format.
- No fix for unrelated `tracing` log noise outside the updater module.

## Decisions

### D1. Move install-and-relaunch and quit-time apply into Rust

**Choice**: Hold the pending `tauri_plugin_updater::Update` handle in a Rust `Mutex<Option<Update>>` managed by Tauri state. Expose three commands:
- `updater_check_and_download() -> { available: Option<UpdateInfo> }` — replaces the renderer's `check()` + `download()` calls.
- `updater_install_and_restart() -> Result<(), String>` — calls `update.install().await`, then `app.restart()`.
- `updater_apply_pending_on_quit() -> Result<(), String>` — invoked from `RunEvent::ExitRequested`, blocks exit until install completes (with a 10s timeout).

Renderer still owns scheduling (5s first check, 4h interval), persisted skipped version, and UI state.

**Why over alternatives**:
- *Keep everything in JS (status quo)*: JS `Update` handle has shown to be unreliable across `install()` on aarch64 macOS; renderer-side `relaunch()` races webview teardown. Both bugs root-cause to this.
- *Move scheduling into Rust too*: more work, no payoff — scheduling is fine in JS and easier to reason about there.
- *Use only `app.restart()` (Tauri API) and keep `install()` in JS*: doesn't fix the `install()` race; we'd still have an opaque error path.

### D2. Use `RunEvent::ExitRequested` for deterministic quit-time apply

**Choice**: Replace the renderer's `beforeunload` install path with a Rust-side hook on `RunEvent::ExitRequested`. If the Tauri state holds a pending `Update`, call `api.prevent_exit()`, run `update.install().await` with a 10s timeout, then call `app.exit(0)`. If no pending update, allow normal exit.

**Why over alternatives**:
- *Keep `beforeunload` + improve sequencing*: `beforeunload` cannot reliably hold the webview process open while a Rust-side file rewrite finishes — the OS owns that race.
- *Async exit hook with no timeout*: a misbehaving `install()` would softlock the user's quit attempt. A bounded timeout that logs `error` and exits anyway preserves the user's intent ("I asked to quit"); they get the old version on next launch, which is no worse than today.

### D3. New `updater` Rust module owns commands and the in-memory state

**Choice**: Create `src-tauri/src/platform/updater/` with `mod.rs` (state type `UpdaterState { pending: Mutex<Option<Update>> }`) and `commands.rs` (the four commands above plus the three log commands). Wire `app.manage(UpdaterState::default())` in `lib.rs::run()`'s `setup`. Keep `tauri_plugin_updater::Builder::new().build()` registration as-is.

**Why**: matches the existing module layout (`platform/connections/`, `platform/connection_groups/`, `modules/postgres/`, etc.) and isolates updater concerns so logs/state/commands move together.

### D4. Renderer logs flow through Rust via a `log_updater_event` command

**Choice**: Replace `console.debug("[updater] ...")` with `logUpdater(level, msg, fields?)` that calls `invoke("log_updater_event", { level, msg, fields })`. The command emits a `tracing` event with `target = "updater"` at the requested level. In dev (debug builds), `tracing` also goes to stderr; in release, it goes to `argus.log`.

**Why over alternatives**:
- *`tauri-plugin-log` (which forwards JS `console.*` to Rust)*: adds a dependency, and we'd have to filter for updater-only logs at viewer time. A targeted command is smaller and gives us a clean `target=updater` filter for free.
- *Keep `console.debug` and just rely on Rust-side logs*: leaves renderer-driven state changes invisible in production. We need symmetry: every checkpoint logs.

### D5. In-app logs viewer reads the log file directly via two commands

**Choice**:
- `updater_logs_tail(max_lines: usize) -> Result<String, String>`: opens the current daily `argus.log` file, reads from the end backwards using `rev_lines` (or a simple `BufReader` + seek-from-end with line counting), filters to lines containing `updater` (we standardize on the `target=updater` field which `tracing-subscriber`'s default formatter renders as `updater:` in the line), and returns the last `max_lines` matching lines joined with `\n`.
- `updater_logs_reveal() -> Result<(), String>`: opens the log directory in the OS file manager. macOS: `Command::new("open").arg(&log_dir)`. Linux: `xdg-open`. Windows: `explorer`. No plugin needed.

Modal UI: `UpdaterLogsDialog.tsx` mounts on demand, calls `updater_logs_tail({ maxLines: 200 })`, renders the result in a `<pre>` with monospace font (per `DESIGN.md`), shows three buttons: **Refresh**, **Reveal in Finder**, **Copy**. The dialog is opened by a new dropdown item **"View update logs…"** that is always visible (so users can debug even when no update is detected).

**Why**: avoids a live-stream complexity tax; a snapshot is enough to debug "the button doesn't work" because the relevant events are already in the file by the time the user opens the modal. Filtering in Rust keeps the renderer text size bounded (~200 lines × ~200 chars = 40KB max).

**Edge case**: log file may not exist yet (first run in dev with no `RUST_LOG`). Return an empty string + a hint line like `"(no updater events recorded yet — see app log dir for details)"`. Modal renders that as a placeholder.

### D6. Always-on file logging in release; opt-in in debug

**Choice**: Keep current behavior — release builds always write to `argus.log`; debug builds write to stderr only. Do NOT introduce file logging in debug by default (would clutter dev machines). Devs needing to test the logs viewer can `RUST_LOG=info pnpm tauri dev`, but we don't gate behavior on it.

**Why**: the logs viewer needs to work on shipped builds, which it does today. Dev-time logging strategy is not the bug.

### D7. Surface user-visible errors via a toast, not a modal

**Choice**: When `updater_install_and_restart` returns `Err`, the renderer shows a non-blocking toast (we already have a toast/notification primitive — verify in the design system; if not, render a small inline error chip under the dropdown trigger labeled "Install failed — view logs" that opens the logs modal directly). On success, the process is gone before any UI feedback is needed.

**Why over alternatives**:
- *Modal dialog on failure*: too heavy; install failures are common (no network, intermittent R2) and should not interrupt the user. A toast that links to "View update logs…" gives the user a path forward.
- *Silent log + dropdown badge*: doesn't tell the user "you clicked and it failed"; they'd think the button is broken (the current bug).

If no toast primitive exists yet in the codebase, we add an inline error chip on the `VersionIndicator` trigger button (color: error red per DESIGN.md, small text, 5s auto-dismiss). Decision deferred to implementation; either is acceptable.

## Risks / Trade-offs

- **[`RunEvent::ExitRequested` hangs quit]** → 10s timeout on `install().await` using `tokio::time::timeout`; on timeout, `tracing::error!` and call `app.exit(0)` anyway. User loses the update on this quit but the next periodic check re-downloads it.
- **[Moving check/download into Rust breaks current renderer state machine]** → Keep renderer scheduling (5s, 4h). The Rust command returns serializable metadata (`{ version, body, date }`); renderer maps it to `availableVersion` / `pendingVersion` state. The `Update` handle stays in Rust state.
- **[Log tail reads a large file slowly]** → Read from the end using a fixed 64KB chunk and reverse-line iterate; cap at 200 lines. Files rotate daily via `tracing-appender::rolling::daily`, so the active file rarely exceeds a few MB.
- **[Filter on `updater` substring catches false positives]** → Use the `target=updater` discipline strictly in every event we emit; filter on lines containing the literal `updater:` (tracing's default format renders `target` as a leading bracketed segment). Acceptable false-positive rate is ~0 because no other module uses `updater` in its target.
- **[`open`/`xdg-open`/`explorer` not present]** → Fail soft: log a warning and return `Err("cannot reveal log folder — open it manually at <path>")` so the renderer can show the path in the toast.
- **[Renderer-driven `logUpdater` floods IPC]** → Cap to ~20 events per session per category. Each updater state transition fires one event; periodic checks fire one event per check.
- **[Existing `install-update-restart-button` change is not archived yet]** → This change MODIFIES requirements added by that change. Sequencing: assume the prior change lands first (it's already merged on master via PR #28 — commit `894a7ff`); when this change archives, the requirements unify cleanly.
- **[Mid-session relaunch loses unsaved query buffers]** → Same trade-off as the prior change accepted. Not re-litigated.

## Migration Plan

1. Land Rust changes (new `platform/updater/` module, new commands, `RunEvent` hook) behind the existing capability — no schema or config change required.
2. Land renderer changes: switch `UpdaterProvider` to invoke the new commands; add `UpdaterLogsDialog`; add the dropdown item.
3. Cut a beta release (`v0.1.9-beta.0` or similar) via existing R2 pipeline. Manually verify on a fresh macOS box: install old version → publish new version → wait for detection → click "Install update & restart" → confirm relaunch onto new version. Repeat for the quit-time path.
4. Cut production `v0.1.9` only after both paths verified. No rollback needed — the new commands are additive; the renderer falls back to the old path only if we re-introduce the old code, which we are deleting.

## Open Questions

- Does the codebase already have a toast/notification primitive, or do we add an inline error chip? **Resolution**: check during implementation; either is acceptable per D7.
- Should the logs modal also offer to copy the user's app version + OS + commit SHA alongside the log text for support bundles? **Probably yes**, low cost — add a "Copy diagnostics" button that prepends a header block. Mark as a stretch goal in tasks.
