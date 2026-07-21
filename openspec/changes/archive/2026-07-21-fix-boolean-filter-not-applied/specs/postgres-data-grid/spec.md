## ADDED Requirements

### Requirement: Boolean structured filter rows carry a concrete value

A structured filter row whose resolved column is of boolean type (`boolean`/`bool`) SHALL always hold a concrete boolean `value` (`true` or `false`) in its draft model — never the empty-string placeholder used for unfilled text/number inputs. The boolean value control is a two-option `<select>` (`true` / `false`); because a `<select>` whose model value does not match any option paints the first option without committing it, the frontend MUST commit a real boolean to the row model rather than relying on the browser's visual default.

To that end:
- When a row's column resolves to a boolean type and the row's current `value` is not already a boolean, the frontend MUST commit a default of `true` to the draft model (e.g. by emitting the value control's change with `true` on first render of the boolean control, and/or seeding `true` when a boolean column is selected). The committed value MUST equal what the `<select>` visually shows.
- Switching an existing row's column to a boolean column MUST likewise leave the row holding a concrete boolean value.
- A boolean `value` of `false` MUST be treated as a fully-specified value, not as "empty".

A row satisfying this requirement MUST be **complete**: it MUST survive the `draft` → payload conversion and compile into the `filter_tree` sent to `postgres_query_table` / `postgres_count_table`, so a boolean `= true` (or `= false`) filter emits a `WHERE` clause. Completeness checks MUST accept `value === true` and `value === false` as complete before any falsy/empty rejection (`value === "" | null | undefined`).

#### Scenario: New boolean row defaults to a committed true value

- **WHEN** the user adds a filter row and selects a boolean column (e.g. `email_verified`) with operator `=`
- **THEN** the row's draft `value` is the boolean `true` (matching the `<select>`'s displayed option), not the empty string
- **AND** the row is complete
- **AND** applying it invokes `postgres.queryTable` with a `filter_tree` containing `{ column: { kind: "named", name: "email_verified" }, op: "=", value: true }`
- **AND** the issued SQL contains a `WHERE "email_verified" = $1` clause bound to `true`

#### Scenario: Boolean false is a complete value

- **WHEN** the user sets a boolean row to `email_verified = false`
- **THEN** the row is complete
- **AND** applying it emits `WHERE "email_verified" = $1` bound to `false` (the row is NOT dropped as "empty")

#### Scenario: Switching a row's column to a boolean column seeds a concrete value

- **WHEN** the user changes an existing row's column from a text column to a boolean column
- **THEN** the row's draft `value` becomes a concrete boolean (`true`) rather than remaining an empty string
- **AND** the row is complete without any further user interaction

## MODIFIED Requirements

### Requirement: Per-row Apply and Applied visual state

Every Structured filter row SHALL render a `Apply` / `Applied` button at its right edge (before the `+` / `−` controls). The button MUST show the label `Apply` (neutral / muted color) when the row is NOT part of `applied`, and `Applied` (green, using the `--success` token) when the row IS part of `applied`. A row is "part of `applied`" iff (a) the row is **complete** (it would survive the `draft` → payload conversion), AND (b) there exists a row in `applied.rows` whose `(column, op, value)` triple is structurally equal to the draft row's triple, regardless of either row's `enabled` flag. An **incomplete** row MUST always render the neutral `Apply` state even if its triple matches a row in `applied` — the green "Applied" state MUST never be shown for a row that was not actually sent to the query.

When a row is in the Applied state:
- The button label MUST read `Applied`.
- The row's value input MUST render with the `--success-soft` background tint and a `--success` border.
- The button MUST remain clickable; clicking it MUST re-apply only that row (idempotent).

Activating the per-row Apply button MUST set `applied` to `{ rows: [thisRow], combinator: draft.combinator }`. The button MUST NOT modify `draft`. After a per-row Apply with more than one draft row, the dirty indicator MUST reflect that `draft.rows.length !== applied.rows.length`.

Editing any of `column`, `op`, `value`, or `enabled` on an Applied row MUST cause structural equality with `applied` to break for that row, and the row's Applied state MUST drop to the neutral `Apply` state on the next render.

#### Scenario: Applied state is per-row and based on structural equality

- **WHEN** `applied.rows = [{ column: "status", op: "=", value: "ok", enabled: true }]`
- **AND** `draft.rows[0] = { column: "status", op: "=", value: "ok", enabled: true }`
- **AND** `draft.rows[1] = { column: "id", op: ">", value: "100", enabled: true }`
- **THEN** `draft.rows[0]` renders with the green Applied badge
- **AND** `draft.rows[1]` renders with the neutral Apply button

#### Scenario: Incomplete row never shows the Applied badge

- **WHEN** a draft row is incomplete (e.g. it has no concrete `value`) and a structurally-equal incomplete row also exists in `applied.rows`
- **THEN** the draft row renders with the neutral `Apply` label, NOT the green `Applied` badge
- **AND** the row's value input does NOT render with the `--success` tint

#### Scenario: Editing an applied row drops the Applied badge

- **WHEN** a row is in the Applied state and the user changes its `value` from `"ok"` to `"okay"`
- **THEN** the row's Applied badge becomes the neutral `Apply` label
- **AND** the row's input loses the green tint

#### Scenario: Per-row Apply replaces the active filter with that single row

- **WHEN** `draft` contains three rows and the user clicks the per-row Apply button on the second row (`{ column: "status", op: "=", value: "ok" }`)
- **THEN** `applied.rows === [{ column: "status", op: "=", value: "ok", enabled: ... }]`
- **AND** `applied.combinator === draft.combinator`
- **AND** `draft` is unchanged
- **AND** the dirty indicator shows that `draft ≠ applied`
- **AND** `postgres.queryTable` is invoked with the single-row `filter_tree`

#### Scenario: Per-row Apply on an Applied row is idempotent

- **WHEN** a row is already in the Applied state and the user clicks its `Applied` button
- **THEN** `applied.rows` still equals `[thatRow]`
- **AND** no observable state changes (the fetch is debounced / deduped by the data hook)
