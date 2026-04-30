## Context

Argus already ships a generic command palette: `Palette.tsx` (cmdk + Radix Dialog) driven by `CommandRegistry`, opened with ⌘K. Table navigation today goes through `SidebarTree` → expand schema → click relation, which routes via `openObjectTab(tabs, payload)`. Tables, views, and materialized views live lazily in `globalSchemaCache`, populated as the user expands schemas in the sidebar; the cache already exposes `subscribe()`, `getSchemas()`, `listAllRelations()`, and per-relation lookups. Active connections are tracked by `useActiveConnections()` and re-emit on the `postgres:active-changed` Tauri event.

The new ⌘P switcher needs the same overlay aesthetic and keyboard ergonomics as the command palette but indexes a different data source (relations across active connections) and adds a recents store. Building it as a fork of `Palette.tsx` would duplicate the cmdk/Dialog scaffold; building it as a new mode of `Palette.tsx` would couple two unrelated content domains.

## Goals / Non-Goals

**Goals:**

- Open a fuzzy-search picker via ⌘P that lists tables, views, and materialized views across every currently active Postgres connection.
- Make the picker feel instant on second open: results stream from the in-memory cache, no waiting on Tauri commands.
- On first open per session, eager-load `listRelations` for every loaded schema in every active connection so the picker is useful even before the user has clicked anything in the sidebar.
- Surface recently opened relations at the top, persisted across app restarts, capped at 10.
- Visually identical to the command palette (same `cmdk` scaffold, same tokens) so the muscle memory transfers.
- Selecting an entry must reuse the existing `openObjectTab` flow so dedup, tab IDs, and titles stay consistent with sidebar navigation.

**Non-Goals:**

- Indexing functions, sequences, types, extensions, indexes, or triggers — only `RelationKind` (table / view / materialized view).
- ⌘+Enter "open in new tab" affordance. Tab dedup is by `id`, and we want the picker to refocus existing tabs rather than spawn duplicates.
- Background pre-fetching of columns. Eager loading is scoped to the relation list; columns stay lazy via the existing bulk-fetch path.
- Support for inactive (closed) connections. If the user disconnects a connection, its relations drop out of the index immediately.
- A unified "search everything" experience that merges tables and commands. ⌘K and ⌘P stay distinct.

## Decisions

### Decision 1: Two palettes sharing a `PaletteShell`, not one palette with modes

Refactor `Palette.tsx` so the cmdk + Radix Dialog scaffold (overlay, content, focus management, search input, list container, group/item styling) lives in a `PaletteShell` primitive. `Palette` becomes the consumer for ⌘K (command-driven content), and a new `TablePalette` becomes the consumer for ⌘P (relation-driven content).

**Why:** The two surfaces share visuals and keyboard plumbing but have wildly different content sources, item shapes, and selection actions. A "mode" prop on a single component would force conditional logic at every rendering site (group sort, item value, onSelect, hotkey display, empty state copy). Two thin consumers wrapping a shared shell keeps each concern flat.

**Alternatives considered:** (a) Add a `mode: "commands" | "tables"` prop to `Palette`. Rejected — bloats one file with two unrelated render paths. (b) Register tables as commands in `CommandRegistry`. Rejected — the registry was designed for ~dozens of static commands; relations can be thousands and turn over per-connection, and we'd lose the grouping/recents UX without inventing escape hatches.

### Decision 2: A separate `usePalette`-style context for ⌘P

Add `TablePaletteProvider` + `useTablePalette()` mirroring the existing `PaletteProvider` / `usePalette()` pair. ⌘P toggles its own visibility flag; ⌘K still toggles the command palette.

**Why:** Visibility is the natural separator. It also lets us prevent both from being open at once via a small mutual-exclusion check at open time (closing the other if it's open).

**Alternatives considered:** Reuse `usePalette` with an enum mode. Rejected — same coupling problem as decision 1, and it leaks across files that only care about commands.

### Decision 3: `useTableIndex()` hook owns aggregation and eager-loading

Encapsulate three responsibilities in one hook:

1. Subscribe to `globalSchemaCache` (already exposes `subscribe`).
2. Subscribe to `useActiveConnections` for the active-connection set.
3. On first render after the picker opens, walk every active connection × every cached schema and fire `schemaApi.listRelations(...)` for any (connectionId, schema) that doesn't already have relations cached. Track in-flight requests to avoid duplicate fan-out across re-renders.

The hook returns a flat, stable `TableEntry[]`:

```ts
type TableEntry = {
  connectionId: string;
  connectionName: string;
  schema: string;
  name: string;
  kind: RelationKind; // "table" | "view" | "materialized-view"
};
```

Sorting is done by the consumer (alphabetical by `connection / schema / name`).

**Why:** The cache is already the source of truth; this hook is a thin reactive view over it. Consolidating eager-loading here keeps it from leaking into `TablePalette`'s render path. The hook is also reusable if we want a "search all tables" affordance elsewhere later.

**Alternatives considered:** (a) Push aggregation into `globalSchemaCache` itself. Rejected — the cache is currently storage-only and shouldn't grow IO behavior. (b) Eager-load only on first ever app open and persist. Rejected — the cache resets on disconnect/reconnect; per-session eager-load matches the actual data lifecycle.

### Decision 4: First-open eager load, not first-app-open

Eager loading triggers on each mount of `useTableIndex()` (which only mounts when the palette opens for the first time after dismount, or on app start if pre-mounted). We accept that closing and reopening the picker doesn't re-trigger fan-out, because the cache persists for the connection's lifetime.

We do not eager-load `listSchemas` for connections whose schema list isn't yet loaded. The user must have at least browsed the connection (which loads schemas) for it to contribute to the index. This matches "tables in memory" — a connection the user hasn't touched isn't really "in memory" yet.

### Decision 5: Recents in `localStorage`, mutated from `openObjectTab`

Add a `useRecentTables()` hook that reads/writes a `localStorage` key (e.g. `argus.recentTables.v1`). The hook exposes `{ recents, push(entry) }`. `push` prepends the entry, dedupes by `(connectionId, schema, name)`, and trims to 10.

`openObjectTab` itself doesn't know about recents — instead, `TablePalette`'s `onSelect` calls both `recordRecent(entry)` and `openObjectTab(...)`. This keeps the sidebar's existing path unchanged: clicking a relation in the sidebar tree does *not* update the recents list. Recents reflect "things you jumped to via ⌘P," which is the TablePlus model.

**Alternatives considered:** Track every tab open globally. Rejected — sidebar clicks would pollute recents with whatever the user happened to expand-and-click while exploring.

### Decision 6: Always show `schema.table · connection`, no conditional disambiguation

Every row renders the kind glyph, `schema.table` as the primary label, and the connection name on the right. No fuzzy logic to "hide the connection if there's only one." Consistency beats compactness here, and the connection name is also a useful search target ("supabase prod users").

The kind glyph is a single uppercase letter (`T` / `V` / `M`) in a fixed-width container, monospaced font, muted color — consistent with `DESIGN.md`'s anti-decorative stance.

### Decision 7: Selection always opens via existing `openObjectTab`, Enter only

`onSelect` constructs a `PostgresObjectPlaceholderPayload` from the entry and calls `openObjectTab(tabs, payload)`. The existing routing chooses `POSTGRES_TABLE_DATA_KIND` for relations. Tab dedup by id means selecting an already-open table refocuses it.

No ⌘+Enter "new tab" shortcut. We considered it but rejected it because (a) it conflicts with our dedup model — we'd need parallel tab IDs — and (b) TablePlus's ⌘P doesn't have it either.

### Decision 8: Empty state when zero active connections

Distinct from "no matches in search." When `useActiveConnections` reports zero items, the picker shows: "No active connections — open one to search tables" with a hint that ⌘K offers connection commands. We don't auto-open the connection picker; the user can still type to dismiss the empty state via Escape.

## Risks / Trade-offs

- **Eager `listRelations` fan-out cost** → Mitigation: parallel fan-out is bounded by `(active connections × loaded schemas)`. Active connections is typically 1–3; loaded schemas per connection is typically 1–10 in normal use. We use the existing `listRelations` IPC, which is already used by sidebar expansion. Track in-flight to avoid duplicate calls. If a single connection has hundreds of schemas (rare), we accept some startup latency on first ⌘P; partial results render as they stream in via `globalSchemaCache.subscribe`.

- **Stale recents pointing to dropped connections** → Mitigation: when rendering recents, filter out entries whose `connectionId` is not in the active set. Don't delete them from storage — the connection might come back. Show as "ghosted" or simply hide.

- **Recents include relations that no longer exist** (e.g., dropped table) → Mitigation: on selection, `openObjectTab` will create a tab whose viewer will fail to load. Acceptable for v1; the failure surface is the existing TableViewerTab error path. We don't preflight recents against the cache because recents may reference schemas not currently loaded.

- **⌘P and ⌘K both open** → Mitigation: when one opens, close the other in its `show()` handler.

- **Large result sets (10k+ relations) in cmdk** → Mitigation: cmdk handles large lists via virtualization-friendly DOM. If perf degrades in practice, swap the list container to a virtualized renderer behind the same shell. Not an upfront concern.

- **`localStorage` quota / corruption** → Mitigation: wrap reads/writes in try/catch, fall back to in-memory only if unavailable. Cap to 10 entries means storage size is trivial (<2KB).

- **Hotkey collision with browser print** → Web build (vite dev server) might print on ⌘P. Tauri intercepts before the webview, so production is fine. Add `preventDefault()` in the keydown handler regardless for dev-server hygiene.

## Migration Plan

No data migration; no breaking changes to existing palettes, commands, or tab system. Refactor `Palette.tsx` → `PaletteShell` + `Palette` in a single commit so command palette regressions can be caught immediately. Add `TablePalette`, hooks, and ⌘P binding incrementally on top.

## Open Questions

- Should we surface a small "Schemas" group below "Tables" so the user can jump to expand-a-schema in the sidebar? Out of scope for v1 — revisit if the picker grows beyond relations.
- Should the kind glyph be color-coded by `RelationKind` (subtle muted hues) or strictly monochrome? Defer to design taste once we see it rendered against `DESIGN.md` tokens.
