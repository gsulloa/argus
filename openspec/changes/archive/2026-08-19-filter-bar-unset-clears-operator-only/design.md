## Context

The Postgres filter bar is a flat list of `FilterRow`s (`{ id, enabled, column, op, value }`)
joined by one root combinator, edited as `draft` and committed to `applied` by
`Apply All` / per-row `Apply`. The footer strip carries `Export`, `SQL`, a
shortcut-hint run, `Operator: [Unset]`, and the composed `Apply All ▾` button.

`Unset` was introduced in `2026-05-18-tableplus-style-filter-bar` (design D7) as
the replacement for the removed `Reset` button: it resets `draft.rows` to a
single empty row. The `Operator:` prefix came from mirroring TablePlus's footer
layout, not from any operator-scoped semantics. Two years of use later the label
reads as a promise the button breaks — issue #278.

Constraints that shape the design:

- `Operator` mirrors a closed Rust enum on the wire; the backend rejects anything
  outside it. Any "no operator" state must therefore be **client-only** and must
  never reach `postgres_query_table` / `postgres_count_table`.
- `draft` and `applied` are both persisted per `(connectionId, schema, relation)`
  under `pgTableFilter:*` and rehydrated through `migrateLegacyFilterModel`,
  whose current row guard is `if (!r["column"] || !r["op"]) return EMPTY_FILTER_MODEL`
  — a falsy `op` today nukes the whole persisted model, both halves.
- RAW rows (`column.kind === "raw"`) pin `op` to `"RAW"` and render **no**
  operator picker, so they have no UI affordance to recover from an unset operator.
- The MySQL and MSSQL filter bars (`modules/mysql/data/FilterBar.tsx`,
  `modules/mssql/data/FilterBar.tsx`) are a different, older component with no
  `Unset` control at all. Their spec files describe an Unset footer that was never
  built.

### Reading the feedback

The report is Spanish: *"Que el operator: unset no borre los filtros, solo que
los deseleccione."* It supports two readings — (a) unset the **operator**,
keeping the rows (the reading recorded in issue #278's *Expected* section), and
(b) **deselect the rows**, i.e. uncheck them so they stop filtering. The design
below satisfies both at once: a row whose operator is unset is incomplete, so it
is excluded from `Apply All`, from per-row `Apply`, and from the emitted
`filter_tree` — the filter survives on screen but stops filtering. No separate
"uncheck everything" action is needed to honour reading (b).

## Goals / Non-Goals

**Goals:**

- `Operator: [Unset]` performs an operator-scoped action that matches its label:
  it clears the operator on every draft row and preserves everything else
  (`column`, `value`, `enabled`, `id`, row order, `draft.combinator`).
- A row with no operator is visibly and functionally inert — no predicate is
  emitted for it — yet fully recoverable by picking an operator from the row's
  own picker, with the previously typed value retained wherever the new
  operator's value shape allows.
- The destructive "wipe the draft" capability stays reachable, as its own
  explicitly-labelled control.
- Persisted filters containing unset operators round-trip through app restart
  without discarding the user's filters.

**Non-Goals:**

- Per-row operator unsetting from the operator picker itself (a `—` entry the
  user can re-select). The picker shows the placeholder only while the row is
  already unset; deliberately re-unsetting one row is not a v1 affordance.
- Touching `applied`. Both `Unset` and the new `Clear all` remain draft-only —
  clearing the active filtering still takes an explicit `Apply All`.
- MySQL / MSSQL filter bars, and the aspirational `Unset` text in their specs.
- Undo for `Clear all`.
- Any Rust, IPC, or wire-format change.

## Decisions

### D1. Model the unset state as `FilterRow.op: Operator | null`

**Choice:** widen the field to `Operator | null`; `null` means "no operator
selected". `Operator` itself is unchanged.

**Why:** the wire enum stays closed and untouched, so no Rust change and no risk
of an invalid operator reaching the backend. `null` (rather than optional
`op?: Operator`) makes the unset state *explicit* in every persisted record and
in every equality check, so an unset row can never be confused with a
malformed/partial row.

**Alternatives considered:**

- A sentinel `"UNSET"` member on `Operator` — pollutes the type that mirrors the
  Rust enum; every `switch (op)` in `compileWhere` and the backend contract would
  have to grow a case that must never be reachable.
- `op?: Operator` (optional) — indistinguishable from "field missing" in
  persisted JSON, and the migration guard could not tell a legitimate unset row
  from a corrupt one.
- Keep `op` non-null and reset it to the default `Contains` — that is a
  *selection*, not a deselection; the row would keep filtering and the user's
  complaint would stand.

### D2. `isCompleteRow` becomes a type predicate and rejects `op === null`

**Choice:**

```ts
export type CompleteFilterRow = FilterRow & { op: Operator };
export function isCompleteRow(row: FilterRow): row is CompleteFilterRow
```

with `if (row.op === null) return false;` as the first check.

**Why:** completeness is already the single gate that decides what reaches the
wire (`modelToPayload`), what compiles to SQL (`compileWhere`), what `Apply All`
commits, and what earns the green "Applied" badge (`buildAppliedSet`). Routing
the null case through it means the inert-row behaviour falls out of existing code
paths rather than being re-implemented per call site. Making it a *predicate*
lets `.filter(isCompleteRow)` narrow `op` to `Operator` for free, so
`compileWhere`'s `switch (op)` and `modelToPayload`'s wire projection keep
compiling with no casts and no unreachable defensive branches.

**Consequence — per-row `Apply` on an unset row keeps today's semantics, no new
guard.** `onApplyOnlyRow` in `TableViewerTab` commits `applied = { rows: [row] }`
without a completeness check, and that is already the behaviour for an
*incomplete* row (e.g. one with an empty value): the row lands in `applied`,
`modelToPayload` and `compileWhere` both drop it, and the grid ends up
unfiltered. An unset row behaves identically. The existing spec requires the
green `Applied` badge never to light for an incomplete row, so nothing lies to
the user. Adding a null-specific guard would contradict "Activating the per-row
Apply button MUST set `applied` to `{ rows: [thisRow], … }`" for no gain, so it
is deliberately not added.

### D3. Unset retains the value verbatim; coercion happens on re-selection

**Choice:** `unsetAllOperators` writes `{ ...row, op: null }` and does **not**
call `coerceValueForOperator`. When the user later picks an operator,
`ConditionRow.onOpChange` runs the existing `coerceValueForOperator(row.value, next)`.

**Why:** the whole point is that the typed value survives. Coercing at unset time
would need a target shape that does not exist yet, and would destroy e.g. an
`In` row's array if the user then re-picked `In`. Deferring to re-selection reuses
the operator-switch path that is already specified and tested.

### D4. RAW rows are exempt from Unset

**Choice:** `unsetAllOperators` skips rows with `column.kind === "raw"`; their
`op` stays `"RAW"`.

**Why:** a RAW row hides the operator picker entirely (`ConditionRow` renders it
only when `!isRaw`). An unset RAW row would be unrecoverable — the user would
have to switch the column away from `Raw SQL` and back, losing the expression to
`coerceValueForOperator`. `RAW` is also not a user-chosen operator; it is implied
by the column kind, so there is nothing to "deselect".

**Alternative considered:** unset RAW rows too and surface the picker for them —
contradicts the "operator is fixed for RAW rows" requirement already in the spec.

### D5. `OperatorPicker` renders a placeholder only while unset

**Choice:** widen `value` to `Operator | null`. When `value === null`, prepend a
disabled placeholder `<option value="">—</option>` and select it; the option
disappears from the list as soon as a real operator is chosen (it is only
prepended when `value === null`). `onChange` still emits `Operator` — the
placeholder is `disabled`, so it cannot be re-selected. `aria-label` stays
`"Operator"`.

**Why:** keeps the picker a plain `<select>` (no popover rework), makes the
unset state legible at a glance, and makes it impossible to *enter* the unset
state one row at a time by accident — the only route in is the footer button.

**Visual:** an unset operator cell reads as muted (`--text-subtle`) rather than
error-red — an unset row is a valid intermediate state, not a mistake.

### D6. Add `Clear all` to the footer; keep `clearAllRows` as its implementation

**Choice:** a new `Clear all` button in the footer's left group, next to `Export`
and `SQL`, styled with the existing `styles.footerBtn` (neutral, not `--danger`).
It calls `clearAllRows(draft)` — exactly today's `Unset` behaviour: `draft.rows`
becomes one empty row, `draft.combinator` is preserved, `applied` is untouched.

**Why:** issue #278 asks that deleting filters stay available as its own explicit
action. `clearAllRows` and its tests already exist and stay valid; only the
control that invokes it moves. Neutral styling because the action is draft-only
and non-committal — nothing the grid is showing changes until `Apply All`.

**Placement:** left group rather than beside `Operator: [Unset]`, so the two are
not adjacent and cannot be misclicked for one another.

### D7. Relax the persistence guard, do not version the record

**Choice:** in `migrateLegacyFilterModel`, change the row guard from
`if (!r["column"] || !r["op"])` to a column-only check plus explicit operator
normalisation: a row's `op` resolves to `null` when the persisted value is
`null`/absent, and to the persisted string otherwise. Everything else about the
migration is unchanged.

**Why:** without this, the first restart after a user clicks `Unset` throws away
**both** `draft` and `applied` for that table — a worse data loss than the bug
being fixed. No schema version bump is needed: the field widened, the record
shape did not change, and unknown-operator strings were already passed through
untouched (the `OperatorPicker` surfaces out-of-list values deliberately).

**Forward compat:** a record written by this build and read by an older build
hits the old `!r["op"]` guard and resets that table's filter to empty. That is a
downgrade-only, table-scoped reset with no crash — acceptable for a forward-only
desktop app.

### D8. Bulk-only action; no keyboard shortcut

**Choice:** `Unset` acts on all draft rows at once, as it does today. No new
shortcut is bound for either `Unset` or `Clear all`; the existing `⌘⇧I`
(remove focused row) is untouched.

**Why:** preserves the existing muscle memory for the footer control and keeps
the change surface small. The shortcut-hint strip is already at its width budget;
adding entries would push the footer to wrap.

## Risks / Trade-offs

- **Persisted null-op rows discarded by older builds** → whole-model reset per
  table on downgrade, not a crash (D7). Documented; no mitigation beyond the
  relaxed guard on the read path.
- **Per-row `Apply` on an unset row leaves the grid unfiltered** → matches the
  existing behaviour for any incomplete row and never shows a false `Applied`
  badge (D2). Covered by a spec scenario rather than by new code.
- **`ValueInput` receives `op: null`** and currently branches on operator to pick
  its control (chips for `In`/`NotIn`, min/max for `BETWEEN`, hidden for the null
  operators) → it must render the *value-shape-derived* control while unset:
  array value → chips, `{min,max}` → range, otherwise the scalar input. Without
  this the retained value is invisible and the fix does not read as "your filter
  is still here".
- **A screenful of `—` operators looks broken** → the footer dirty pip plus the
  retained columns/values keep the state legible, and one click on any picker
  restores a working row. Mitigated by muted (not red) styling (D5).
- **Users relying on `Unset` as the fast "clear everything"** lose a one-click
  path; `Clear all` sits two controls away in the same strip. This is the
  intended trade — the destructive action becomes opt-in.
- **Spec drift for MySQL/MSSQL**: their spec files keep describing an Unset
  footer with the old semantics while Postgres's diverges. Left alone
  deliberately — those bars do not implement it, so amending their text would be
  describing behaviour of a control that does not exist.

## Migration Plan

No data migration. The read path (`migrateLegacyFilterModel`) is widened before
any write path can produce `op: null`, so old records load unchanged and new
records load correctly. Rollback is a straight revert of the frontend change;
already-persisted `op: null` rows then reset to an empty filter for the affected
table on next load (D7).

## Open Questions

- Should `Unset` become a no-op (or disable itself) when every non-RAW draft row
  already has `op === null`? Proposed: leave it always enabled — a no-op click is
  harmless and the disabled state costs a render-time scan of every row.
- Should the footer eventually gain `Uncheck all` (toggle every row's `enabled`
  to `false`) as a distinct affordance? Not needed to satisfy #278 — an unset row
  already stops filtering — but it is the natural sibling control if users ask to
  keep the operator while pausing a filter.
