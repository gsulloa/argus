## Why

When users press ⌘P and search for a table by typing the start of its name (e.g. `order`), they expect the relation whose name *is* or *starts with* the query (`client.order`) to win over relations that merely contain the query as a substring (`client.assistant_manual_pending_orders`). Today the quick switcher delegates filtering entirely to cmdk's default `command-score` fuzzy scorer, which is unaware that an entry's value is a hierarchical `schema.name` identifier — so unrelated substring matches frequently outrank the obvious exact / prefix hits and the palette feels broken (issue #55).

## What Changes

- Replace the default cmdk fuzzy filter for the **table quick switcher** with a deterministic tiered scorer that ranks candidates by what part of the entry the query matched and how (exact > prefix > substring), evaluated on the relation **name** first, then **schema-qualified name**, then **schema**, then **connection**.
- Fall back to cmdk's existing fuzzy score only as a tie-breaker among entries that share the same tier (so non-prefix, non-substring matches still surface, just below structured matches).
- Keep the search input semantics identical for two-segment queries like `auth.us` — a `schema.fragment` query MUST keep prioritising entries whose schema matches `auth` exactly and whose name starts with `us`.
- Ranking is applied **only** to the table quick switcher (⌘P). The ⌘K command palette keeps cmdk's default scorer.
- Add the custom `filter` prop plumbing on `PaletteShell` so the table switcher can pass its scorer without affecting the command palette.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `table-quick-switcher`: tighten the "Fuzzy search across schema, name, and connection" requirement so ranking is deterministic — exact / prefix / substring matches on the relation name (and `schema.name` form) outrank fuzzy substring matches elsewhere.

(The `command-palette` (⌘K) spec is unchanged. The shared `PaletteShell` only gains an internal `filter` prop, which is an implementation detail not observable from the command-palette capability's requirements.)

## Impact

- `src/platform/command-palette/PaletteShell.tsx` — accept and forward an optional `filter` prop to the underlying `cmdk` root.
- `src/platform/command-palette/TablePalette.tsx` — pass a custom `filter` implementing the tiered scorer; ensure each `Cmdk.Item` value still encodes enough information (or carries data via a stable encoding) for the filter to recover `schema`, `name`, and `connectionName`.
- New helper module (e.g. `src/platform/command-palette/scoreTableEntry.ts`) holding the pure scoring function plus unit tests.
- Existing palette tests / fixtures referencing default cmdk ordering may need updates; no public API or persisted-state changes.
- No backend, DB, or IPC changes. No DESIGN.md changes.
