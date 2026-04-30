## Context

The sibling `table-quick-switcher` change ships ⌘P, with first-open eager loading: for every `(active connection, cached schema)` where relations aren't yet in the cache, fire `listRelations` in parallel. Postgres reports a per-session schema `pg_temp_N` (and `pg_toast_temp_N`) for every other backend, plus the always-present `pg_catalog`, `pg_toast`, `information_schema`. On a busy production database that's hundreds of "schemas" the user will never see in the picker — they hold no user-defined relations.

The current `useTableIndex.ts` ignores this. Empirically (logs from `b6d420c0-…` connection): ~720 parallel `postgres_list_relations` calls, every one returning `tables=0 views=0 matviews=0`, every one reporting `elapsed≈45 s` because the deadpool sat saturated. The user sees a frozen picker and a degraded production database for the duration.

`globalSchemaCache.ts` already exposes the right primitive: `isSystemSchema(name)` returns true for `information_schema` and any name starting with `pg_`. It is used elsewhere in the codebase (autocomplete) and is the canonical filter.

## Goals / Non-Goals

**Goals:**
- The eager loader MUST NOT issue `listRelations` for system schemas.
- The flattened table list MUST NOT include relations from system schemas (defense in depth — if a future code path populates them, they still don't appear in the picker).
- Reuse the existing `isSystemSchema()` helper. No new heuristic.

**Non-Goals:**
- Filtering system schemas elsewhere (sidebar tree, schema browser). The sidebar already separates system/user schemas via `is_system`; this change is scoped to the quick-switcher index.
- Backend-side filtering of `pg_temp_*` from `SQL_LIST_SCHEMAS`. The catalog query is correct — system schemas are surfaced for explicit browsing. The bug is that the index treats them as eligible.
- Distinguishing "system schema with no relations" from "system schema with relations" (e.g., user-installed extensions placed in `pg_catalog`). For ⌘P quick-switching, system schemas are not surfaced at all; if a user wants those relations, they navigate via the sidebar.

## Decisions

**Decision 1: Filter at the index hook, not at the cache.**
Apply the filter inside `useTableIndex.ts` (both `flatten()` and the eager-load loop). The schema cache remains the source of truth for *all* schemas — other consumers (sidebar tree under "System schemas", the schema browser when the user explicitly opens `pg_catalog`) still get the full list.

Alternative considered: filter at `globalSchemaCache.recordSchemas` so system schemas never enter the cache. Rejected — it breaks the sidebar's "System schemas" group and the schema browser, and conflates a UI policy ("don't quick-switch to system relations") with a data-layer concern.

**Decision 2: Use `isSystemSchema()`, not the `is_system` field on `SchemaSummary`.**
The cache already carries `s.is_system` (computed server-side from the same `nspname LIKE 'pg\_%'` pattern). Either works, but `isSystemSchema()` is the canonical helper, already imported in autocomplete code, and decouples the filter from the server payload shape.

**Decision 3: Apply the filter in both `flatten()` and the eager loader.**
The eager loader is the bug — that's where the request fan-out happens. But `flatten()` also walks the cache to render entries, and a hypothetical future path might populate `pg_catalog` relations into the cache (e.g., user explicitly browses `pg_catalog` in the sidebar). Filtering both ensures the picker stays clean regardless of how the cache got populated.

## Risks / Trade-offs

- **[Risk] User installs an extension in `pg_catalog` and expects to find it via ⌘P.**
  → Mitigation: not surfacing system schemas in the picker is consistent with TablePlus and most peers. Users can still open these relations through the sidebar. If a real complaint surfaces, we can add an explicit "include system schemas" toggle later — that's a UI affordance, not a structural change.

- **[Risk] Cache-version churn.** `flatten()` runs on every cache notification; adding an `if` per schema is O(N) on the schema list, not the relation list. Negligible.

- **[Risk] The fix only helps after this build is shipped.** Until then, users on the bugged build can mitigate by closing ⌘P quickly or restarting the app to drop the inflight set. No data loss; the DB recovers as queries time out / drain.
