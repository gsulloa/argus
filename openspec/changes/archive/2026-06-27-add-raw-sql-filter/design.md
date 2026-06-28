## Context

The Postgres data-grid filter bar (`packages/app/src/modules/postgres/data/filter-bar/`) builds a `FilterTree` of `{ column, op, value }` rows that the backend (`src-tauri/src/modules/postgres/data.rs`) compiles into a parametrized `WHERE`. Every value is bound as a `$n` parameter — safe, but it means the predicate is always `<column> <op> <value>` and can never reach inside a `jsonb` document or express any other free-form SQL.

Two relevant facts about the current code shape the design:

1. There is already a top-level `raw_where: Option<String>` on `QueryTableOptions` / `CountTableOptions`, **mutually exclusive** with `filter_tree` and emitted verbatim. It has **no frontend surface** today.
2. A whole-bar "Raw mode" backed by `raw_where` previously existed and was **removed** (see `postgres-data-grid` spec, "Filter draft and applied state": *"Mode toggling is REMOVED … always in Structured mode"*) precisely because it *replaced* the structured filters instead of composing with them.

Issue #194 asks for a RAW filter that **combines** with the structured rows and clears easily — i.e. the opposite of the removed mutually-exclusive mode. The MySQL and MSSQL modules keep their own independent copies of the filter types and compilers.

## Goals / Non-Goals

**Goals:**
- A per-row RAW filter inside `filter_tree` that holds an arbitrary SQL boolean expression, injected verbatim into the `WHERE`.
- RAW rows compose with structured rows under the existing AND/OR combinator and share the full row lifecycle (enable, per-row apply, clear, footer SQL preview).
- Querying inside `jsonb` (`->`, `->>`, `@>`, `?`) and any other valid predicate works.
- Backend validation that keeps RAW tightly paired with the new `raw` column reference, so a stray `RAW` op can't appear on a named column.

**Non-Goals:**
- Reviving or surfacing the top-level `raw_where` field — it stays as-is, untouched.
- MySQL / MSSQL / DynamoDB / Athena / CloudWatch support (separate type copies; can follow later with the same shape).
- Any sanitization, allow-listing, or sandboxing of the RAW expression beyond "non-empty string". RAW is an explicitly trusted free-form expression.
- Autocomplete / syntax highlighting / multi-line CodeMirror editor for the expression (a plain monospace single-line input is sufficient for v1).

## Decisions

### Decision 1: RAW as a per-row condition in `filter_tree`, not the `raw_where` field

A new `ColumnRef` variant `{ kind: "raw" }` plus a new `Operator` `RAW` make a self-contained RAW row: `{ column: { kind: "raw" }, op: "RAW", value: "<expr>" }`. This piggybacks on the existing tree walk, combinator join, per-row enable/apply, and wire conversion — RAW rows are "just another row".

- **Why over reusing `raw_where`:** `raw_where` is mutually exclusive with `filter_tree`, so it structurally cannot satisfy "combines with the rest of the filters". Reusing it would also resurrect the exact UX that was deliberately removed.
- **Why a new `ColumnRef` variant over overloading `any_column`:** `any_column` has defined fan-out semantics (OR across text-castable columns); a RAW row has no column at all. A distinct `raw` kind keeps the model honest and lets the UI key the expression-input rendering off `column.kind === "raw"`, mirroring how it already special-cases `any_column`.

### Decision 2: Verbatim interpolation, wrapped in one pair of parentheses

The RAW `value` compiles to `(<trimmed expr>)` and is concatenated into the `WHERE` body with no parameter slot and no identifier quoting. The parentheses guarantee correct precedence when joined with other rows under `AND`/`OR`.

- **Why verbatim is acceptable:** the data grid runs against a connection the user owns and already has a full SQL editor for. RAW is the same trust level as typing the predicate into that editor; the query path is read-only (`executeQuery`). There is no privilege escalation — only the user's own session is affected.
- **Trade-off:** this is the single interpolated path in an otherwise fully-parametrized compiler. It is contained: only reachable when `column.kind === "raw"`, validated to be a non-empty string, and the activity log records the issued SQL verbatim for auditability.

### Decision 3: Strict operator–column pairing, enforced on both ends

The backend MUST reject `RAW` on a non-`raw` column and any non-`RAW` operator on a `raw` column, with `AppError::Validation`. The frontend enforces the same by construction: picking `Raw SQL` in the column picker sets `column.kind = "raw"` and pins `op = "RAW"`, and hides the operator picker.

- **Why:** prevents an interpolated expression from ever landing where a bound value is expected (and vice-versa). Belt-and-suspenders: UI makes the invalid state unreachable, backend rejects it if a malformed payload arrives anyway.

### Decision 4: Reuse the column picker as the RAW entry point

`Raw SQL` becomes a third pseudo-entry in `ColumnPicker.tsx` next to `Any column`. Selecting it flips the row into RAW mode. This reuses an affordance users already understand, avoids a separate mode toggle (which was the rejected pattern), and means a row can move between named / any / raw freely while the rest of the bar chrome is unchanged.

- **Alternative considered:** a dedicated "+ Raw" button or a row-level toggle. Rejected as extra chrome that fragments the "every filter is a row" mental model.

### Decision 5: Completeness = non-empty trimmed string

`isCompleteRow` (frontend, `types.ts`) gains a RAW branch: complete iff `typeof value === "string" && value.trim() !== ""`. This reuses the existing enabled-and-complete gating for `Apply All` and the per-row apply, so empty RAW rows never reach the wire — symmetric with how empty structured values are dropped.

## Risks / Trade-offs

- **[Arbitrary SQL in the predicate]** → Contained to the user's own read-only session; equivalent to the existing SQL editor; logged verbatim in the activity log. No new attack surface beyond what the user can already do.
- **[A malformed expression yields a Postgres syntax error]** → Surfaces through the existing query-error path (inline error row / error toast) exactly like a bad `raw_where` or a failed query; nothing special needed. The error is the user's own SQL, which is the expected feedback loop.
- **[Single interpolated branch in a parametrized compiler invites copy-paste mistakes later]** → Mitigated by the strict `raw`-column/`RAW`-op pairing and unit tests asserting both the verbatim emission and the rejection paths; the interpolation is unreachable for any other operator.
- **[Model divergence across engines]** → Postgres-only for v1 is an intentional scope cut; the design note records that MySQL/MSSQL can adopt the identical `{ kind: "raw" } + RAW` shape later. No shared type is broken because each engine owns its copy.
- **[Footer SQL preview drift]** → The frontend `compileWhere` (used for the preview only) must mirror the backend's `(<expr>)` wrapping; a unit test pins this so the preview never disagrees with what executes.

## Migration Plan

No data migration. Additive only:
- New enum variants (`Operator::Raw`, `ColumnRef::Raw`) and a new TS union member deserialize older payloads unchanged; existing persisted filters (which never contain RAW) load as-is.
- Rollback is a straight revert — no persisted state depends on the new variants, and a downgraded app simply won't offer the `Raw SQL` picker entry. A persisted draft containing a RAW row on a downgraded build would be an unknown operator; the legacy-filter migration path (`migrateLegacyFilterModel`) should drop rows it doesn't recognize rather than throw (verify during apply).

## Open Questions

- None blocking. (Considered but deferred: multi-line/CodeMirror expression editor with `jsonb`-operator autocomplete; per-engine rollout beyond Postgres.)
