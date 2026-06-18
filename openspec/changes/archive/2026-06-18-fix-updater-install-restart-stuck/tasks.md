## 1. Rust state

- [x] 1.1 Add `pub relaunching: AtomicBool` field to `UpdaterState` in `src-tauri/src/platform/updater/mod.rs` and initialise it to `false` wherever `UpdaterState` is constructed (search for `UpdaterState {`)
- [x] 1.2 Confirm `std::sync::atomic::AtomicBool` is in scope in `mod.rs`; add the import if missing

## 2. Install-and-restart command

- [x] 2.1 In `src-tauri/src/platform/updater/commands.rs`, inside the `Ok(())` arm of `pending.update.install(&pending.bytes)` (around line 100), and BEFORE `app.restart()`: set `state.relaunching.store(true, Ordering::Release)` FIRST, then `state.installing.store(false, Ordering::Release)` SECOND. The order matters — see design.md decision 2/4 risk note about the inter-write race.
- [x] 2.2 Keep `tracing::info!(target: "updater", "relaunch_invoked")` immediately before `app.restart()` so the existing log order is preserved
- [x] 2.3 Do NOT touch the `Err(e)` arm — `relaunching` stays `false` and `installing` is already cleared there; the user can retry

## 3. ExitRequested handler

- [x] 3.1 In `src-tauri/src/lib.rs` inside the `RunEvent::ExitRequested` match arm (around line 219), immediately after loading the `UpdaterState` and BEFORE reading `installing` / `has_pending`, add a short-circuit: if `state.relaunching.load(Ordering::Acquire)` is true, emit `tracing::info!(target: "updater", "relaunch_allowed_by_exit_handler")` and `return` from the closure (do NOT call `api.prevent_exit()`, do NOT call `app_handle.exit(...)`)
- [x] 3.2 Verify the existing `has_pending && !installing` and `else if installing` branches are unchanged below the new short-circuit

## 4. Manual verification on macOS beta build

- [ ] 4.1 Build the beta binary: `pnpm tauri build -- --config src-tauri/tauri.beta.conf.json` (or whichever existing script the project uses for beta builds — check `package.json` scripts and the release pipeline spec)
- [ ] 4.2 Install a known-older beta on a test Mac, launch it, and wait for the in-app updater to download the new version (or use the "Check for updates now" action if available)
- [ ] 4.3 Click "Install update & restart" from the version dropdown; confirm the app actually relaunches into the new version within a few seconds (no 10 s hang, no silent exit)
- [ ] 4.4 Open the in-app logs viewer (or run `updater_logs_tail` from devtools) and confirm the trail contains, in order: `install_started` (trigger=user_action) → `install_complete` → `relaunch_invoked` → `relaunch_allowed_by_exit_handler`, then new-process startup events

## 5. Manual regression checks (quit-path still works)

- [ ] 5.1 With a fresh pending update, ⌘Q the app instead of using the button; confirm the next launch reports the new version and the log trail shows `install_started` (trigger=quit) → `install_complete` with NO `relaunch_invoked` / `relaunch_allowed_by_exit_handler` for that cycle
- [ ] 5.2 With NO pending update, ⌘Q the app; confirm it exits with no extra delay (no `prevent_exit` busy-wait, since `relaunching` and `installing` are both false)

## 6. Forced-error regression check

- [ ] 6.1 Simulate an install failure (e.g., briefly chmod the .app bundle to read-only, or temporarily corrupt the downloaded bytes via a debug toggle if one exists; otherwise rely on logs from a past install_failed event) and confirm the renderer shows the "Install failed — view logs" chip and the action becomes clickable again. Confirm `relaunching` was never set (no `relaunch_allowed_by_exit_handler` in logs)

## 7. Ship

- [ ] 7.1 Run the full Rust test suite if any exist (`cargo test` in `src-tauri/`) and the frontend type check / test suite
- [ ] 7.2 Update CHANGELOG and bump the patch VERSION via the project's standard release pipeline
- [ ] 7.3 Open the PR against `master` with a brief reproduction note ("install-and-restart hung at ~10 s because the `ExitRequested` handler called `prevent_exit` on `app.restart()`; added a `relaunching` flag to short-circuit the handler") and a link to the verification log trail from task 4.4
