## 1. Pin the cold-start window size

- [x] 1.1 In `packages/app/src-tauri/tauri.conf.json`, set the `manager` window to the canonical fixed size: `width: 760`, `height: 600`, and `resizable: false`.
- [x] 1.2 Remove or align `minWidth`/`minHeight` for the `manager` window so they match the fixed size (irrelevant once non-resizable; keep equal to 760/600 if a value is required). — Removed both lines.

## 2. Pin the recreation window size

- [x] 2.1 In `packages/app/src-tauri/src/platform/open_connections.rs`, update `ensure_manager_window` builder to `.inner_size(760.0, 600.0)` (match `tauri.conf.json`).
- [x] 2.2 Change `.resizable(true)` to `.resizable(false)` in `ensure_manager_window`; remove or align `.min_inner_size(...)` to the fixed size. — Removed `.min_inner_size(...)`.

## 3. Stop window-state from overriding the fixed size

- [x] 3.1 Confirm the `skip`/denylist API available in the locked `tauri-plugin-window-state` version (check `Cargo.lock` / plugin docs). — v2.4.1 supports `.with_denylist(&[..])`.
- [x] 3.2 In `packages/app/src-tauri/src/lib.rs:187`, configure `tauri_plugin_window_state` so the `manager` window's size is not persisted/restored (per-window skip preferred; fall back to dropping the SIZE flag globally only if per-window skip is unavailable, noting the Workspace trade-off). — Used `.with_denylist(&["manager"])`; Workspace untouched.

## 4. Verify

- [x] 4.1 Cold start: Manager opens at exactly 760×600 with no resize handles.
- [x] 4.2 Close and reopen the Manager: it reopens at 760×600 and is not resizable.
- [x] 4.3 On a profile that already has saved window state (e.g. an old 1280×800), launch the app and confirm the Manager opens at 760×600, not the persisted size.
- [x] 4.4 Confirm the Workspace window is still resizable and still reopens at its last persisted size.
- [x] 4.5 Visually confirm the `ManagerShell` layout (header, search, connection list, footer) fits at 760×600 without clipping; list scrolls if content overflows.
