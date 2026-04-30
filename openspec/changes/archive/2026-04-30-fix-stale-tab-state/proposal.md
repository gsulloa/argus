## Why

After shipping `persist-filter-per-table`, two bugs surfaced:

1. **Filter state bleeds across tables.** Switching between two open tabs of different `(connectionId, schema, relation)` triples shows the *previous* tab's filter on the new tab. Root cause: `TabContent` only renders the active tab via `<Renderer tab={active} />` with no `key`, so when the active tab is another `postgres-table-data` tab, React reuses the same `TableViewerTab` instance — and `useSetting`'s `useState` initializer never re-runs, so its `value` is stuck at the previous key's data.

2. **"Open in SQL Editor" lands on an empty editor.** Clicking the button opens a `postgres-query` tab whose CodeMirror editor mounts with empty text, even when the table viewer has a non-empty applied filter. Root cause: `useQueryBuffer`'s unmount cleanup writes `JSON.stringify("")` to its settings key, and under React 18 StrictMode (enabled in `main.tsx`) the dev double-mount fires that cleanup *before* the second mount's `getSetting` read — so the second mount reads back `""` and overrides the prefilled SQL passed via `payload.sql`.

The user's invariant — "the filter belongs to this table, never reset unless I ask" — is violated by bug 1. The "Open in SQL Editor" affordance is the bar's only escape hatch into raw SQL, and bug 2 makes it unusable.

## What Changes

- **Fix `useSetting` key-change semantics.** When `key` changes between renders, the hook MUST re-derive `value` from the per-key memory cache (or default) and reset `loaded` to match the new key's load state. Currently the hook only re-runs the disk-load effect; it never updates `value` for the new key.
- **Fix `useQueryBuffer` StrictMode double-mount.** The unmount cleanup MUST not wipe a buffer that was just seeded by `payload.sql`. The contract "closing a tab discards the buffer" stays — but only on a *real* close, not on a strict-mode replay.
- Add regression tests covering both: (a) `useSetting` round-trip across a key change with no further setter calls, (b) `useQueryBuffer` survives a StrictMode mount→cleanup→mount cycle without losing the prefilled SQL.

## Capabilities

### New Capabilities
_(none — this change fixes existing capabilities.)_

### Modified Capabilities
- `postgres-data-grid`: tightens the per-relation persistence requirement so the bar's `draft` / `applied` / `orderBy` MUST update synchronously when the active relation changes, not stay frozen on the previous relation's value.
- `postgres-query-editor`: tightens the prefilled-SQL contract so `payload.sql` MUST land in the editor on first paint, even under StrictMode dev double-mount.

## Impact

**Frontend**
- `src/platform/settings/useSetting.ts` — detect key changes during render and re-seed `value` / `loaded` from memory cache; the existing async load effect already keys on `[key]` and doesn't need to change.
- `src/modules/postgres/sql/useQueryBuffer.ts` — replace the unmount-time "drop the buffer" with a tab-close-driven drop using the existing `registerCloseHandler` / `shouldCloseTab` registry (or a sibling "after-close" hook). The unmount cleanup MUST still flush in-flight write timers but MUST NOT clobber the persisted value with `""`.

**Backend**
- No changes.

**Tests**
- New unit test for `useSetting`: change `key` between renders, assert `value` swaps to the new key's cached value (or default).
- New unit test for `useQueryBuffer`: render under `<React.StrictMode>` with a non-empty fallback, assert the editor receives the fallback after the strict-mode replay.
- Add a `TableViewerTab` component test for the relation-change scenario: render with `(conn, schema, A)`, apply a filter, rerender the same instance with `(conn, schema, B)`, assert the filter bar is empty (no bleed).

**Out of scope (call out)**
- Garbage-collecting persisted buffers from closed Query tabs — separate change.
- Refactoring `TabContent` to add `key={active.id}` on the renderer — possible alternative fix for bug 1, but it would also reset tab-local state we want to keep (edit buffer, selected row). The `useSetting` fix is the surgical path.
- The `compileWhere` SQL output itself — it's correct; the bug is upstream (`applied` is stale, or the prefilled SQL is wiped post-render).
