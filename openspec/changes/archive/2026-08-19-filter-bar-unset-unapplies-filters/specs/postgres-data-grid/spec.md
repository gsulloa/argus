## ADDED Requirements

### Requirement: Filter bar footer controls

The filter bar SHALL render a footer strip with the following controls, in order from left to right:

- `Export` button — disabled / placeholder. `aria-disabled="true"`. Tooltip: `Export coming soon`. Clicking it MUST be a no-op.
- `SQL` button — opens a new `postgres-query` tab on the same connection with a prefilled SELECT reflecting the current `applied` filter set (same behavior as the prior `Open in SQL Editor` action). The button MUST use `applied`, NOT `draft`.
- `Clear all` button — the explicit destructive affordance. Activating it MUST reset all `draft.rows` to a single empty row (`enabled = true`, `column = any_column`, `op = Contains`, `value = ""`). It MUST NOT modify `applied`. It MUST NOT modify `draft.combinator`. To clear the active filtering, the user must subsequently press `Apply All`. It MUST be styled as a neutral footer button (not `--danger`), consistent with `Export` / `SQL`.
- Shortcut hint strip: `Show: ⌘F`, `Insert: ⌘I`, `Remove: ⌘⇧I`, `Apply row: ↵`, `Apply All: ⇧↵`, `Up: ⌘↑`, `Down: ⌘↓`, `Columns: ⌘←`. Each hint MUST be rendered as a non-interactive label using the existing `FilterKeyHint` component. The `Apply row: ↵` and `Apply All: ⇧↵` hints MUST be present so the per-row-Enter / Apply-All-Shift+Enter shortcuts are discoverable.
- `Filters: [Unset]` — a button labeled `Unset`, prefixed by the static label `Filters:`. Its tooltip MUST convey that the filter form is preserved (e.g. `Stop applying the filters — the filter form is kept as is`). Activating it MUST **stop the grid from filtering without altering the filter form**:
  - `applied.rows` MUST become `[]`, and `applied.combinator` MUST be set from `draft.combinator`.
  - `draft` MUST be left entirely unchanged — no row is added, removed or reordered, and every row's `id`, `enabled`, `column`, `op` and `value` MUST be preserved verbatim. In particular, operators MUST NOT be cleared. `draft.combinator` MUST be unchanged.
  - It MUST trigger a refetch (see "Filter Apply always refetches").
  - It MUST NOT be reachable by any path that mutates `draft`; the filter bar MUST surface it as a callback to the tab (alongside `Apply All` / per-row `Apply`), not as a draft mutation.
- `Apply All ▾` (covered by the "Apply All with persistent root combinator" requirement).

The `Clear all` and `Filters: [Unset]` controls MUST NOT be rendered adjacent to
one another, so the destructive action cannot be mistaken for the
form-preserving one.

The gear icon (`⚙`) visible in some reference designs MUST NOT be rendered.

#### Scenario: Unset stops filtering and leaves the form identical

- **WHEN** `draft.rows` has three populated rows AND `applied` has those same three rows AND the user clicks `Unset`
- **THEN** `applied.rows === []`
- **AND** the grid refetches unfiltered
- **AND** `draft.rows.length === 3`
- **AND** each row's `column`, `op`, `value`, `enabled` and `id` are unchanged
- **AND** row order is unchanged
- **AND** `draft.combinator` is unchanged
- **AND** the dirty indicator now reflects `draft ≠ applied`

#### Scenario: Unset preserves operator selections

- **WHEN** `draft.rows` contains `{ column: "status", op: "=", value: "ok" }` and the user clicks `Unset`
- **THEN** that row's operator picker still shows `=`
- **AND** no row's `op` becomes `null`

#### Scenario: Apply All after Unset restores the same filtering in one gesture

- **WHEN** the user clicks `Unset` and then clicks `Apply All` without editing any row
- **THEN** `applied.rows` equals the enabled-complete subset of `draft.rows` it held before `Unset`
- **AND** the grid is filtered exactly as it was before `Unset`
- **AND** the user did not have to re-select any operator

#### Scenario: Unset clears the bottom-bar filter count

- **WHEN** `applied.rows` has two rows, so the bottom bar shows a `2 filters` chip, and the user clicks `Unset`
- **THEN** the filter chip is no longer rendered
- **AND** the filter bar still shows both rows

#### Scenario: Clear all resets draft rows to a single empty row

- **WHEN** `draft.rows` has three populated rows AND `applied` has those same three rows AND the user clicks `Clear all`
- **THEN** `draft.rows.length === 1`
- **AND** the single remaining row has the default empty state
- **AND** `draft.combinator` is unchanged
- **AND** `applied` is unchanged (the grid remains filtered)
- **AND** the dirty indicator now reflects `draft ≠ applied`

#### Scenario: Clear all followed by Apply All clears the active filter

- **WHEN** the user clicks `Clear all` then immediately clicks `Apply All`
- **THEN** `applied.rows === []`
- **AND** the grid is unfiltered

#### Scenario: SQL button uses applied, not draft

- **WHEN** the user has dirty draft rows (different from `applied`) and clicks `SQL`
- **THEN** the opened SQL editor tab is prefilled with a SELECT that uses the current `applied` filter set
- **AND** the unapplied draft does NOT appear in the prefilled SQL

#### Scenario: Footer documents the Enter and Shift+Enter shortcuts

- **WHEN** the user inspects the filter-bar footer hint strip
- **THEN** a `Apply row: ↵` hint is rendered
- **AND** a `Apply All: ⇧↵` hint is rendered

#### Scenario: Export button is disabled

- **WHEN** the user inspects the footer `Export` button
- **THEN** it is disabled with `aria-disabled="true"` and tooltip `Export coming soon`
- **AND** clicking it performs no action

## MODIFIED Requirements

### Requirement: Filter bar surface

The viewer tab SHALL conditionally render a filter bar pinned above the column header row and below any tab title chrome. The filter bar MUST be the only filter surface in the data grid — there MUST NOT be a per-column header funnel or popover. Removing the popover MUST NOT remove the existing column-header sort affordance (sort remains accessible from the column header).

The bar MUST be **hidden by default** when a `postgres-table-data` tab is first opened (no persisted preference). When hidden, the bar MUST NOT reserve vertical space — the column header row MUST sit flush against the upper tab chrome. The user MUST be able to toggle the bar visible via either (a) the `Filter` icon button in the subtab header chrome, or (b) the `⌘F` (macOS) / `Ctrl+F` (other) keyboard shortcut. Visibility MUST be persisted per-table (see "Filter bar visibility persistence"). The previous chevron-collapse control inside the bar's header is REMOVED — there is no "collapse but stay reserving space" intermediate state.

When visible, the bar MUST contain, top to bottom: a vertical stack of filter rows (each row: checkbox, column picker, operator picker, value input, Apply / Applied button, `−`, `+`), and a single-line footer strip (see "Filter bar footer controls"). When visible with no persisted rows, the bar MUST render exactly one empty row (the default empty state).

The `⌘F` shortcut MUST resolve as follows (the handler MUST call `preventDefault()` unless explicitly noted, and MUST be scoped to the active table tab on the `Data` subtab):
- If the bar is **hidden**: show the bar AND move focus to the first row's value input.
- If the bar is **visible** and focus is **outside** the bar: move focus to the first row's value input.
- If the bar is **visible** and focus is **inside** the bar: hide the bar (preserve `draft` and `applied`).

The handler MUST NOT fire on the `Structure` or `Raw` subtab. The handler MUST NOT fire when focus is inside a CodeMirror editor surface (allowing CodeMirror's built-in search to open).

#### Scenario: Bar is hidden by default

- **WHEN** the user opens a `postgres-table-data` tab for the first time
- **THEN** the filter bar is not rendered
- **AND** the column header row sits immediately under the subtab header chrome (no reserved space)

#### Scenario: Bar is the only filter surface

- **WHEN** the user toggles the bar visible
- **THEN** the filter bar is rendered above the data grid
- **AND** there is no funnel icon or filter popover trigger on any column header

#### Scenario: Sort affordance survives popover removal

- **WHEN** the user clicks a column header
- **THEN** the existing sort cycle (`asc → desc → none`) fires
- **AND** no filter popover is shown

#### Scenario: Cmd+F shows a hidden bar and focuses the first row

- **WHEN** the bar is hidden and the user presses `⌘F` (macOS) / `Ctrl+F` (other) while the Data subtab is active
- **THEN** the filter bar becomes visible
- **AND** keyboard focus moves to the first row's value input (or the column picker if the value input is not yet present, per implementation)
- **AND** no browser/webview "find in page" UI appears

#### Scenario: Cmd+F focuses an already-visible bar

- **WHEN** the bar is visible, focus is somewhere in the grid, and the user presses `⌘F`
- **THEN** keyboard focus moves into the first row of the bar
- **AND** the bar's visibility is unchanged

#### Scenario: Cmd+F hides a focused bar

- **WHEN** the bar is visible, focus is inside one of its inputs, and the user presses `⌘F`
- **THEN** the bar becomes hidden
- **AND** `draft` and `applied` are preserved
- **AND** focus moves to a sensible fallback (the data grid root, or the tab root)

#### Scenario: Cmd+F does not fire from inside a CodeMirror editor

- **WHEN** focus is inside any CodeMirror surface and the user presses `⌘F`
- **THEN** the filter bar handler does NOT fire
- **AND** CodeMirror's built-in search panel opens

#### Scenario: Cmd+F is scoped to the active tab and Data subtab

- **WHEN** two `postgres-table-data` tabs are open, the active tab is Tab A on its Data subtab, and the user presses `⌘F`
- **THEN** only Tab A's filter bar visibility / focus changes
- **WHEN** the user is on the Structure or Raw subtab of a `postgres-table-data` tab and presses `⌘F`
- **THEN** the filter bar handler does NOT fire

### Requirement: Filter draft and applied state

`TableViewerTab` SHALL maintain two filter values for each tab: `draft` and `applied`, each of shape `FilterTree = { rows: FilterRow[], combinator: "AND" | "OR" }`. Only `applied` MUST be passed (after wire-shape conversion) to `postgres_query_table` and `postgres_count_table`. Edits to the filter bar (text input, operator changes, column changes, checkbox toggles, row insertions/removals, combinator menu picks) MUST update `draft` only. The bar MUST display a dirty indicator (a small `●` adjacent to the `Apply All` button) whenever `draft` differs from `applied`.

The `Apply All` button and the `⇧↵` / `⌘↵` / `⇧⌘↵` shortcuts commit the enabled-complete subset of `draft` to `applied`. Plain `Enter` (no modifier) and the per-row `Apply` button each commit exactly that single focused row to `applied` (see "Per-row Apply and Applied visual state" and "Filter bar keyboard shortcuts"). The footer `Unset` button writes `applied` directly — it sets `applied.rows` to `[]` and MUST NOT modify `draft` in any way. The `Clear all` button resets `draft.rows` and MUST NOT touch `applied`. (Both are covered by "Filter bar footer controls".)

The previous `Reset` button and `Esc` discard-draft shortcut are REMOVED. There is no single-keystroke "revert draft to applied" affordance in the new design.

Mode toggling is REMOVED — the bar has no Structured/Raw mode toggle. The filter bar is always in Structured mode. Switching to Raw is only reachable indirectly via `SQL` (footer button) which opens the SQL Editor with a compiled WHERE.

#### Scenario: Editing a row updates draft only

- **WHEN** the user types into a row's value input
- **THEN** the dirty indicator becomes visible
- **AND** the data grid does NOT re-fetch
- **AND** `applied` is unchanged

#### Scenario: Apply All commits draft and triggers fetch

- **WHEN** the user has a dirty draft and clicks `Apply All` (or presses `⇧↵` / `⌘↵`)
- **THEN** `applied` becomes equal to the enabled-complete subset of `draft.rows` joined by `draft.combinator`
- **AND** the dirty indicator disappears (because remaining draft rows match applied rows by structural equality)
- **AND** `postgres.queryTable` is invoked with the new `applied` filters

#### Scenario: Plain Enter commits only the focused row

- **WHEN** the user has three rows in `draft` and presses plain `Enter` (no modifier) while focus is inside the second row
- **THEN** `applied.rows === [thatRow]`
- **AND** `applied.combinator === draft.combinator`
- **AND** `draft` is unchanged

#### Scenario: Esc no longer discards draft

- **WHEN** the user has a dirty draft and presses `Esc` while focused inside the bar
- **THEN** `draft` is unchanged
- **AND** the dirty indicator remains visible
- **AND** no fetch is triggered

#### Scenario: Per-row Apply replaces the active filter with that single row

- **WHEN** the user has three rows in `draft` and clicks the per-row Apply button on the second row
- **THEN** `applied.rows === [thatRow]`
- **AND** `applied.combinator === draft.combinator`
- **AND** `draft` is unchanged

#### Scenario: There is no Reset button

- **WHEN** the user inspects the filter bar's UI
- **THEN** there is no `Reset` button anywhere in the bar (footer or otherwise)
- **AND** the closest equivalent is `Clear all` which clears `draft.rows` only (see "Filter bar footer controls")

#### Scenario: Unset does not delete rows

- **WHEN** the user has three populated draft rows, all applied, and clicks `Unset`
- **THEN** all three rows are still rendered with their columns, operators and values
- **AND** `draft` is unchanged
- **AND** `applied.rows === []`
- **AND** the dirty indicator becomes visible

### Requirement: Raw SQL filter row

The filter bar SHALL let the user add a **RAW** filter row that carries a free-form SQL boolean expression, so that predicates the structured operators cannot express — most notably reaching inside `jsonb` columns (`->`, `->>`, `@>`, `?`, …) — are reachable from the data grid.

A RAW row is entered through the column picker: in addition to the named columns and the existing `Any column` pseudo-entry, the picker MUST offer a `Raw SQL` entry. Selecting `Raw SQL` MUST set the row's column to `{ kind: "raw" }` and fix its operator to `RAW`. While a row is in RAW mode:

- The operator picker MUST be hidden or disabled (the operator is implicitly `RAW`).
- In place of the structured value input, the row MUST render a single free-form expression input that spans the operator+value region, using the monospace token from `DESIGN.md`, with a placeholder illustrating the intended use (e.g. `data->>'estado' = 'activo'`).
- The row MUST retain its checkbox, per-row `Apply` / `Applied` affordance, and `−` / `+` buttons, identical to every other row.
- The footer `Filters: [Unset]` control MUST leave the row untouched — as it MUST leave every other draft row untouched, it only clears `applied`.

A RAW row is **complete** (eligible for `Apply All` and per-row `Apply`) iff its expression is a non-empty, non-whitespace string. Incomplete RAW rows MUST be excluded from the wire payload exactly as incomplete structured rows are.

RAW rows MUST combine with structured rows: they are emitted into the same `filter_tree` and joined with the other enabled-complete rows under the bar's root combinator (`AND` / `OR`). The user MUST be able to clear a RAW row the same way as any other row — via its `−` button or via `Clear all` (which clears all draft rows). Switching a row's column back from `Raw SQL` to a named column or `Any column` MUST restore the structured operator + value inputs.

The footer `SQL` preview and any copy-WHERE / export-of-WHERE path MUST render a RAW row's expression verbatim (wrapped in parentheses) interleaved with the parametrized fragments of the other rows, consistent with what the backend executes.

#### Scenario: Raw SQL entry appears in the column picker

- **WHEN** the user opens a filter row's column picker
- **THEN** a `Raw SQL` entry is listed alongside the named columns and the `Any column` entry

#### Scenario: Selecting Raw SQL switches the row to an expression input

- **WHEN** the user picks `Raw SQL` in a row's column picker
- **THEN** the operator picker is no longer shown (the operator is fixed to `RAW`)
- **AND** a single free-form expression input is rendered in place of the structured value input, with a `jsonb` example placeholder

#### Scenario: Empty RAW row is not applied

- **WHEN** the user has a RAW row with an empty expression and clicks `Apply All`
- **THEN** the RAW row is omitted from the applied filter and from the wire payload
- **AND** no `RAW` condition is sent to `postgres_query_table`

#### Scenario: RAW row queries inside a jsonb column and combines with a structured row

- **WHEN** the user has an enabled structured row `country = 'CL'` and an enabled RAW row `data->>'estado' = 'activo'` with the root combinator `AND`, and clicks `Apply All`
- **THEN** the grid re-fetches with a `filter_tree` containing both conditions
- **AND** only rows where `country = 'CL'` AND `data->>'estado' = 'activo'` are returned

#### Scenario: RAW row is cleared like any other row

- **WHEN** the user clicks the `−` button on a RAW row (or clicks `Clear all`)
- **THEN** the RAW row is removed from the draft
- **AND** the remaining rows are unaffected

#### Scenario: Unset does not disturb a RAW row

- **WHEN** the user clicks `Filters: [Unset]` with a RAW row in the draft
- **THEN** the RAW row's operator is still `RAW`
- **AND** its expression is unchanged
- **AND** it recompiles into the footer `SQL` preview as soon as it is applied again

#### Scenario: Footer SQL preview shows the RAW expression verbatim

- **WHEN** the user has an applied RAW row `data->>'estado' = 'activo'` and opens the footer `SQL` preview
- **THEN** the previewed `WHERE` contains `(data->>'estado' = 'activo')` verbatim, joined with any other rows under the root combinator

### Requirement: Filter Apply always refetches

Every commit to `applied` (via **Apply All**, the `⇧↵` / `⌘↵` / `⇧⌘↵` shortcuts, the per-row **Apply** button, plain `Enter` applying the focused row, or the footer **Unset** button) MUST cause `postgres.queryTable` to be invoked, even when the resulting `applied` value is structurally equal to the previous `applied` value. The user's Apply or Unset gesture SHALL be treated as an explicit refresh signal, not merely as a state-equality trigger.

The implementation MUST NOT rely solely on structural equality of `applied` to decide whether to refetch. A monotonically-advancing token (or equivalent mechanism) MUST be threaded into the data-fetch dependency key so that pressing Apply with an unchanged filter model still produces a network round-trip and a fresh first page.

This requirement explicitly overrides any optimisation that would dedupe a fetch on the grounds that "the filter model didn't change". Edits to `draft` that never reach `applied` MUST still NOT trigger a fetch (the `Editing a row updates draft only` scenario in `Filter draft and applied state` is preserved).

#### Scenario: Re-applying the same filter value refetches

- **WHEN** the user has `applied.rows = [{column: "n", op: "=", value: "1"}]` showing a stale result set
- **AND** the user clears the value input to empty (still in `draft`, not committed)
- **AND** the user re-enters `"1"` and clicks `Apply All`
- **THEN** `applied` is structurally equal to its previous value
- **AND** `postgres.queryTable` is invoked again
- **AND** the grid displays the freshly-fetched rows, including any rows created externally since the previous Apply

#### Scenario: Plain Enter refetches even when the single row is unchanged

- **WHEN** `applied.rows === [R1]` and the user presses plain `Enter` while focused in the same `R1` in `draft`
- **THEN** `applied` is structurally equal to its previous value
- **AND** `postgres.queryTable` is invoked again

#### Scenario: Per-row Apply refetches even when the single row is unchanged

- **WHEN** `applied.rows === [R1]` and the user clicks the per-row Apply on the same `R1` in `draft`
- **THEN** `applied` is structurally equal to its previous value
- **AND** `postgres.queryTable` is invoked again

#### Scenario: Empty Apply with already-empty applied still refetches

- **WHEN** `applied.rows === []` (no filters) and the user presses `Apply All` from a draft with no enabled-complete rows
- **THEN** `postgres.queryTable` is invoked again with no `filter_tree` and no `raw_where`
- **AND** the inline `No filters enabled` status appears (existing behaviour preserved)

#### Scenario: Unset with already-empty applied still refetches

- **WHEN** `applied.rows === []` and the user clicks `Unset`
- **THEN** `postgres.queryTable` is invoked again with no `filter_tree` and no `raw_where`
- **AND** `draft` is unchanged

#### Scenario: Editing draft without Apply still does not fetch

- **WHEN** the user types into a row's value input without pressing Apply
- **THEN** `postgres.queryTable` is NOT invoked
- **AND** `applied` is unchanged

### Requirement: Unset operator row state

A structured filter row SHALL be able to carry **no operator**. The client filter
model MUST represent this as `FilterRow.op === null`; the `Operator` union itself
MUST NOT gain an "unset" member, and `null` MUST NEVER be emitted on the wire.

This state is **legacy-only**: it exists so filter records persisted by v0.8.6 —
whose footer `Operator: Unset` control wrote `op: null` onto every non-RAW draft
row — keep loading and stay repairable. No affordance in the filter bar MAY
produce a `null` operator: `Unset` no longer touches `draft` (see "Filter bar
footer controls"), the operator picker cannot select the placeholder, and no
other control clears an operator. The readers of the state MUST nevertheless be
retained, since removing them would make a v0.8.6 record fail validation and
discard the user's entire persisted filter for that table.

A row whose `op` is `null` MUST be treated as **incomplete**: it MUST be excluded
from the `filter_tree` payload sent to `postgres_query_table` /
`postgres_count_table`, from the compiled WHERE used by the footer `SQL`
affordance, and from the enabled-complete subset that `Apply All` commits. It
MUST NOT render the green `Applied` badge (already required of every incomplete
row). Its `enabled` checkbox state MUST be preserved and MUST remain togglable.

The row MUST remain fully editable and fully recoverable:

- Its operator picker MUST render a non-selectable placeholder entry (`—`) as the
  displayed value while `op` is `null`. The placeholder MUST NOT appear in the
  option list once a real operator is selected, so a row can never be returned to
  the unset state from the picker itself.
- Its `column` and `value` MUST be preserved verbatim while the operator is unset.
  The value control MUST be chosen from the **shape of the retained value** (array
  → chip input, `{ min, max }` → range inputs, otherwise the scalar input for the
  column's category) so the retained value stays visible and editable.
- Selecting an operator from the picker MUST apply the standard operator-switch
  value coercion (the same coercion used when changing between two real
  operators), so a value whose shape fits the newly chosen operator survives.
- Changing an unset row's **column** MUST leave the operator unset (the row's new
  column offers a new operator list; nothing is auto-selected) and MUST leave the
  value untouched, including for boolean columns — the eager `true` seeding that
  a column change normally performs applies only once a real operator is chosen.

A RAW row (`column.kind === "raw"`) MUST NOT be given a `null` operator; its
operator stays fixed at `RAW`.

The state MUST survive persistence: a persisted row with `op: null` (or with
`op` absent) MUST be rehydrated as an unset row, and MUST NOT cause the loader to
discard the persisted filter record.

#### Scenario: No filter-bar control produces a null operator

- **WHEN** the user exercises every filter-bar control — `Unset`, `Clear all`, `Apply All`, per-row `Apply`, the column picker, the operator picker, the value inputs, the row checkbox, insert/remove, drag-reorder and the combinator menu
- **THEN** no `draft` row ever ends up with `op === null`

#### Scenario: Unset row is excluded from the query payload

- **WHEN** `draft.rows` contains an enabled row `{ column: "status", op: null, value: "ok" }` rehydrated from a v0.8.6 record and the user clicks `Apply All`
- **THEN** that row is not present in `applied.rows`
- **AND** no condition for `status` is sent to `postgres_query_table`

#### Scenario: Operator picker shows a placeholder while unset

- **WHEN** a draft row has `op === null`
- **THEN** its operator picker displays the placeholder `—`
- **AND** the placeholder is not selectable
- **AND** the full operator list for that row's column is still offered

#### Scenario: Retained value stays visible and editable while unset

- **WHEN** a rehydrated row is `{ column: "status", op: null, value: "ok" }`
- **THEN** the row still shows column `status` and value `ok`
- **AND** the user can keep typing in the value input

#### Scenario: Choosing an operator restores a working row

- **WHEN** a row is `{ column: "status", op: null, value: "ok" }` and the user picks `=` in its operator picker
- **THEN** the row becomes `{ column: "status", op: "=", value: "ok" }`
- **AND** clicking `Apply All` sends a `status = 'ok'` condition

#### Scenario: Choosing an operator coerces an incompatible retained value

- **WHEN** a row is `{ column: "id", op: null, value: ["1", "2"] }` and the user picks `BETWEEN`
- **THEN** the row's value becomes `{ min: "", max: "" }`
- **AND** the row is incomplete until both bounds are filled

#### Scenario: Changing the column of an unset row keeps it unset

- **WHEN** a row is `{ column: "status", op: null, value: "ok" }` and the user picks a different column
- **THEN** the row's `op` is still `null`
- **AND** the row's value is still `ok`
- **AND** the operator picker still shows the placeholder, now listing the new column's operators

#### Scenario: Unset row never shows the Applied badge

- **WHEN** a draft row has `op === null` and a structurally-equal row exists in `applied.rows`
- **THEN** the row renders the neutral `Apply` label, not the green `Applied` badge

#### Scenario: Per-row Apply on an unset row leaves the grid unfiltered

- **WHEN** the user clicks the per-row `Apply` button on a row whose `op` is `null`
- **THEN** `applied.rows === [thatRow]`
- **AND** `postgres.queryTable` is invoked with no `filter_tree` (the incomplete row is dropped)
- **AND** the grid is unfiltered

#### Scenario: Unset operator survives app restart

- **WHEN** the persisted `pgTableFilter:*` record for a table holds two rows with `op: null` and their columns and values
- **AND** the user re-launches Argus and reopens the same table
- **THEN** both rows are restored with their columns and values intact and their operators still showing the `—` placeholder
- **AND** the persisted filter record was NOT reset to empty

## REMOVED Requirements

### Requirement: Filter bar footer Unset, Clear all, Export, SQL

**Reason**: The footer's `Unset` control changed scope — it no longer clears the
operator on every draft row, it clears `applied` and leaves the whole filter form
in place. Two of this requirement's scenarios (`Unset clears operators and keeps
every row`, `Unset followed by Apply All clears the active filter without losing
the rows`) assert the superseded behaviour and cannot be reworded truthfully, so
the requirement is replaced wholesale rather than amended.

**Migration**: Replaced by "Filter bar footer controls", which carries the same
`Export` / `SQL` / `Clear all` / hint-strip / `Apply All ▾` obligations verbatim
and restates the `Unset` control as `Filters: [Unset]` with applied-scoped
semantics. Cross-references in "Filter bar surface", "Filter draft and applied
state" and "Raw SQL filter row" are updated to the new name.
