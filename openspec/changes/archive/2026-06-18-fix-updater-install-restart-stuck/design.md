## Context

Argus uses `tauri-plugin-updater` v2 with a two-path apply model defined in `app-updater` spec:

1. **Quit-path** (`apply_pending_on_exit` in `commands.rs:122`) — runs from `RunEvent::ExitRequested` in `lib.rs:218`, installs the binary, then exits. No relaunch — the user reopens the app manually.
2. **Button-path** (`updater_install_and_restart` in `commands.rs:72`) — runs as a Tauri command from a frontend button click, installs the binary, then calls `app.restart()` to relaunch.

Both paths share `UpdaterState { pending: Mutex<Option<PendingUpdate>>, installing: AtomicBool }` to coordinate against each other (the spec requires "whichever runs first wins, and the second observes the empty state and is a no-op").

The `ExitRequested` handler today has two intercepting branches:
- `has_pending && !installing` → apply on quit, then `app.exit(0)`.
- `installing` → `prevent_exit()`, busy-wait up to 10 s for `installing` to clear, then `app.exit(0)`.

The button-path success branch calls `app.restart()`, which internally raises an exit request that goes through this same handler. By the time the handler fires, `installing == true` (set at `commands.rs:79`) and `pending == None` (consumed at `commands.rs:88`). The handler enters the second branch, calls `prevent_exit()` — which cancels the restart — and busy-waits for a flag that the success path never clears. After 10 s it calls `app.exit(0)`, which exits without relaunching. The user perceives this as "stuck": UI frozen on "Installing…" for ~10 s, then the app silently dies.

The quit-path works because `apply_pending_on_exit` is called *inside* the handler (after `prevent_exit`), runs to completion, and then the handler explicitly calls `app.exit(0)`. No relaunch is involved, so the bug doesn't manifest.

## Goals / Non-Goals

**Goals:**
- The "Install update & restart" button actually relaunches the app on success.
- The fix is local: only touches the updater module and `lib.rs` exit handler.
- The double-invocation guarantees in the existing spec ("guarded against double-invocation", "whichever runs first wins") are preserved.
- The fix is observable from `updater_logs_tail` so a tester can confirm it triggered.

**Non-Goals:**
- Reworking the two-path apply model. The spec already commits to button-path *and* quit-path.
- Frontend changes. `installAndRestart()` in `UpdaterProvider.tsx:160` already correctly treats post-`invoke` as unreachable on success.
- Adding download progress, retries, or any UX beyond fixing the hang.
- Windows-specific install behaviour. We are targeting the macOS beta build that exhibits the bug; Tauri's `app.restart()` semantics are the same across platforms but we explicitly test on macOS.

## Decisions

### Decision 1: Add a `relaunching: AtomicBool` flag instead of clearing `installing`

The simplest patch would be to clear `state.installing` immediately before `app.restart()`. With `installing == false && has_pending == false`, the exit handler falls through both branches and the restart proceeds.

**Rejected** because it weakens the existing guarantee in the spec's "User quits while install is in progress" scenario:

> the `ExitRequested` hook observes the pending state is already taken (or that an install is in flight) and does NOT initiate a second `install()` call; the in-progress install completes once and the app restarts cleanly

If we clear `installing` before `app.restart()`, a user-quit that races with the restart could enter the handler in a state where both flags are false and neither branch matches — the handler then allows a clean exit but loses its ability to wait for the in-flight install. In practice this is unlikely (`app.restart()` is the next statement after `install()` returns) but the semantics get muddier.

**Chosen:** add a dedicated `relaunching: AtomicBool`. The button-path success branch sets `relaunching = true` *and* clears `installing = false` immediately before `app.restart()`. The exit handler checks `relaunching` first; if true, it returns without touching `api` (no `prevent_exit`), so the restart proceeds. The two flags have distinct meanings (`installing` = "an install call is in flight"; `relaunching` = "we asked Tauri to restart, please don't intercept"), which keeps the logic readable.

**Alternative considered:** use a one-shot `tokio::sync::Notify` or oneshot channel. Overkill — the exit handler runs synchronously inside `block_on` and only needs a non-blocking boolean read.

### Decision 2: Exit handler checks `relaunching` first, returns early without `prevent_exit`

```rust
if let RunEvent::ExitRequested { api, .. } = event {
    let state = app_handle.state::<UpdaterState>();
    if state.relaunching.load(Ordering::Acquire) {
        tracing::info!(target: "updater", "relaunch_allowed_by_exit_handler");
        return; // do nothing — let Tauri's restart sequence proceed
    }
    let installing = state.installing.load(Ordering::Acquire);
    let has_pending = tauri::async_runtime::block_on(async {
        state.pending.lock().await.is_some()
    });
    // ... existing branches unchanged ...
}
```

Returning without calling `prevent_exit` is the contract for "allow this exit". Tauri's `app.restart()` then runs its native relaunch sequence.

### Decision 3: Do not reset `relaunching` after `app.restart()`

`app.restart()` does not return on success — the process is replaced. If it ever fails and returns, the next quit in the same session would skip the pending-install-on-quit logic. Acceptable because:

- In practice `app.restart()` on macOS does not return after a successful binary swap.
- If it did return, the install has already completed (pending is empty), so there is no pending update to lose.
- The freshly launched process starts with `relaunching = false` (default), so future sessions are unaffected.

### Decision 4: Emit a `relaunch_allowed_by_exit_handler` log event

The bug is invisible from the user's side (just "stuck"). Adding a single tracing event makes the fix verifiable in `updater_logs_tail`:

- **Before fix:** logs show `install_started` → `install_complete` → `relaunch_invoked` → (10 s gap) → process dies. No `relaunch_allowed_by_exit_handler`.
- **After fix:** logs show `install_started` → `install_complete` → `relaunch_invoked` → `relaunch_allowed_by_exit_handler` → new process emits its own startup events.

## Risks / Trade-offs

- **[Risk]** `relaunching` is set after `install()` succeeds. If `app.restart()` panics or returns with an error before triggering the exit handler, the flag stays `true` forever in this session. **Mitigation:** in practice `app.restart()` does not return; if it ever did, the next user-quit would skip the pending-install-on-quit branch but there *is* no pending update at that point (we consumed it), so the impact is nil.

- **[Risk]** Race between `app.restart()` and a concurrent user-quit. If the user hits ⌘Q in the exact window between `state.installing.store(false)` and `app.restart()`, the exit handler runs with `relaunching=false, installing=false, has_pending=false` and allows a normal exit, losing the restart. **Mitigation:** set `relaunching = true` *before* clearing `installing`, so any quit that fires between the two writes still sees an intercepting state (and the spec's existing "in-flight install" branch handles it). The window between the two atomic writes is nanoseconds.

- **[Trade-off]** Adding a second AtomicBool to `UpdaterState` is mild state-management bloat for what could be a one-liner fix. Chose this for the spec-clarity reason in Decision 1.

- **[Risk]** Tauri may change `app.restart()` semantics in a future minor version (e.g., not raising `ExitRequested`). If so, the `relaunching` short-circuit becomes dead code but does no harm. **Mitigation:** the log event surfaces this — if `relaunch_allowed_by_exit_handler` stops appearing after a Tauri upgrade, we'll know the handler is no longer the gatekeeper.

## Migration Plan

No data migration. Pure code change in three Rust files. Ship in the next beta release; users get the fix the first time they install-and-restart from a build that contains this patch (the *currently* installed buggy build will still hang on the last hop, but the new build inside it will be working — i.e., the fix takes effect on the second update after this release ships).

## Open Questions

None. Decision tree is fully resolved by reading the existing handler and command code.
