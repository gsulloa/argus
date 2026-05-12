## 1. Add Tauri `process` plugin

- [x] 1.1 Add `tauri-plugin-process = "2"` to `src-tauri/Cargo.toml` under `[dependencies]` (matching the version style of `tauri-plugin-updater = "2"`).
- [x] 1.2 Register the plugin in `src-tauri/src/lib.rs` with `.plugin(tauri_plugin_process::init())` alongside the existing updater plugin registration.
- [x] 1.3 Add `"process:allow-restart"` to the `permissions` array in `src-tauri/capabilities/default.json` (do NOT add `process:default` or `process:allow-exit`).
- [x] 1.4 Run `cargo build` inside `src-tauri/` to confirm the plugin compiles and the capability is recognized.

## 2. Add JS plugin dependency

- [x] 2.1 Add `@tauri-apps/plugin-process` to `package.json` `dependencies` at the same `^2.x` major as `@tauri-apps/plugin-updater`.
- [x] 2.2 Run the project's package manager install command to update the lockfile.
- [x] 2.3 Verify the import `import { relaunch } from "@tauri-apps/plugin-process"` type-checks.

## 3. Extend `UpdaterProvider` with install-and-restart action

- [x] 3.1 In `src/platform/updater/UpdaterProvider.tsx`, import `relaunch` from `@tauri-apps/plugin-process`.
- [x] 3.2 Add `isInstalling: boolean` and `installAndRestart: () => Promise<void>` to the `UpdaterCtx` type.
- [x] 3.3 Add a React state `isInstalling` (default `false`) inside `UpdaterProvider`; reuse the existing `installingRef` as the synchronous guard shared with the `beforeunload` handler.
- [x] 3.4 Implement `installAndRestart`:
  - Early-return if `!isTauriRuntime()`, `pendingRef.current` is null, or `installingRef.current` is true.
  - Set `installingRef.current = true` and call `setIsInstalling(true)`.
  - In a try/catch: `await pendingRef.current.install()` then `await relaunch()`.
  - On error: `console.debug("[updater] install-and-restart failed:", err)`, reset `installingRef.current = false`, `setIsInstalling(false)` so the user can retry.
- [x] 3.5 Include `isInstalling` and `installAndRestart` in the `useMemo` for the context value and its dependency array.
- [x] 3.6 Confirm the existing `beforeunload` handler still no-ops when `installingRef.current` is already true (it does today via `if (!update || installingRef.current) return`).

## 4. Wire the menu item into `VersionIndicator`

- [x] 4.1 In `src/platform/shell/VersionIndicator.tsx`, extend `VersionIndicatorViewProps` with `isInstalling: boolean` and `onInstallAndRestart: () => void`.
- [x] 4.2 Render a new `<DropdownMenu.Item>` immediately above the "Skip" item, gated by `pendingVersion !== null`. Label: `Installing…` when `isInstalling` is true, otherwise `Install update & restart`.
- [x] 4.3 Set the item's `disabled` prop to `isInstalling` (Radix supports `disabled` on `DropdownMenu.Item`); on `onSelect`, call `onInstallAndRestart()` and prevent default close when `isInstalling` so the dropdown doesn't snap shut mid-action.
- [x] 4.4 Update the connected `VersionIndicator()` wrapper to pass `isInstalling={ctx.isInstalling}` and `onInstallAndRestart={() => { void ctx.installAndRestart(); }}`.
- [x] 4.5 Add a `.disabled` style (or reuse an existing one) in `VersionIndicator.module.css` for the disabled-item visual; keep it subtle (lower opacity), no spinner.

## 5. Manual verification

Manual QA — run by Gabriel after merge.

- [ ] 5.1 Build a beta DMG, install it, then publish a newer build to the R2 endpoint and let the running app pick it up via the periodic check.
- [ ] 5.2 Confirm the version label shows `vX → vY` and the new menu item appears.
- [ ] 5.3 Click "Install update & restart"; confirm the item becomes "Installing…" and disabled, the app relaunches, and the relaunched window's status bar shows the new version as current.
- [ ] 5.4 Test rapid double-click: only one install runs; second click is a no-op while in flight.
- [ ] 5.5 Test failure path by temporarily breaking signature verification (or simulating via dev override): the action surfaces no modal, the item resets from "Installing…" back to "Install update & restart", and the pending update is still applied on quit.
- [ ] 5.6 Test no-pending state: with no update available, open the dropdown and confirm the "Install update & restart" item is not rendered.

## 6. Spec & docs

- [x] 6.1 Run `openspec validate install-update-restart-button` and confirm it passes.
- [ ] 6.2 After merge, run `/opsx:archive install-update-restart-button` to fold the delta into `openspec/specs/app-updater/spec.md`.
