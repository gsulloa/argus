## Context

The three SQL data grids (`packages/app/src/modules/{postgres,mysql,mssql}/data/`)
share one edit buffer: MySQL and MSSQL re-export
`postgres/data/useEditBuffer.ts`. Each engine, however, has its own inline editor
(`EditableCell.tsx`).

The dirty highlight is driven solely by `isCellDirty(rowKey, column)` in
`useEditBuffer.ts:581`, which is true iff a buffer entry exists and the column is
in `changes`. Double-clicking a cell does NOT touch the buffer — it only sets
local `editing` state. The buffer entry is created later, when the editor
commits (on blur / `Enter` / `Tab`), via `onCommitEdit → buffer.setCellEdit`
(`DataGrid.tsx:747`).

The `set-cell` reducer already tries to discard a no-op commit
(`useEditBuffer.ts:153-163`): if the committed value equals the original server
value it drops the change and, when the row has no remaining changes, removes the
row from the buffer entirely (`isEmptyUpdate`). The equality check is
`cellEquals` (`useEditBuffer.ts:471-482`), which falls back to
`JSON.stringify(a) === JSON.stringify(b)`.

The bug: the editor coerces its raw text into a typed `EditValue` before
committing (`parseInputValue`, `EditableCell.tsx:78-92`). Postgres returns
`numeric`/`decimal`/`bigint` as **strings** to preserve precision, so the server
value is `"100.00"` while the committed value is the number `100`;
`JSON.stringify("100.00") !== JSON.stringify(100)`. JSON/JSONB commits are
re-canonicalized, so whitespace differences break equality too. `cellEquals`
therefore fails to recognize the no-op, the change is kept, and the untouched cell
renders yellow (`--warning` for Postgres; inline `rgba(250,204,21,0.12)` for
MySQL/MSSQL). The reporter saw this after double-clicking a Postgres cell and
clicking away.

## Goals / Non-Goals

**Goals:**
- Double-clicking a cell and leaving edit mode without changing its content never
  creates a dirty buffer entry and never applies the dirty highlight — for every
  column type and every commit path (blur / `Enter` / `Tab`).
- The revert-to-original path (edit, then commit the original value back) also
  cleans the buffer for numeric/JSON columns, not just for exact string matches.
- Fix all three SQL grids (Postgres, MySQL, MSSQL) consistently.

**Non-Goals:**
- No change to the dirty styling itself, the active-cell (`--accent`) ring, or the
  edit-mode background.
- No change to DynamoDB (it commits each edit immediately; no dirty buffer).
- No change to backend value serialization (numeric-as-string is intentional and
  correct for precision).
- Not unifying the MySQL/MSSQL inline yellow into the `--warning` token (a real
  DESIGN.md deviation, but out of scope for this bug fix).

## Decisions

### Decision 1 — Two complementary layers, both driven by the same root cause

The root cause is a type-coercion mismatch between the committed value and the
server value. We fix it at both the layer that emits the commit and the layer that
collapses it, so neither has to be perfect alone.

**Layer A — editor "commit only if changed" guard (primary).**
In each engine's `CellEditor`, capture the editor's opening representation and, on
`commit()`, if the current editor state is byte-for-byte identical to the opening
state, call `onCancel()` (close the editor, touch nothing) instead of `onCommit()`.
The comparison is on the editor's own input representation (the `text` string plus
the `nullToggle` boolean), NOT on the coerced `EditValue` — so it is inherently
type-agnostic and requires no knowledge of how the backend serializes the value.
This alone fully resolves the reported bug (pure double-click → blur produces no
commit at all).

*Alternative considered:* only fix `cellEquals`. Rejected as the sole fix because
it still lets an unnecessary dispatch fire on every editor exit (churn, undo-stack
noise) and is harder to reason about across every coercion path. The guard is the
cleaner behavioral contract: "no change in, no edit out."

**Layer B — type-tolerant `cellEquals` (hardening).**
Make `cellEquals` recognize equivalent values across the editor's coercions:
- numeric string ↔ number: when one side is a number and the other is a numeric
  string, compare by numeric value (e.g. `Number("100.00") === 100`) while
  preserving the existing strict path for everything else;
- canonicalized JSON: when both sides parse as JSON, compare parsed structures
  (or compare canonical serializations) rather than raw text.
This keeps the buffer's documented "drop an edit equal to the original" promise
robust even when a commit does fire — covering the edit-then-revert case that
Layer A does not.

*Alternative considered:* normalize values at commit time in the editor instead of
in the buffer. Rejected because the buffer is the single shared choke point for all
three engines and both cell paths (grid + inspector); centralizing the equality
there avoids per-editor divergence.

### Decision 2 — Comparison lives on the editor's string state, not the parsed value

For Layer A, "unchanged" is defined as "the editor's input fields hold the same
representation they were initialized with." Concretely: the `text` state equals
`valueToInputString(initial)` and `nullToggle` equals the initial null-ness. This
sidesteps every coercion subtlety (a numeric cell showing `100.00` that the user
never touches has `text === "100.00"` on both sides → unchanged), and it behaves
correctly for select-based editors (boolean/enum) where re-selecting the same
option is a no-op.

### Decision 3 — Keep the change surgical and well-tested per engine

The three `EditableCell.tsx` files diverge (Postgres uses one `CellEditor`;
MySQL/MSSQL split into per-type editor components). The guard must be added to each
editor variant's commit path. `cellEquals` is edited once in the shared buffer.
Tests are added at both layers: buffer-level unit tests for `cellEquals`
(numeric/JSON round-trips) and component-level tests per engine for the
double-click-then-blur no-op.

## Risks / Trade-offs

- **[Layer A suppresses a legitimate "commit" that happens to equal the initial
  value]** → That is exactly the desired behavior; committing an unchanged value is
  by definition a no-op. No data is lost because the buffer/server value is
  unaffected.
- **[Type-tolerant `cellEquals` could over-collapse and hide a real edit]** (e.g.
  treating `"100"` and `100` as equal when the user genuinely meant to change the
  stored textual form) → Acceptable: the backend stores these numeric types
  identically regardless of whether the value arrives as `"100"` or `100`, so there
  is no observable difference to lose. The numeric-equality branch is gated to
  numeric-looking operands only; all other types keep strict `JSON.stringify`
  equality.
- **[MySQL/MSSQL editors have several per-type components, easy to miss one]** →
  Enumerate every editor's commit/blur path in the tasks and add a per-engine
  double-click-no-op test so a missed variant fails CI.
- **[Divergent editor implementations drift over time]** → Out of scope to unify
  here; the shared `cellEquals` hardening (Layer B) provides a safety net even for
  any editor path that forgets the Layer A guard.

## Migration Plan

Pure frontend behavioral fix; no data migration. Ships in a normal release.
Rollback is a straight revert of the frontend change — no persisted state depends
on it (the edit buffer is session-only).

## Open Questions

None. Scope, root cause, and both fix layers are confirmed against the code.
