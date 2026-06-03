## Context

Three SQL engines (Postgres, MySQL, MSSQL) ship near-identical table viewers, but their filter-Apply plumbing diverged during the multi-engine rollout. The bug in #54 surfaces the divergence:

- **Postgres** owns `draft` and `applied` filter state in `TableViewerTab.tsx` via `useTableFilter`, and feeds `applied` into `useTableData` as a prop. `useTableData` rebuilds a `depsKey` (`connectionId | schema | relation | pageSize | orderKey | filtersKey`) from `JSON.stringify(applied)` and only refetches when the key changes (`src/modules/postgres/data/useTableData.ts:209`). There is no `refresh()` exposed. When the user clears a filter without committing and then re-applies the same value, `applied` is structurally identical → `filtersKey` unchanged → no refetch.
- **MySQL** and **MSSQL** own `filterModel` inside `useTableData` itself and expose a `refresh()` callback that the FilterBar's `onApply` calls directly (`src/modules/mysql/data/useTableData.ts:218-221`, `src/modules/mysql/data/TableViewerTab.tsx:547-552`; mirror for MSSQL at `:217-220` / `:638-647`). `refresh()` dispatches a `reset` and calls `fetchFirstPage()`, which **does** issue a new query — but the auto-fetch effect's `depsKey` guard (`depsKeyRef.current === depsKey`) skips the next render's fetch when the key is unchanged. In practice MySQL/MSSQL today already refetch via `refresh()` regardless of `filterModel` equality, but the relationship between `refresh()` and the auto-fetch effect is fragile: any future change that moves the network call into the effect would re-introduce the Postgres bug. We need to lock in the contract via spec + tests.

There is **no result cache** anywhere in the stack — confirmed in `src-tauri/src/modules/postgres/data.rs:818` and `src/modules/postgres/data/api.ts`. The bug is purely a missing refetch trigger.

Issue #54 reporter context: a colleague (Mati) created a row externally; the user couldn't see it after re-applying the same filter and assumed the row hadn't been created. Trust in the grid as a source of truth is the constraint we're protecting.

## Goals / Non-Goals

**Goals:**
- Pressing Apply (Apply All, ⌘↵, per-row Apply) ALWAYS refetches, on all three SQL engines, regardless of structural equality of the filter model.
- The fix is small, mechanical, and reuses the existing `depsKey`/`refresh()` infrastructure — no new abstraction.
- Existing scenarios (no-fetch-on-draft-edit, dirty-indicator behaviour, `Esc` not discarding, etc.) keep passing.
- Test coverage that would fail today and pass after the fix.

**Non-Goals:**
- Adding a backend result cache.
- Adding a separate top-level **Reload** button (tracked separately in #52).
- Making `Enter` apply the filter (tracked separately in #53).
- Touching DynamoDB or CloudWatch viewers (no row filter bar today).
- Refactoring Postgres to match MySQL's hook-owned model, or vice versa. We keep each engine's existing architecture and patch in place.

## Decisions

### Decision 1 — Postgres: introduce an `applyToken` in the deps key

**Choice:** Add an `applyToken: number` state in `TableViewerTab.tsx`, incremented in `onApplyFilters` and `onApplyOnlyRow` immediately after `setApplied(...)`. Pass it as a new prop to `useTableData`. Include it in `depsKey`.

```ts
// TableViewerTab.tsx
const [applyToken, setApplyToken] = useState(0);
const onApplyFilters = useCallback(() => {
  const enabledRows = draft.rows.filter((r) => r.enabled && isCompleteRow(r));
  setApplied({ rows: enabledRows, combinator: draft.combinator });
  setApplyToken((t) => t + 1);
}, [draft, setApplied]);
const onApplyOnlyRow = useCallback((index: number) => {
  const row = draft.rows[index];
  if (!row) return;
  setApplied({ rows: [row], combinator: draft.combinator });
  setApplyToken((t) => t + 1);
}, [draft, setApplied]);

// useTableData
const depsKey = `${connectionId}|${schema}|${relation}|${pageSize}|${orderKey}|${filtersKey}|${applyToken}`;
```

**Alternatives considered:**
- **Expose `refresh()` from Postgres's `useTableData` and call it from the Apply handlers** (mirroring MySQL). Rejected because Postgres's `useTableData` uses `useReducer`-style buffer state and a captured `depsKeyRef` for cancellation identity — exposing an imperative `refresh()` that bypasses the cancellation identity would need careful re-engineering of how `lastDepsKeyRef` is advanced. The `applyToken` approach reuses the existing dependency-driven reset path verbatim.
- **Use `Date.now()` as the token.** Rejected — non-deterministic, hostile to tests, slightly racier if two Applies fire in the same tick.
- **Hash a nonce into the `applied` object.** Rejected — pollutes the wire shape that gets passed to `postgres_query_table` (would need stripping somewhere, easy to forget).

**Why `setApplyToken` after `setApplied`:** Both updates land in the same React batch, so `depsKey` changes exactly once. Even if `setApplied` is a no-op (structural equality), `setApplyToken` guarantees the key advances.

### Decision 2 — MySQL/MSSQL: harden `refresh()` to always fetch

**Choice:** Keep the existing `tableData.refresh` wiring on FilterBar's `onApply`. Inside `useTableData.refresh()`, ensure the function does NOT depend on the `depsKey` guard — i.e. `refresh()` directly calls `dispatch({ type: "reset" })` and `fetchFirstPage()` without going through the auto-fetch effect. Verify and add a comment locking the contract.

The current implementation (`src/modules/mysql/data/useTableData.ts:218-221`) already does this:
```ts
const refresh = useCallback(() => {
  dispatch({ type: "reset" });
  void fetchFirstPage();
}, [fetchFirstPage]);
```

We add a regression test asserting `refresh()` triggers a fresh `queryTable` call even when `filterModel` is unchanged, and document the contract inline so a future refactor doesn't accidentally route `refresh()` through the `depsKey` effect.

**Alternatives considered:**
- **Mirror the Postgres `applyToken` approach in MySQL/MSSQL.** Rejected — adds an input prop where the existing `refresh()` already does the right thing. Smallest diff wins.
- **Move MySQL/MSSQL to the Postgres pattern.** Rejected — much larger refactor, not justified by the bug.

### Decision 3 — Spec the requirement explicitly per engine

**Choice:** Add an `ADDED Requirements` delta to each of the three data-grid specs ("Filter Apply always refetches") rather than `MODIFIED Requirements` on the existing "Filter draft and applied state" requirement.

**Rationale:** The new behaviour is a refinement that doesn't contradict any existing scenarios. `ADDED` keeps the delta focused and avoids the (large, expensive) full-content copy that `MODIFIED` requires. Each engine gets its own delta because each engine's spec is a separate document.

### Decision 4 — Test surfaces

For each engine:
1. A `useTableData` unit test (Vitest) that mocks the IPC layer and asserts: calling `refresh()` (MySQL/MSSQL) or bumping `applyToken` (Postgres) with structurally-identical filters triggers a second `queryTable` call.
2. An integration-level test on the Apply handler in `TableViewerTab` to assert the handler bumps the token / calls `refresh()`.

We don't need a backend integration test — the bug is wholly in the frontend trigger.

## Risks / Trade-offs

- **Risk:** Bumping `applyToken` on every Apply doubles state writes; in extreme cases (rapid Apply spam) could trigger extra renders. **Mitigation:** Numeric state is cheap; React batches the two `setState` calls. Realistic Apply cadence is human-bound (< 5 Hz). No mitigation needed beyond batching.
- **Risk:** Future refactor of Postgres `useTableData` to drop the dependency-driven reset would silently break the fix. **Mitigation:** Add a regression test that fails fast in that scenario; add a `// see openspec/specs/postgres-data-grid` comment above `depsKey` referencing the requirement.
- **Risk:** MySQL/MSSQL `refresh()` is already "right"; readers may wonder why we touched it. **Mitigation:** Keep the code diff there minimal (a comment + a test); rely on the spec delta for durability.
- **Trade-off:** We don't unify the three engines' Apply pipelines. Accepting per-engine divergence for now keeps the blast radius small and matches the existing codebase style.

## Migration Plan

- No data migration. No IPC contract change. No persisted-store schema change.
- Rollout: ship as a normal patch. The fix is fully client-side; reverting is a single commit.
- Rollback: revert the PR. Spec delta archives with the change; if reverted, the spec delta is removed via `openspec` change rollback.

## Open Questions

- Should we also wire `applyToken` (or an equivalent) to **column-filter changes initiated outside the bar** (e.g. column-header filters, if/when they ship)? Out of scope for this change — leave the door open.
- Once the standalone **Reload** button from #52 lands, should it share the same `applyToken` mechanism for Postgres? Likely yes; will be handled when #52 is designed.
