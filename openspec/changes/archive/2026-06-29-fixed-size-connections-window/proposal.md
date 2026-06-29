## Why

The Connection Manager window (label `manager`) currently opens at two different sizes depending on how it is created — `tauri.conf.json` declares 760×600 at cold start, while the Rust recreation path (`ensure_manager_window`) builds it at 1280×800 — and it is user-resizable with its geometry persisted across sessions by `tauri-plugin-window-state`. The result is an inconsistent, unpredictable window. The Manager is a compact, list-oriented surface (brand header, search, connections list, footer) that does not benefit from arbitrary resizing; it should always open at one deliberate, fixed size.

## What Changes

- The Connection Manager window opens at a single, fixed size from every creation path (cold start and recreation after close).
- The Manager window is made **non-resizable** (`resizable: false`), so its dimensions cannot be changed by the user.
- The two divergent size sources are reconciled to one canonical value (`tauri.conf.json` and `ensure_manager_window` in `open_connections.rs` must agree).
- The Manager window is excluded from window-state **size** persistence so a previously-restored geometry can never override the fixed size. (Position persistence may be retained.)
- The Workspace window is unaffected — it remains resizable with persisted geometry.

## Capabilities

### New Capabilities
<!-- None — this adjusts existing window behavior. -->

### Modified Capabilities
- `dual-window-shell`: Adds a requirement that the Connection Manager window has a fixed, non-resizable size applied consistently across all creation paths and not overridden by persisted window state. The Workspace window's resizable behavior is unchanged.

## Impact

- `packages/app/src-tauri/tauri.conf.json` — manager window `width`/`height`, `resizable`, remove/adjust `minWidth`/`minHeight`.
- `packages/app/src-tauri/src/platform/open_connections.rs` — `ensure_manager_window` builder (`inner_size`, `min_inner_size`, `resizable`).
- `packages/app/src-tauri/src/lib.rs` — `tauri_plugin_window_state` registration, to exclude the `manager` window (or the SIZE state flag) from size persistence.
- No frontend changes expected; `ManagerShell` layout is already fully responsive within whatever fixed size is chosen.
