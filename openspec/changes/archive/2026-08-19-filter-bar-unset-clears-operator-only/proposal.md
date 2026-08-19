## Why

The Postgres filter bar footer renders a control labelled `Operator: [Unset]`, but
activating it calls `clearAllRows(draft)` — it discards every filter row the user
built (column, operator and value alike) and leaves a single blank row behind.
The label promises an operator-scoped deselection; the button delivers a
destructive wipe with no undo, and the work of assembling a multi-row filter is
lost on a single misread click.

In-app feedback (issue #278): *"Que el operator: unset no borre los filtros, solo
que los deseleccione"* — the Unset control should not delete filters, it should
deselect them.

## What Changes

- **BREAKING (behavioural)** `Operator: [Unset]` no longer clears `draft.rows`.
  It clears the **operator selection** on every draft row, preserving each row's
  `column`, `value`, `enabled` flag, `id` and ordering, and preserving
  `draft.combinator`. `applied` is still untouched.
- Introduce an **unset operator state** in the client filter model: `FilterRow.op`
  becomes `Operator | null`. A row with `op === null` is never complete, so it is
  excluded from `Apply All`, from per-row `Apply`, and from the wire payload — a
  filter that has been unset is preserved but inert, which is precisely the
  "deselected, not deleted" behaviour the feedback asks for.
- `OperatorPicker` gains a placeholder option (`—`) shown only while the row's
  operator is unset. Choosing any real operator from the picker restores normal
  behaviour and coerces the retained value into that operator's value shape.
- Add an explicit **`Clear all`** footer button so the destructive path that
  `Unset` used to provide stays reachable — but as its own opt-in action rather
  than the side effect of an operator-scoped label. It keeps the old semantics:
  reset `draft.rows` to a single empty row, preserve `draft.combinator`, do not
  touch `applied`.
- Row-level guards for the new null state: `isCompleteRow`, `filterRowEquals`,
  `compileWhere`, `ValueInput`, `ConditionRow`'s column-change coercion, and
  `migrateLegacyFilterModel` (whose current `if (!r["op"])` guard would discard
  the **entire persisted model** the first time a null-operator row is rehydrated).

Non-goals: MySQL and MSSQL. Their filter bars (`modules/mysql/data/FilterBar.tsx`,
`modules/mssql/data/FilterBar.tsx`) render no `Unset` control today, so there is
nothing to correct there; their spec text describing an Unset footer is
aspirational and is left as-is.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `postgres-data-grid`: the "Filter bar footer Unset, Export, SQL" requirement is
  rewritten — `Unset` becomes operator-scoped and a new `Clear all` button owns
  the row-clearing behaviour. The "Filter draft and applied state" and "Raw SQL
  filter row" requirements are amended where they describe `Unset` as the
  row-clearing affordance. A new requirement covers the unset-operator row state
  (incompleteness, picker placeholder, value retention, persistence round-trip).

## Impact

Frontend only; no Rust/IPC change (the unset state never reaches the wire).

- `packages/app/src/modules/postgres/data/types.ts` — `FilterRow.op: Operator | null`,
  `isCompleteRow`, `filterRowEquals`, `modelToPayload`.
- `packages/app/src/modules/postgres/data/filter-bar/treeMutations.ts` — new
  `unsetAllOperators`; `clearAllRows` retained for `Clear all`.
- `packages/app/src/modules/postgres/data/filter-bar/FilterBar.tsx` — `handleUnset`
  rewired, new `Clear all` button + handler.
- `packages/app/src/modules/postgres/data/filter-bar/OperatorPicker.tsx`,
  `ConditionRow.tsx`, `ValueInput.tsx`, `compileWhere.ts`,
  `migrateLegacyFilterModel.ts` — null-operator handling.
- `packages/app/src/modules/postgres/data/filter-bar/FilterBar.module.css` — style
  for the added footer button.
- Tests: `FilterBar.test.tsx`, `treeMutations.test.ts`, `compileWhere.test.ts`,
  `filterRowEquals.test.ts`, `migrateLegacyFilterModel.test.ts`,
  `TableViewerTab.test.tsx`.
- Persistence: existing `pgTableFilter:*` records stay readable; new records may
  carry `op: null`, which older app builds would discard (whole-model reset, not a
  crash) — acceptable for a forward-only desktop app.
