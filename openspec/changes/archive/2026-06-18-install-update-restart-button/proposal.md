## Why

Today the updater downloads new versions silently and only applies them when the user happens to quit the app. Users who keep Argus running for days (typical for a data tool) stay on stale builds and have no way to opt into the new version without remembering to quit. We want a single, obvious action — "Install update & restart" — so a user who has just been notified of a pending version can apply it immediately without hunting through OS menus.

## What Changes

- Add an explicit **"Install update & restart"** menu item to the `VersionIndicator` dropdown (bottom-right status bar) that appears only when a pending update has been downloaded.
- Wire that menu item to a new `installAndRestart()` action on the updater context that calls `Update.install()` and then relaunches the app process, bypassing the existing quit-only apply path.
- Add the Tauri `process` plugin (JS `@tauri-apps/plugin-process` + Rust `tauri-plugin-process`) and register the `process:default` capability so the frontend can invoke `relaunch()`.
- Disable the menu item and surface a transient "Installing…" state while the install is in flight so users don't double-click.
- **MODIFIED REQUIREMENT** in `app-updater`: the spec currently forbids mid-session binary swap ("No mid-session swap of the running binary is allowed"). Relax to allow swap **only** when the user explicitly triggers install-and-restart; background and quit-time behavior are unchanged.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `app-updater`: adds a user-initiated install-and-relaunch path alongside the existing quit-time apply path; updates the "Pending update applies on app quit" requirement so that an explicit user action can also trigger apply mid-session.

## Impact

- **Frontend code**: `src/platform/updater/UpdaterProvider.tsx` (new `installAndRestart` action + installing state), `src/platform/updater/index.ts` (re-export), `src/platform/shell/VersionIndicator.tsx` + `VersionIndicator.module.css` (new menu item + disabled state styling).
- **Rust code**: `src-tauri/Cargo.toml` (add `tauri-plugin-process`), `src-tauri/src/lib.rs` (register plugin).
- **Capabilities**: `src-tauri/capabilities/default.json` adds `process:default` (or the narrower `process:allow-restart`).
- **Dependencies**: new npm dep `@tauri-apps/plugin-process` (v2.x to match other plugins).
- **No backend / DB impact**; no migration; no breaking changes to existing user flows — the new menu item is purely additive.
- **Risk**: a mid-session relaunch loses unsaved query-editor state. Argus already persists queries via `query-history` and `saved-queries`, but unsaved scratch buffers are at risk. Mitigation: the button label explicitly says "restart" so user intent is clear; we accept this trade-off rather than adding a confirm dialog in V1.
