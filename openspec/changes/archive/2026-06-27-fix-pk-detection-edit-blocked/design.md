## Context

Editing and deleting existing rows in the data grid are gated on PK metadata fetched once per `(connection, schema, relation)`. Across all three SQL engines the frontend uses a single sentinel — `pkColumns === null` — to mean "this relation has no primary key", and it renders the banner *"No primary key — existing rows are not editable"* whenever that sentinel is set.

The bug: the error path collapses into the same sentinel.

- **Postgres** — `useTablePrimaryKey.ts` already tracks a four-state machine (`idle | loading | ready | error`) and keeps the `AppError` on the `error` state. But `TableViewerTab.tsx` ignores it: `pkColumns = pkLookup.metadata?.pk_columns ?? null` (so an error → `null`), and the comment at L226-228 explicitly says *"an error is treated as 'no PK'"*. `noPkBanner = !isReadOnly && relationKind === "table" && pkColumns === null` then fires on error.
- **MySQL** (`mysql/data/TableViewerTab.tsx` L196-211) and **MSSQL** (`mssql/data/TableViewerTab.tsx`) are worse: the `.catch(() => setPkResult(null))` handler discards the error entirely, with a comment *"Set to null to indicate no PK detected or error fetching PK."* The banner is `!pkLoading && pkColumns === null && !isView`.

Additionally, the Postgres backend command `postgres_table_primary_key` (`edit.rs` L262-335) runs the PK lookup and the enum lookup sequentially; the enum query uses `?` (L306), so **any enum-lookup failure aborts the whole command and discards an already-resolved PK** — the frontend then sees an error → null → "no PK".

So a fully-editable table degrades to read-only with a misleading message on any transient failure of either sub-query or the fetch itself. This is the root blocker behind the "no logro editar / eliminar" reports.

The schema/relation passed to the command come from the tree node's real schema (`SchemaTree.tsx` → `openObjectTab.ts` → `data.schema`), not an assumed `public`, so the search_path hypothesis is not the primary cause here. Case-sensitivity is preserved end-to-end. The fix targets the **error-vs-null conflation** and the **enum-poisons-PK** coupling.

## Goals / Non-Goals

**Goals:**
- A relation that genuinely has a PK is never reported as "no primary key" because of a transient lookup failure.
- The user can tell the difference between "this relation has no PK" (expected, unsupported for edit) and "we couldn't determine the PK" (transient, retryable), and can retry the latter without reopening the tab.
- Consistent behaviour across Postgres, MySQL/MariaDB, and MSSQL.
- An enum-metadata failure on Postgres never blocks editing of a table whose PK resolved fine.

**Non-Goals:**
- No change to the PK-detection SQL itself (the `pg_index`/`information_schema` queries are correct).
- No change to the command return signature (`pk_columns: string[] | null` stays; we only fix how errors propagate vs. null results).
- No support for editing relations that truly have no PK (views, heap tables) — that remains insert-only.
- No automatic background retry / polling — retry is a deliberate user action.

## Decisions

### 1. Treat the PK-lookup error state as a first-class UI state, distinct from `null`

The frontend already has (Postgres) or can trivially add (MySQL/MSSQL) an `error` status. The fix is to **stop coercing error → null** and instead branch the banner on three outcomes:

| Outcome | `pkColumns` | Banner | Edit/Delete |
|---|---|---|---|
| Loading | — | none (or existing loading affordance) | disabled |
| Resolved, has PK | `["id", …]` | none | enabled |
| Resolved, no PK | `null` | "No primary key — existing rows are not editable" | INSERT only |
| **Lookup failed** | unknown | **error banner + Retry** (names the cause) | disabled |

The no-PK banner gate becomes `lookupStatus === "ready" && pkColumns === null` rather than just `pkColumns === null`.

**Why over alternatives:** We could make the backend return a richer discriminated union (`{ kind: "ok" | "no_pk" | "error" }`). That is a larger API change and the frontend already has the error in hand (Postgres) — the engines just throw it away. Branching on the existing error status is the minimal, consistent fix.

### 2. Reuse the existing error banner styling; add a Retry that calls the existing `refresh()`

Postgres' `useTablePrimaryKey` already exposes `refresh()`. MySQL/MSSQL have inline `useEffect` fetches; we extract a small retry callback that re-runs the same fetch and resets `pkLoading`/error state. The error banner sits in the bottom bar (Postgres `BottomBar.tsx`) / below the toolbar (MySQL/MSSQL), where the no-PK banner already lives, styled like the existing error affordances (`var(--text-muted)` / error accent per `DESIGN.md` — no new decorative styling). The banner text surfaces `error.message` so the user sees the real cause.

### 3. Decouple the Postgres enum lookup from PK detection (backend)

In `postgres_table_primary_key`, run the enum lookup so its failure does not propagate via `?`. On enum-lookup error, log/swallow and return `enums: {}` with the resolved `pk_columns`. The PK lookup failure (or timeout) remains a hard error — that is the legitimate "we couldn't determine the PK" signal the frontend now renders as a retryable banner.

**Why:** Enum labels are a nice-to-have for the inline editor; PK detection is load-bearing for all editing. They should not share a failure fate. MySQL/MSSQL commands fetch PK (and auto-increment) separately and don't have this coupling, so no backend change is needed there.

### 4. Keep the change surgical and well-tested

No signature changes means existing tests for "view has no PK → banner" and PK detection stay green. We add: (a) a Rust test that an enum-lookup failure still yields the PK; (b) frontend tests per engine that an errored lookup shows the retry banner (not the no-PK banner) and that Retry re-invokes the command and restores editing.

## Risks / Trade-offs

- **[A genuinely PK-less table flickers through the error banner on a slow/failing connection]** → The error banner only appears on a *settled* error, never during `loading`; the no-PK banner only appears on a *settled* success with `null`. Mutually exclusive states prevent flicker.
- **[Swallowing enum errors hides a real catalog problem]** → Acceptable: enum metadata is cosmetic for the editor (enum columns fall back to a text input). We still emit the activity-log entry; a follow-up could log the enum failure at debug level. PK failures remain loud.
- **[Three near-identical frontend edits drift over time]** → Mitigated by identical scenario coverage in the three delta specs and parallel test cases; the logic is small enough that a shared helper is not warranted (each engine's hook shape differs).
- **[The real #195 cause might be something else entirely, e.g. a specific SQL edge case]** → The acceptance criterion requires reproducing against a real table. If reproduction reveals the PK *query* returns empty for a table that has a PK (e.g. a partitioned/inherited table, or a non-`public` schema mismatch), that is a separate detection fix; this change still stands because it makes the failure legible (error banner naming the cause) instead of silently mislabeling. The investigation task gates whether an additional detection fix is needed.

## Migration Plan

Pure bug fix, no data/schema migration. Ships in the normal release. Rollback is reverting the PR; the sentinel behaviour returns but no data is at risk (the bug only ever *over*-restricted editing).

## Open Questions

- Should the error banner auto-retry once on mount before showing the manual Retry, to absorb a single transient blip? Leaning no (keep it deliberate), but cheap to add if QA finds frequent one-off failures.
- For #195 specifically: does the reporter's table reproduce via the enum-poisoning path, the fetch-error path, or a genuine detection gap? The first implementation task is to reproduce and confirm which path(s) apply.
