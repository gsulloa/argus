## 1. Rust: new `platform/updater` module + state

- [x] 1.1 Create `src-tauri/src/platform/updater/mod.rs` with `pub struct UpdaterState { pending: tokio::sync::Mutex<Option<tauri_plugin_updater::Update>>, installing: std::sync::atomic::AtomicBool }` and a `Default` impl
- [x] 1.2 Wire the module: add `pub mod updater;` to `src-tauri/src/platform/mod.rs`
- [x] 1.3 In `src-tauri/src/lib.rs::run()` `setup`, register state via `app.manage(platform::updater::UpdaterState::default());`
- [x] 1.4 Add `tokio` as an explicit `Cargo.toml` dependency if not already present (we need `tokio::time::timeout`); otherwise rely on the Tauri-vendored tokio re-export

## 2. Rust: updater commands

- [x] 2.1 Create `src-tauri/src/platform/updater/commands.rs` with the command shells, return-type structs, and `serde` derives
- [x] 2.2 Implement `#[tauri::command] async fn updater_check_and_download(app: AppHandle, state: State<'_, UpdaterState>) -> Result<Option<UpdateInfo>, String>` — calls `app.updater()?.check().await`, on `Some` calls `update.download().await`, stores the `Update` in `state.pending`, returns `UpdateInfo { version, body, date }`
- [x] 2.3 Implement `#[tauri::command] async fn updater_install_and_restart(app: AppHandle, state: State<'_, UpdaterState>) -> Result<(), String>` — guards via `state.installing` CAS; takes the `Update` out of `state.pending`; logs `install_started { trigger: "user_action" }`; runs `update.install().await`; logs `install_complete`; logs `relaunch_invoked`; calls `app.restart()` (does not return)
- [x] 2.4 On install error in 2.3: log `tracing::error!`, put the `Update` back into `state.pending`, release the `installing` flag, return `Err(human_readable_message)`
- [x] 2.5 Implement `apply_pending_on_exit(app: AppHandle, state: &UpdaterState)` — non-`#[command]` helper used by the `RunEvent::ExitRequested` hook; runs the same install path as 2.3 but **without** `app.restart()`; wraps install in `tokio::time::timeout(Duration::from_secs(10), ...)`; on timeout logs `error` and returns `Err`
- [x] 2.6 Implement `#[tauri::command] fn log_updater_event(level: String, msg: String, fields: Option<serde_json::Value>) -> Result<(), String>` — maps `"info" | "warn" | "error"` to the corresponding `tracing::event!` macro call with `target: "updater"`; unknown level falls back to `info`; serializes `fields` into the event as a JSON string field
- [x] 2.7 Register all three `#[command]`s in `tauri::generate_handler!` in `lib.rs::run()`

## 3. Rust: `RunEvent::ExitRequested` hook

- [x] 3.1 In `lib.rs::run()`, switch from `.run(...)` to `.build(...)?` + `app.run(|app_handle, event| { ... })`
- [x] 3.2 In the closure, match `RunEvent::ExitRequested { api, .. }`: read `app_handle.state::<UpdaterState>()`; if `state.pending` contains a value AND `state.installing` is false, call `api.prevent_exit()`, spawn a `tauri::async_runtime::block_on(apply_pending_on_exit(...))`, then call `app_handle.exit(0)`
- [x] 3.3 If `state.installing` is true (user-triggered install already running), call `api.prevent_exit()` and `block_on` a 10s wait for the in-flight install to settle, then exit
- [x] 3.4 If `state.pending` is empty, do nothing — let the default exit proceed

## 4. Rust: logs tail + reveal commands

- [x] 4.1 Implement `#[tauri::command] async fn updater_logs_tail(app: AppHandle, max_lines: usize) -> Result<String, String>` — locates the active `argus.log` in `app.path().app_log_dir()?` (current daily file; pick the newest `argus.log.*` if rotated, else `argus.log`); reads from end-of-file backwards using a 64KB chunk buffer; filters lines containing the literal `updater` (case-sensitive substring on the tracing target rendering); returns up to `max_lines` matching lines joined with `\n`; if file is missing or zero matches, returns `"(no updater events recorded yet)"`
- [x] 4.2 Cap `max_lines` to 1000 at the Rust side to bound memory
- [x] 4.3 Implement `#[tauri::command] fn updater_logs_reveal(app: AppHandle) -> Result<(), String>` — resolves the log dir; spawns `std::process::Command::new("open").arg(&log_dir)` on macOS, `xdg-open` on Linux, `explorer` on Windows; on spawn failure, returns `Err(format!("Log folder: {}", log_dir.display()))` so the renderer can show the absolute path
- [x] 4.4 Emit a `tracing::info!(target: "updater", "logs_revealed")` event on successful reveal
- [x] 4.5 Register both commands in `tauri::generate_handler!` in `lib.rs::run()`

## 5. Rust: ensure logging discipline

- [x] 5.1 Audit every `?` and `.unwrap_or_else` in the updater module to ensure errors emit `tracing::error!(target: "updater", error = %e, ...)` before bubbling
- [x] 5.2 Add `tracing::info!(target: "updater", "check_started")` at the top of `updater_check_and_download`
- [x] 5.3 Add `tracing::info!(target: "updater", available, version = ?v, "check_complete")` after the `check().await` returns
- [x] 5.4 Add `tracing::info!(target: "updater", version = %v, "download_started")` before `update.download().await` and `..., "download_complete"` after
- [x] 5.5 Verify `init_tracing` in `lib.rs` already includes `target` in the log line format (default `tracing-subscriber::fmt` shows target unless `.with_target(false)` was set). **Current code uses `.with_target(false)` — change to `.with_target(true)`** so the `updater` target appears in `argus.log` for filtering

## 6. Frontend: invoke new Rust commands from `UpdaterProvider`

- [x] 6.1 In `src/platform/updater/UpdaterProvider.tsx`, replace the direct imports of `check` and `Update` from `@tauri-apps/plugin-updater` with `invoke` from `@tauri-apps/api/core`
- [x] 6.2 Remove the `@tauri-apps/plugin-process` import; relaunch now happens in Rust
- [x] 6.3 Replace `runCheck`'s body to `await invoke<UpdateInfo | null>("updater_check_and_download")`; map the result to `availableVersion` + `pendingVersion` state; on null, no-op; on `Err`, log via `logUpdater("warn", "check_failed", { error })`
- [x] 6.4 Replace `installAndRestart`'s body to `await invoke("updater_install_and_restart")`; on success the process is gone; on `Err`, set a new `installError` state with the returned string and log via `logUpdater("error", "install_and_restart_failed", { error })`
- [x] 6.5 Delete the `beforeunload` `useEffect` entirely — the Rust `ExitRequested` hook owns quit-time apply now
- [x] 6.6 Add `installError: string | null` and `dismissInstallError: () => void` to `UpdaterCtx`; render-trigger via `useState`
- [x] 6.7 Remove the `pendingRef` and `installingRef` refs from this file — both responsibilities moved to Rust

## 7. Frontend: `logUpdater` helper

- [x] 7.1 Create `src/platform/updater/log.ts` exporting `logUpdater(level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>): void` that wraps `invoke("log_updater_event", { level, msg, fields })` and swallows errors (logging the updater shouldn't crash anything)
- [x] 7.2 Replace every `console.debug("[updater] ...")` site in `UpdaterProvider.tsx` with a `logUpdater(...)` call at the appropriate level
- [x] 7.3 Add `logUpdater("info", "user_skipped_version", { version })` in `skipPending`
- [x] 7.4 Add `logUpdater("info", "user_cleared_skip")` in `clearSkip`
- [x] 7.5 Add `logUpdater("info", "user_forced_check")` in `forceCheck`
- [x] 7.6 Re-export `logUpdater` from `src/platform/updater/index.ts`

## 8. Frontend: `UpdaterLogsDialog` modal

- [x] 8.1 Create `src/platform/shell/UpdaterLogsDialog.tsx` using `@radix-ui/react-dialog` for layout consistency with `VersionIndicator`'s About dialog; reuse `overlayStyles` from `Dialog.module.css`
- [x] 8.2 Component takes `{ open: boolean; onClose: () => void }`; on `open=true`, `useEffect` calls `invoke<string>("updater_logs_tail", { maxLines: 200 })` and stores the result in a `logs` state
- [x] 8.3 Render the logs inside a scrollable `<pre className={styles.logsPane}>` with monospace font per `DESIGN.md` (do not introduce new typography tokens — reuse what About uses)
- [x] 8.4 Add **Refresh** button — re-invokes `updater_logs_tail`
- [x] 8.5 Add **Reveal in Finder** button (macOS) / **Open log folder** (Linux/Windows) — invokes `updater_logs_reveal`; on `Err`, sets a fallback message containing the absolute path returned from the error
- [x] 8.6 Add **Copy** button — uses `navigator.clipboard.writeText(logs)`; on success, briefly swaps the label to "Copied" for 1.5s
- [x] 8.7 Add **Close** button using the standard footer button styling
- [x] 8.8 Call `logUpdater("info", "user_opened_logs_viewer")` when the dialog opens

## 9. Frontend: wire the "View update logs…" menu item

- [x] 9.1 In `src/platform/shell/VersionIndicator.tsx`, add a new `DropdownMenu.Item` labeled **"View update logs…"** rendered always (no `pendingVersion` gating); place it just above the existing `DropdownMenu.Separator` so it sits next to "About Argus"
- [x] 9.2 Add a `logsOpen` state in `VersionIndicatorView`; clicking the item sets `logsOpen=true`
- [x] 9.3 Render `<UpdaterLogsDialog open={logsOpen} onClose={() => setLogsOpen(false)} />` alongside the existing About dialog
- [x] 9.4 Ensure the dropdown closes when the item is selected (Radix default behavior — verify no `event.preventDefault()` interferes)

## 10. Frontend: surface install error to the user

- [x] 10.1 In `VersionIndicator.tsx`, consume `installError` and `dismissInstallError` from the updater context
- [x] 10.2 When `installError !== null`, render a small inline error chip below or next to the dropdown trigger; label: "Install failed — view logs"; clicking the chip opens `UpdaterLogsDialog` (sets `logsOpen=true`) and dismisses the chip via `dismissInstallError`
- [x] 10.3 Style the chip per `DESIGN.md` error token (read DESIGN.md, do not invent new colors)
- [x] 10.4 Auto-dismiss the chip after 10 seconds via a `useEffect` + `setTimeout` so the UI does not stay cluttered indefinitely

## 11. Capabilities + Cargo

- [x] 11.1 Verify `src-tauri/capabilities/default.json` still includes `process:allow-restart` (used by `app.restart()` in Rust — it's the same permission); add no other `process:*` permissions
- [x] 11.2 Confirm no new `opener` plugin is needed (we use `std::process::Command` directly for reveal-in-folder); if the team prefers `tauri-plugin-opener`, swap in that approach and add the capability
- [x] 11.3 Verify `@tauri-apps/plugin-process` is no longer imported anywhere in `src/`; if not, remove from `package.json` dependencies

## 12. Verification

- [ ] 12.1 Run `pnpm tauri dev` and confirm the dropdown shows "View update logs…" with no pending update
- [ ] 12.2 With `RUST_LOG=info pnpm tauri dev`, click "Check for updates now" and verify `argus.log` (in `app_log_dir()`) contains `check_started`, `check_complete` events tagged `target=updater`
- [ ] 12.3 Build a release archive (`pnpm tauri build --config tauri.beta.conf.json` or current beta path); publish a newer test version to the R2 endpoint; install the older version locally
- [ ] 12.4 Wait for periodic check; confirm pending badge appears; quit via ⌘Q; relaunch; confirm new version is running
- [ ] 12.5 Repeat the cycle: install older version → wait for pending → click "Install update & restart"; confirm app relaunches onto the new version automatically
- [ ] 12.6 Simulate failure: replace `latest.json` with a malformed manifest; trigger a check; confirm the app does not error in UI, logs viewer shows the `error`-tagged event, and the app continues running
- [ ] 12.7 Confirm "Reveal in Finder" opens the log directory on macOS
- [ ] 12.8 Confirm "Copy" places log text on the clipboard (paste-test in another app)
- [x] 12.9 Run `openspec validate fix-updater-and-add-logs-viewer --strict` and resolve any spec-format issues
