## Context

`TabContent` (`src/platform/shell/tabs/TabContent.tsx`) renders only the **active** tab — `tabs.find((t) => t.id === activeTabId)` and `<Renderer tab={active} />`. Inactive tabs are not in the DOM at all; switching tabs unmounts the previous tab's component subtree. As a consequence every `useState` inside `TableViewerTab` is reset on tab-switch return: `orderBy`, `draft`, `applied`, the inspector width, the selected row, even the count. The bar's `Reset` button is *not* the only path to an empty filter — tab switching is, too.

The fix is to hoist the state out of the component into a per-`(connectionId, schema, relation)` cache that survives unmount. Argus already has the right primitive: `useSetting` (`src/platform/settings/useSetting.ts`) is an in-memory cache + debounced disk-write hook used by `usePageSize` to keep per-table page-size preferences across tab switches *and* across app restarts. Page size and filter share the same key shape, the same lifetime requirements, and the same "manual change only" semantics — so the same lane fits.

The original `table-filter-bar` change called persistence "out of scope (call out)" because it punted on saved/named filter recipes. This change is the narrow follow-up: implicit per-table memory, no UI for managing it.

## Goals / Non-Goals

**Goals:**
- Filter (`draft` and `applied`) is preserved when the user switches tabs and returns to the table.
- Filter survives closing the tab and reopening it for the same `(connection, schema, relation)`.
- Filter survives an app restart (free, given `useSetting`'s disk pipeline).
- Reset is *only* triggered by explicit user gestures: the bar's `Reset` button, the BottomBar's `Clear filters` chip.
- `orderBy` follows the same persistence pattern (parity with filter — same UX problem, same fix).
- No backend / wire-shape changes.

**Non-Goals:**
- A saved/named filter library or any UI to recall/share filter recipes.
- Garbage-collecting persisted entries for relations that have been dropped. The `useSetting` memory cache is unbounded; we accept this for now (same as `pgTableLimit:*`).
- Auto-rewriting / pruning persisted filters when the schema changes (column rename, type change). Surface the Postgres error as today.
- Cross-connection sharing of filters. Two connections to the same `<schema>.<relation>` keep independent state, matching `usePageSize`.
- Persisting the bar's collapsed/expanded state, the inspector width, or the selected row — out of scope here.
- Persisting the *mode toggle* state (Structured vs Raw) independently; it travels with the model, so it persists for free.

## Decisions

### D1: Reuse `useSetting` as the persistence pipeline

**Decision:** Add `useTableFilter(connectionId, schema, relation)` and `useTableOrderBy(connectionId, schema, relation)` hooks that delegate to `useSetting<FilterModel>` and `useSetting<OrderBy[]>` respectively, with stable keys:

```
pgTableFilter:${connectionId}:${schema}:${relation}
pgTableOrder:${connectionId}:${schema}:${relation}
```

**Rationale:** `useSetting` already provides:
- A memory cache shared across mounts (so unmount → remount within a session is instant).
- Debounced disk persistence (150 ms) via the existing `getSetting` / `setSetting` Tauri commands.
- A no-op fallback for non-Tauri runtimes (jsdom tests).

`usePageSize` is the existing template for "per-table preference" — copying that shape makes the change boring and reviewable.

**Alternatives considered:**
- *Module-level `Map<key, FilterModel>` (in-memory only):* Tab switches would survive, but app restarts would not. The user phrased "nunca lo resetees" — the strongest reading is "across restarts too". Disk persistence is one line of glue beyond the in-memory case.
- *React Context provider at the app root:* Solves tab switches but not restarts; also creates a re-render hot path on every filter keystroke (any consumer re-renders).
- *Lift state into a Tabs-level state map (`activeTabId → FilterModel`):* Tied to tab identity, not relation identity. Closing and reopening the same table generates a new tab id and would still reset.

### D2: Persist `draft` AND `applied` separately

**Decision:** Both halves of the bar's draft/applied dichotomy persist to disk independently. The hook returns `{ draft, applied, setDraft, setApplied, reset }` and writes each setter through to its own settings key. Or — simpler — store the pair as one record:

```jsonc
// pgTableFilter:<conn>:<schema>:<relation>
{
  "draft":   { "mode": "structured", "tree": { ... }, "raw": "" },
  "applied": { "mode": "structured", "tree": { ... }, "raw": "" }
}
```

We pick the "one record" form so the two halves stay coherent — never a half-written disk state where `applied` is loaded but `draft` is the empty default.

**Rationale:** A user who's mid-edit (typing into an unapplied draft row) and switches tabs expects to come back to that exact draft, not to lose their typing because only `applied` was kept. Persisting `draft` is what makes "never reset unless I ask" complete.

**Trade-off:** Writes happen twice as often (every keystroke into the bar updates `draft`). The 150 ms `useSetting` debounce + the in-memory cache keep this off the disk hot-path; the cost is one Tauri IPC per quiescence window. Acceptable.

**Alternatives considered:**
- *Persist only `applied`:* Tab-switch-mid-edit silently drops the user's typing. Half-fixes the complaint.
- *Persist `applied` to disk and `draft` to memory only:* More moving parts, draft would still be lost on app restart — partial regression vs the "one record" form.

### D3: First-mount race — render with empty model, swap on load

**Decision:** On first mount, the hook returns `EMPTY_FILTER_MODEL` synchronously (the same default `useState<FilterModel>(EMPTY_FILTER_MODEL)` returns today). The disk read is async. When the read completes, the hook swaps in the persisted value and re-renders.

**Rationale:** This is what `useSetting` already does (see `useSetting.ts` lines 16–50). It avoids blocking the first paint and is consistent with `usePageSize` behavior.

**Trade-off:** The data grid will issue *one* spurious first-page fetch with `applied = empty`, then re-issue once the persisted `applied` lands. For typical filters this is two queries instead of one on the first table open. Mitigation: gate the initial fetch on a `loaded` flag from the hook; if the persisted value is non-empty, skip the empty-applied fetch entirely. This is a small extension to `useSetting` (expose an `isLoaded` flag), or we can compute it inside `useTableFilter` by tracking a ref.

**Alternatives considered:**
- *Block the first render until the disk read resolves:* Adds a flash of "Loading…" in front of every table open, even when no filter is persisted (the common case). Net negative.
- *Synchronously read the disk on first mount via a Tauri sync IPC:* Tauri IPC is async; not an option.

### D4: Manual reset is the *only* clear path; document it

**Decision:** The persisted record is cleared *only* when the user invokes:
- `Reset` button in the filter bar (clears `draft` AND `applied`).
- `Clear filters` chip in the BottomBar (same effect).

Tab switches, tab close, app restart, switching connections, even editing the table all leave the filter intact. Schema drift surfaces as a Postgres error — not a silent reset.

**Rationale:** This is the user's stated invariant. Anything that auto-resets (e.g., on schema drift) violates it.

**Trade-off:** A persisted filter referencing a since-renamed column will fail loudly every time the user opens the table until they fix or reset it. The bar already surfaces such errors inline (Raw mode) or via the existing first-load error banner (Structured mode); the user's only options are Reset or Open in SQL Editor → fix.

**Alternatives considered:**
- *Auto-prune predicates that reference unknown columns on load:* Too magic — the user would silently lose filters they intended to keep. Skip.
- *Surface a "filter references missing column" toast on load with a "Reset" affordance:* Reasonable v1.5; for v1, the existing error path is enough.

### D5: Apply same persistence to `orderBy`

**Decision:** Add a sibling hook `useTableOrderBy(connectionId, schema, relation)` keyed on `pgTableOrder:${connectionId}:${schema}:${relation}` with default `[]`. Same lane, same lifecycle.

**Rationale:** `orderBy` has the identical UX problem — switching tabs resets the sort. The user's mental model ("the table remembers what I did") covers sort too. The cost is one extra `useSetting` call.

**Trade-off:** A persisted sort might reference a missing column after a schema change. Same Postgres-error UX as filters — surface, don't auto-prune.

**Alternatives considered:**
- *Defer `orderBy` to a follow-up:* Splits one user-facing bug into two changes for no real reason. Bundle.
- *Combine filter + orderBy into one record:* Cohesive on disk but couples two semi-orthogonal concerns; `useSetting` is keyed atomically, so two records is cleaner.

### D6: Don't persist UI-only state

**Decision:** The bar's collapsed/expanded toggle, the inspector width, the selected row, the count, the truncated columns, the edit buffer — none of these persist. Only `draft`, `applied`, and `orderBy` cross the disk boundary.

**Rationale:** UI-only state has a lifetime tied to the *view*, not the *table*. A user who collapses the bar on Tab A doesn't expect Tab B to remember that collapse — they're different views. Filters and sort, by contrast, *are* the table's "what am I looking at".

(`Inspector width` is already persisted via `useInspectorWidth`, but per-app, not per-table — keep that lane.)

## Risks / Trade-offs

- **Memory cache unboundedness in `useSetting`** → Mitigation: same shape as `pgTableLimit:*` already in use; an LRU pass is independent and out of scope. Worst case: an Argus session that has touched 10,000 tables holds 10,000 `FilterModel` records (~10 KB each ≈ 100 MB worst case). Realistic usage is orders of magnitude smaller.
- **Schema drift produces persistent loud errors** → Mitigation: existing error UX (inline or banner) + the bar's `Reset` button + the new ability to "Open in SQL Editor" to inspect what's failing. Spec scenario covers it.
- **First-mount disk race causes a spurious empty fetch** → Mitigation: D3's `isLoaded` flag — skip the initial fetch until persisted state has loaded; if the persisted state is empty, the deferred fetch fires immediately after load. Net: one fetch in all cases, same as today.
- **`draft` writes amplify disk traffic** → Mitigation: `useSetting`'s 150 ms debounce. A user typing into a value input writes once per quiescence, not once per keystroke.
- **Two tabs on the same `(conn, schema, relation)` would share state** → Argus already prevents opening two tabs for the same target (the schema browser focuses an existing tab on second-click). If a path through the code does open a duplicate, both tabs would mirror the same persisted value, which is the expected behavior.
- **Concurrent writes from two app windows** → Tauri 2 supports multi-window; an unlikely race since both windows would write the same key. `useSetting`'s "last write wins" behavior is acceptable.
- **Settings file growth over time** → Each persisted record is ~1–10 KB JSON. After hundreds of distinct relations, the settings file grows but stays well under any practical limit.

## Migration Plan

This change is a UI-state hoisting refactor with no wire-format changes. There is nothing to migrate at the user level — existing in-flight filters live in tab-local `useState` and are already lost on tab switch. After this change, filters set in the new code persist forward; there is no backfill required.

Rollback is a `git revert`.

## Open Questions

- **Should we expose a debug/QA "Clear all persisted filters" gesture?** A user with a corrupted filter (e.g. they stored something that breaks the bar's render) currently has no way out other than clearing app data. Likely deferred — `Reset` per table is the immediate escape hatch; a "Clear all" command-palette action is a v1.5 nicety.
- **Should `useTableFilter` debounce `setDraft` more aggressively than `useSetting`'s 150 ms?** A power user's typing produces ~5–10 keystrokes per quiescence; 150 ms feels right. If we measure write-flush jank we can bump.
- **Should the persisted record include a schema version number for future-proofing?** Defer — `FilterModel` is small and any future schema shift can use a "best-effort decode, fall back to empty" pattern at load time.
