## Why

The "Install update & restart" button gets stuck: when the user clicks it, the UI shows "Installing…" indefinitely and the app eventually dies without relaunching. Updates applied via the quit-and-reopen path work fine, which proves the install itself is healthy — the bug is specific to the user-triggered button flow.

Root cause: `updater_install_and_restart` sets `installing = true`, runs `install()` to completion, then calls `app.restart()`. But `app.restart()` triggers `RunEvent::ExitRequested`, and the exit handler observes `installing == true && has_pending == false` (the pending was already consumed by the install). It enters the "in-flight install" branch, calls `api.prevent_exit()` — cancelling the restart — and then busy-waits up to 10 s for `installing` to clear. The success path never clears that flag, so the handler times out and calls `app.exit(0)`, which exits the process without relaunching.

## What Changes

- Make `updater_install_and_restart` cooperate with the `ExitRequested` handler so the restart actually completes:
  - Introduce a new `relaunching: AtomicBool` flag on `UpdaterState`.
  - In the success branch, set `relaunching = true` and clear `installing = false` immediately before calling `app.restart()`.
  - On the error branch, leave `relaunching = false` (unchanged) and continue to restore the pending update and clear `installing` as today.
- Update the `RunEvent::ExitRequested` handler in `lib.rs` to short-circuit and allow the exit/restart to proceed (no `prevent_exit`, no busy-wait) when `relaunching == true`. Order of checks: `relaunching` first, then the existing `has_pending && !installing` and `installing` branches.
- Add an updater log event `relaunch_allowed_by_exit_handler` so the log trail shows the handler correctly recognised the relaunch and let it through.
- No frontend changes are required — `installAndRestart()` already assumes the process disappears on success and treats any caught error as a failure.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `app-updater`: the "User can apply pending update without quitting", "Install-and-restart is guarded against double-invocation", and "Pending update applies on app quit" requirements all need new scenarios covering the relaunch-vs-exit-handler interaction. The contract that "`app.restart()` actually relaunches the app" is currently violated.

## Impact

- **Affected files (Rust):**
  - `src-tauri/src/platform/updater/mod.rs` — add `relaunching: AtomicBool` to `UpdaterState`.
  - `src-tauri/src/platform/updater/commands.rs` — `updater_install_and_restart` success branch sets `relaunching` / clears `installing` before `app.restart()`.
  - `src-tauri/src/lib.rs` — `RunEvent::ExitRequested` handler checks `relaunching` first and returns early without calling `prevent_exit`.
- **Affected files (frontend):** none.
- **APIs:** no public command signature changes.
- **Dependencies:** none.
- **Risk:** the `relaunching` flag is one-shot per process lifetime. If `app.restart()` ever returns instead of restarting (unexpected on macOS), the flag stays `true` and any subsequent quit would skip the pending-install-on-quit path. Mitigation: this only matters if the user has a *new* pending update queued in the same session after the failed restart, which is impossible in practice (the check timer is 4 h and the binary is mid-swap). Acceptable.
- **Observability:** new `relaunch_allowed_by_exit_handler` log event makes the fix verifiable in `updater_logs_tail`.
