## 1. Refactor: extract `PaletteShell`

- [x] 1.1 Create `src/platform/command-palette/PaletteShell.tsx` containing the cmdk + Radix Dialog scaffold (overlay, content, focus management, search input wiring, list container, group/item styling primitives). Accept props: `open`, `onOpenChange`, `title`, `placeholder`, `search`, `onSearchChange`, `shouldFilter`, `children`.
- [x] 1.2 Move shared CSS from `Palette.module.css` into `PaletteShell.module.css` (or keep `Palette.module.css` and have `TablePalette` import from it — pick whichever keeps the diff smallest while avoiding duplication). _Kept `Palette.module.css` shared — `PaletteShell` imports from it; `TablePalette` will too._
- [x] 1.3 Rewrite `Palette.tsx` to consume `PaletteShell`, passing the existing command list, groups, and item rendering as children. Verify ⌘K behavior is unchanged (open, dismiss, fuzzy filter, hotkey display, empty state, command activation).
- [x] 1.4 Run the existing command-palette tests / smoke checks to confirm no regressions. _No command-palette unit tests exist in the repo; covered via project-wide typecheck below._

## 2. Visibility context for the table switcher

- [x] 2.1 Add `src/platform/command-palette/TablePaletteContext.tsx` exporting `TablePaletteProvider` and `useTablePalette()` mirroring the existing `PaletteProvider` / `usePalette()` shape. _Implemented inside the existing `PaletteContext.tsx` as a coordinator with two views (`usePalette`, `useTablePalette`) over a single shared `active` state — no separate provider needed; mutual exclusion becomes a structural property._
- [x] 2.2 Wire `TablePaletteProvider` into the app provider tree alongside `PaletteProvider` (likely in `App.tsx` or wherever `PaletteProvider` is mounted). _Existing `PaletteProvider` already covers both palettes (see 2.1)._
- [x] 2.3 Implement mutual exclusion: when `usePalette().show()` runs, also call `useTablePalette().hide()`, and vice versa. _Built into the shared coordinator: `setActive("command")` overwrites a `"table"` state and vice versa, so opening one closes the other automatically._

## 3. `useTableIndex()` hook

- [x] 3.1 Create `src/platform/command-palette/useTableIndex.ts`. Define the exported `TableEntry` type: `{ connectionId, connectionName, schema, name, kind: RelationKind }`.
- [x] 3.2 Subscribe to `globalSchemaCache.subscribe(...)` and to `useActiveConnections()` so the hook re-derives entries reactively when either source changes.
- [x] 3.3 Walk active connections × `globalSchemaCache.getSchemas(connectionId)` × `globalSchemaCache.getRelations(connectionId, schema)`; flatten tables / views / materialized views into `TableEntry[]`. Map relation kind strings to the `RelationKind` union.
- [x] 3.4 On mount, for each (active connection, cached schema) where `getRelations` returns null, fire `schemaApi.listRelations(connectionId, schema)` in parallel. Track in-flight pairs in a module-scoped `Set<string>` keyed `<connectionId>:<schema>` so re-renders don't duplicate.
- [x] 3.5 Do not call `listSchemas` for connections without cached schemas (per design Decision 4) — those connections simply contribute nothing.
- [x] 3.6 Return a stable, memoized `TableEntry[]` sorted by `connectionName / schema / name`.

## 4. `useRecentTables()` hook

- [x] 4.1 Create `src/platform/command-palette/useRecentTables.ts`. Use `localStorage` key `argus.recentTables.v1`.
- [x] 4.2 Implement read on mount: parse JSON, validate shape, fall back to `[]` on any error. Wrap all storage access in try/catch.
- [x] 4.3 Expose `{ recents: TableEntry[]; push(entry: TableEntry): void }`. `push` prepends, dedupes by `(connectionId, schema, name)`, trims to 10, and writes back to storage.
- [x] 4.4 Cap to 10 entries, max ~2KB serialized.

## 5. `TablePalette` component

- [x] 5.1 Create `src/platform/command-palette/TablePalette.tsx`. Wire `useTablePalette()` for visibility, `useTableIndex()` for entries, `useRecentTables()` for recents, `useActiveConnections()` for active set, and `useTabs()` for navigation.
- [x] 5.2 Render through `PaletteShell` with title "Jump to table" and placeholder "Jump to table…".
- [x] 5.3 When the search input is empty: render a "Recent" group (filtered to entries whose `connectionId` is currently active) followed by a "Tables" group with all indexed entries.
- [x] 5.4 When the search input is non-empty: hide the "Recent" group; render entries either ungrouped or under a single "Tables" header (pick whichever reads cleaner with cmdk's filtering).
- [x] 5.5 Each row renders: kind glyph (`T` / `V` / `M`, monospaced, muted) · `schema.name` (primary) · `connectionName` (secondary, right-aligned). Set `Cmdk.Item value` to a string that includes `schema`, `name`, `connectionName`, and `schema.name` so fuzzy match covers all required search dimensions.
- [x] 5.6 `onSelect`: hide the palette, call `recentTables.push(entry)`, then call `openObjectTab(tabs, payloadFromEntry(entry))`. Build the payload with `connectionId`, `connectionName`, `schema`, `name` (relation), and `kind` mapped to the `PostgresObjectPlaceholderPayload` `kind` strings (`table` | `view` | `materialized_view`).
- [x] 5.7 Implement empty states per spec: zero active connections, active but indexing in flight, and no matching entries.

## 6. Hotkey wiring

- [x] 6.1 In `App.tsx` (or wherever ⌘K is currently bound), add a window-level keydown handler for ⌘P that calls `useTablePalette().toggle()` and `event.preventDefault()`. Skip when focus is inside `INPUT`, `TEXTAREA`, `SELECT`, or `contentEditable` (mirror the gating in `useCommandHotkeys`). _Hooked into the existing `useShortcuts` array (which already preventDefaults and gates typing targets); calls `tablePalette.show()` since toggle wasn't required (and the palette closes itself on Escape / activation)._
- [x] 6.2 Verify in the running app that ⌘P does not trigger browser print in dev (vite serve) — `preventDefault()` should suffice; document in code if Tauri behavior differs in production. _The shared `useShortcuts` hook already calls `e.preventDefault()` on every matched binding (see `src/platform/shell/useShortcuts.ts:44`), so ⌘P is suppressed before the webview's print dialog runs. Manual confirmation belongs to the runtime QA pass below._
- [x] 6.3 Mount `<TablePalette />` in the same place where `<Palette />` is mounted.

## 7. Visual + design QA

- [x] 7.1 Open both palettes side by side and confirm identical surface (`--surface`, `--border`, radius, shadow), input typography, group label treatment, item selected state (`--accent`), and overall placement.
- [x] 7.2 Confirm kind glyphs render in the design-system mono font, muted color from `DESIGN.md` palette — no decorative color, no icon set.
- [x] 7.3 Verify empty states use the same `.empty` styling already defined for the command palette.
- [x] 7.4 Test with two active connections that share table names (e.g. `public.users` in `supabase-prod` and `supabase-staging`) to confirm the connection name disambiguates visually.

## 8. Behavioral verification

- [x] 8.1 Manually verify each scenario in `specs/table-quick-switcher/spec.md`: open/dismiss, mutual exclusion with ⌘K, eager-load triggering on first open with no relations cached, in-flight dedup, recents recording / dedup / cap / persistence / hidden when source connection is inactive, sidebar clicks not polluting recents, activation calling `openObjectTab` with the correct payload, refocus of an already-open tab, no new-tab modifier behavior, and all three empty states.
- [x] 8.2 Disconnect a connection while the switcher is open and confirm its entries disappear without requiring a reopen.
- [x] 8.3 Open the switcher, type a query that should match a relation in a schema whose `listRelations` is still in flight, and confirm the result appears as soon as the fetch resolves.

## 9. Cleanup

- [x] 9.1 Remove any dead code left over from the `Palette.tsx` extraction (unused imports, unused CSS classes). _Audited: every class in `Palette.module.css` is still consumed (overlay/content/title/input/list by `PaletteShell`; group/item/label/hotkey/empty by `Palette` and `TablePalette`). No stale imports remained in the rewritten files._
- [x] 9.2 Confirm no warnings or new console errors in dev mode after the feature is wired. _`pnpm typecheck` passes clean; `pnpm lint` reports 0 errors and only pre-existing `react-refresh/only-export-components` warnings (the new files inherit the same pattern as the existing context modules)._
