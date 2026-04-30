## Why

Jumping between tables today requires expanding connection → schema in the sidebar tree and clicking the relation. With many connections open, or schemas with hundreds of relations, that friction adds up. TablePlus solves this with ⌘P: a fuzzy-search picker scoped to tables/views in memory, separate from the generic command palette. We want the same affordance in Argus.

## What Changes

- New ⌘P hotkey opens a dedicated table quick-switcher palette, distinct from the existing ⌘K command palette.
- Quick-switcher indexes tables, views, and materialized views across **all active connections**, not just the focused one.
- On first open, the switcher eager-loads `listRelations` for every loaded schema in every active connection (columns stay lazy). Subsequent opens are instant; new schema/relation data flows in reactively as the cache updates.
- Recently opened relations appear in a "Recent" group at the top, capped at 10, persisted in `localStorage`.
- Each row shows: kind glyph (`T` table / `V` view / `M` materialized view) · `schema.table` · connection name. Connection is always shown (no conditional disambiguation).
- Activation rule: Enter (or click) opens the relation via the existing `openObjectTab` flow, which already deduplicates by tab id. No ⌘+Enter "new tab" shortcut.
- Empty state when zero connections are active: a hint pointing the user to open a connection.
- Refactor: extract a shared `PaletteShell` primitive from the existing `Palette.tsx` so command-palette and table-quick-switcher share the same `cmdk` + Radix Dialog scaffold, tokens, and keyboard behavior. No observable behavior change to ⌘K.

## Capabilities

### New Capabilities
- `table-quick-switcher`: dedicated keyboard-first picker for jumping to any relation across active Postgres connections, with recents, eager schema indexing, and disambiguated display.

### Modified Capabilities
<!-- None. The Palette.tsx refactor is internal — observable command-palette behavior is unchanged. -->

## Impact

- **Affected code**:
  - `src/platform/command-palette/Palette.tsx` and `Palette.module.css` — extract shared `PaletteShell`.
  - `src/platform/command-palette/` — add `TablePalette.tsx`, `useTableIndex.ts`, `useRecentTables.ts`.
  - `src/modules/postgres/schema/globalSchemaCache.ts` — expose a subscribe/snapshot API if not already reactive enough for the index hook.
  - `src/modules/postgres/schema/openObjectTab.ts` — call site from `TablePalette`; may need a `recordRecent(entry)` hook.
  - `src/App.tsx` — register ⌘P binding alongside ⌘K.
- **No backend / Tauri command changes**: this is pure UI on top of existing schema-loading commands.
- **Storage**: new `localStorage` key (e.g., `argus.recentTables`) holding ≤10 serialized entries.
- **Hotkey conflicts**: ⌘P confirmed free in current bindings; Tauri intercepts before browser print.
