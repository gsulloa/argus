## Context

The Connection Manager window (`manager`) is created from two independent code paths that disagree on size:

- **Cold start** — declared in `packages/app/src-tauri/tauri.conf.json`: `width: 760`, `height: 600`, `minWidth: 520`, `minHeight: 420`, `resizable: true`.
- **Recreation after close** — `ensure_manager_window` in `packages/app/src-tauri/src/platform/open_connections.rs:232-238`: `inner_size(1280.0, 800.0)`, `min_inner_size(800.0, 500.0)`, `resizable(true)`.

In addition, `tauri-plugin-window-state` is registered globally in `packages/app/src-tauri/src/lib.rs:187` with default flags, so it persists and restores **size and position** for every window — including `manager`. Even if both builders agreed, a user's prior resize would be restored on next launch, overriding the intended size.

The `ManagerShell` React UI (`packages/app/src/platform/shell/ManagerShell.tsx`) is fully responsive (flexbox, `width/height: 100%`, scrollable list) and imposes no pixel dimensions, so it adapts to whatever fixed size the window is given.

## Goals / Non-Goals

**Goals:**
- The Manager window opens at one deliberate, fixed size from every creation path.
- The user cannot resize the Manager window.
- Persisted window state can never override the fixed size.
- The change is confined to the Tauri/Rust window layer; no frontend changes.

**Non-Goals:**
- Changing the Workspace window — it stays resizable with persisted geometry.
- Redesigning the Manager UI/layout.
- Making the size responsive to display size or DPI (a single fixed value is intended).

## Decisions

### Canonical fixed size: 760 × 600
Adopt the `tauri.conf.json` value (760×600) as the single source of truth and update `ensure_manager_window` to match. Rationale: the Manager is a compact list surface; 760×600 already fits its header/search/list/footer comfortably, and it is the size users see at first launch today. The 1280×800 recreation value appears to be a copy of the Workspace window builder and is oversized for a connections list. (If product prefers a different value, change it in both places — the two must stay in sync.)

### Make the window non-resizable
Set `resizable: false` in `tauri.conf.json` and `.resizable(false)` in the Rust builder. With a non-resizable window, `minWidth`/`minHeight`/`min_inner_size` become irrelevant; drop or align them to the fixed size. Alternative considered: keep it resizable but reset to fixed size on each open — rejected because it contradicts "fixed size" and produces a jarring snap-back.

### Exclude the Manager from size persistence
Configure `tauri_plugin_window_state` so the `manager` window's **size** is never restored. Two viable approaches:

1. **Per-window skip (preferred):** keep the plugin's default flags for the Workspace, but skip the `manager` label from state save/restore (e.g. via the plugin's `skip` configuration or by not restoring the manager's geometry). This preserves position-restore for the Workspace and keeps the Manager pinned to its declared size.
2. **Drop the SIZE flag globally:** register the plugin with `StateFlags::all() - StateFlags::SIZE`. Simpler, but it also stops the Workspace from remembering its size, which is a regression for that window.

Choose approach 1 (manager-scoped) so the Workspace behavior is untouched. The exact plugin API (`with_denylist`/`skip_initial_state`/manual filtering) is confirmed during implementation against the installed `tauri-plugin-window-state` version. A non-resizable window combined with a fixed `inner_size` already prevents user-driven size drift; excluding it from persistence is the belt-and-suspenders guarantee that a stale saved state (from before this change) can't reapply an old size.

## Risks / Trade-offs

- **Stale persisted state from before this change** → On first launch after upgrade, a previously saved 1280×800 (or user-resized) geometry could still be on disk. Excluding `manager` from size restore (Decision 3) neutralizes this; verify on a profile that already has saved state.
- **Plugin API mismatch across versions** → The skip/denylist API differs between `tauri-plugin-window-state` versions. Mitigation: confirm the available API in the locked Cargo version before coding; fall back to approach 2 (drop SIZE flag) only if per-window skip is unavailable, and document the Workspace trade-off if so.
- **Fixed size too small on some content/locale** → 760×600 must still fit the header, search, longest connection rows, and footer without clipping. Mitigation: the list area is independently scrollable, so vertical overflow degrades gracefully; spot-check at 760×600.
- **Non-resizable windows on small displays** → On very small screens 760×600 could be larger than the viewport. Acceptable: it exceeds typical minimums and matches today's cold-start size; out of scope to special-case.

## Migration Plan

1. Update `tauri.conf.json` manager window: set fixed `width`/`height`, `resizable: false`, drop or align `minWidth`/`minHeight`.
2. Update `ensure_manager_window` to the same `inner_size`, `.resizable(false)`, drop/align `min_inner_size`.
3. Adjust `tauri_plugin_window_state` registration to exclude the `manager` window's size from persistence.
4. Manually verify: cold start size, recreation-after-close size, resize handles absent, and that an existing saved-state profile does not reopen at the old size.

Rollback: revert the three files; no data migration or schema involved.

## Open Questions

- Confirm the final fixed dimensions with product (default proposed: 760×600).
- Confirm the exact `tauri-plugin-window-state` API for per-window size exclusion in the locked version.
