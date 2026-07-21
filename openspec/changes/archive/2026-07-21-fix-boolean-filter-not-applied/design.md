## Context

The Postgres data-grid filter bar keeps a `draft` model (`FilterBarModel` with `rows: FilterRow[]`) and an `applied` snapshot. On Apply, the enabled + complete subset of `draft` is serialized by `modelToPayload` into a `filter_tree` and sent to `postgres_query_table`; the Rust backend compiles it into the `WHERE` clause.

Two frontend seams interact to produce the bug:

1. **Value never committed for boolean rows.** `EMPTY_FILTER_ROW_FIELDS` initializes `value: ""` (`packages/app/src/modules/postgres/data/types.ts:115`). The boolean value control (`filter-bar/ValueInput.tsx:144-159`) is a `<select>` whose value only updates the model via `onChange`. With `value === ""`, `cur` is `""`, matching no `<option>`; the browser paints the first option ("true") but the model stays `""`. Choosing "true" is not a `change` (it's already displayed) so `onChange` never fires. The row keeps `value: ""`.

2. **Completeness rejects the row, payload omits it.** `isCompleteRow` returns `false` for `value === ""` (`types.ts:302`). `modelToPayload` filters to `enabled && isCompleteRow`; with the only row dropped it returns `{}` — no `filter_tree` (`types.ts:253-269`). The backend then correctly emits no `WHERE` (`src-tauri/.../data.rs:609-679`).

3. **The badge hides the failure.** `buildAppliedSet` / `filterRowEquals` mark a row "Applied" purely on `(column, op, value)` triple equality, ignoring completeness (`filter-bar/FilterBar.tsx:75-90`, `types.ts:310-314`). On Apply, `applied := draft`, so the incomplete row exists identically in both and the badge turns green — masking that nothing was sent.

The Rust backend is correct and out of scope.

## Goals / Non-Goals

**Goals:**
- A boolean filter row created and left at its default MUST carry a real boolean value (`true`) in its model, so `= true` compiles into the `WHERE` clause.
- A boolean value of `false` MUST also count as complete (so `= false` filters work).
- The per-row "Applied" badge MUST NOT display green for a row that would be dropped from the payload (incomplete row).

**Non-Goals:**
- No backend / SQL-compilation changes.
- No change to operator sets, RAW rows, or the `filter_tree` wire shape.
- No change to non-boolean value inputs' behavior.

## Decisions

**Decision 1 — Commit a concrete boolean default rather than tolerating `""` downstream.**
Fix the root: the boolean value input must hold a real boolean in the model. Two coordinated moves:
- `EMPTY_FILTER_ROW_FIELDS`/row creation: when the selected column resolves to a boolean type, seed `value: true`. Because the empty row is created before a column is chosen, the more reliable seam is the value input: when the category is `boolean` and the current model value is not already a boolean, eagerly emit `onChange(true)` (on mount / when the boolean control first renders) so the model matches the visually-selected "true".
- Keep the `<select>`'s displayed value in sync with the committed boolean (`String(value)`), which now always resolves to `"true"`/`"false"`.
- _Alternative considered_: only relax `isCompleteRow` to treat `""` on a boolean column as "true". Rejected — it leaves the model holding a non-boolean placeholder that other code (payload serialization, applied-equality) must special-case; committing a real value is cleaner and localizes the fix.

**Decision 2 — `isCompleteRow` explicitly accepts boolean values.**
Add a boolean guard so `value === true || value === false` is complete before the falsy `value === ""` rejection. This makes `= false` work regardless of Decision 1 and hardens the invariant.
- _Alternative considered_: rely solely on Decision 1 seeding `true`. Rejected — a user selecting `false` must still produce a complete row; the completeness check must not treat boolean `false` as "empty".

**Decision 3 — Gate the "Applied" badge on completeness.**
`buildAppliedSet` (or the badge derivation consuming it) MUST only mark a draft row "Applied" when that row is itself complete (would survive `modelToPayload`). A row that is incomplete shows the neutral `Apply` label. This aligns the visual state with what was actually sent and prevents the class of "green but not applied" bugs beyond booleans.
- _Alternative considered_: leave the badge as-is once Decision 1 lands. Rejected — the badge is independently wrong (it can go green for any incomplete row) and the spec's "Applied" requirement should mean "actually applied".

## Risks / Trade-offs

- **[Eager `onChange` on mount could cause an unexpected fetch or dirty state]** → The value input's `onChange` only mutates `draft`; it does not auto-fetch (fetch is gated on Apply). Emitting a default boolean on first render mutates `draft` only, matching what the user already sees selected. Verify it does not trigger an Apply.
- **[Changing `isCompleteRow` semantics could affect other engines/callers]** → The check lives in the Postgres module's `types.ts`; scope the change there. Confirm MySQL/MSSQL grids have their own copies and are not silently coupled.
- **[Badge gating on completeness changes an existing spec scenario]** → The "Per-row Apply and Applied visual state" requirement currently defines "Applied" by triple equality regardless of `enabled`. The spec delta MUST amend it to additionally require the row be complete; update the affected scenarios accordingly.

## Migration Plan

Pure bug fix — no data migration, no persisted-shape change. `draft`/`applied` models remain in-memory session state. Ship behind no flag; rollback is a straight revert.

## Open Questions

- Should seeding the boolean default live in row-creation (when a boolean column is picked) or in the value input's first render? The value-input seam is more robust (covers column switches to a boolean type mid-edit); implementation should prefer it and confirm it also covers switching an existing row's column to a boolean column.
