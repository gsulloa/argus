## ADDED Requirements

### Requirement: Unset operator row state

A structured filter row SHALL be able to carry **no operator**. The client filter
model MUST represent this as `FilterRow.op === null`; the `Operator` union itself
MUST NOT gain an "unset" member, and `null` MUST NEVER be emitted on the wire.

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

The unset state MUST survive persistence: a persisted row with `op: null` (or with
`op` absent) MUST be rehydrated as an unset row, and MUST NOT cause the loader to
discard the persisted filter record.

#### Scenario: Unset row is excluded from the query payload

- **WHEN** `draft.rows` contains an enabled row `{ column: "status", op: null, value: "ok" }` and the user clicks `Apply All`
- **THEN** that row is not present in `applied.rows`
- **AND** no condition for `status` is sent to `postgres_query_table`

#### Scenario: Operator picker shows a placeholder while unset

- **WHEN** a draft row has `op === null`
- **THEN** its operator picker displays the placeholder `—`
- **AND** the placeholder is not selectable
- **AND** the full operator list for that row's column is still offered

#### Scenario: Retained value stays visible and editable while unset

- **WHEN** a row was `{ column: "status", op: "=", value: "ok" }` and its operator becomes unset
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

- **WHEN** the user unsets the operators on a two-row draft and quits Argus
- **AND** the user re-launches Argus and reopens the same table
- **THEN** both rows are restored with their columns and values intact and their operators still unset
- **AND** the persisted filter record was NOT reset to empty

### Requirement: Filter bar footer Unset, Clear all, Export, SQL

The filter bar SHALL render a footer strip with the following controls, in order from left to right:

- `Export` button — disabled / placeholder. `aria-disabled="true"`. Tooltip: `Export coming soon`. Clicking it MUST be a no-op.
- `SQL` button — opens a new `postgres-query` tab on the same connection with a prefilled SELECT reflecting the current `applied` filter set (same behavior as the prior `Open in SQL Editor` action). The button MUST use `applied`, NOT `draft`.
- `Clear all` button — the explicit destructive affordance. Activating it MUST reset all `draft.rows` to a single empty row (`enabled = true`, `column = any_column`, `op = Contains`, `value = ""`). It MUST NOT modify `applied`. It MUST NOT modify `draft.combinator`. To clear the active filtering, the user must subsequently press `Apply All`. It MUST be styled as a neutral footer button (not `--danger`), consistent with `Export` / `SQL`.
- Shortcut hint strip: `Show: ⌘F`, `Insert: ⌘I`, `Remove: ⌘⇧I`, `Apply row: ↵`, `Apply All: ⇧↵`, `Up: ⌘↑`, `Down: ⌘↓`, `Columns: ⌘←`. Each hint MUST be rendered as a non-interactive label using the existing `FilterKeyHint` component. The `Apply row: ↵` and `Apply All: ⇧↵` hints MUST be present so the per-row-Enter / Apply-All-Shift+Enter shortcuts are discoverable.
- `Operator: [Unset]` — a button labeled `Unset`. Activating it MUST clear the **operator selection only**: for every row in `draft.rows` whose `column.kind` is not `"raw"`, `op` becomes `null`. It MUST NOT remove, add or reorder rows. It MUST preserve each row's `id`, `enabled`, `column` and `value`. It MUST leave RAW rows untouched (their operator stays `RAW`). It MUST NOT modify `applied`. It MUST NOT modify `draft.combinator`. Because a row with no operator is incomplete, a subsequent `Apply All` clears the active filtering while every row stays on screen.
- `Apply All ▾` (covered by the "Apply All with persistent root combinator" requirement).

The `Clear all` and `Operator: [Unset]` controls MUST NOT be rendered adjacent to
one another, so the destructive action cannot be mistaken for the operator-scoped
one.

The gear icon (`⚙`) visible in some reference designs MUST NOT be rendered.

#### Scenario: Unset clears operators and keeps every row

- **WHEN** `draft.rows` has three populated rows AND `applied` has those same three rows AND the user clicks `Unset`
- **THEN** `draft.rows.length === 3`
- **AND** each row's `op` is `null`
- **AND** each row's `column`, `value`, `enabled` and `id` are unchanged
- **AND** row order is unchanged
- **AND** `draft.combinator` is unchanged
- **AND** `applied` is unchanged (the grid remains filtered)
- **AND** the dirty indicator now reflects `draft ≠ applied`

#### Scenario: Unset leaves RAW rows alone

- **WHEN** `draft.rows` contains a structured row and a RAW row, and the user clicks `Unset`
- **THEN** the structured row's `op` is `null`
- **AND** the RAW row's `op` is still `RAW` and its expression is unchanged

#### Scenario: Unset followed by Apply All clears the active filter without losing the rows

- **WHEN** the user clicks `Unset` then immediately clicks `Apply All`
- **THEN** `applied.rows === []`
- **AND** the grid is unfiltered
- **AND** `draft.rows` still holds every row the user had built, with their columns and values

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

When visible, the bar MUST contain, top to bottom: a vertical stack of filter rows (each row: checkbox, column picker, operator picker, value input, Apply / Applied button, `−`, `+`), and a single-line footer strip (see "Filter bar footer Unset, Clear all, Export, SQL"). When visible with no persisted rows, the bar MUST render exactly one empty row (the default empty state).

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

The `Apply All` button and the `⇧↵` / `⌘↵` / `⇧⌘↵` shortcuts commit the enabled-complete subset of `draft` to `applied`. Plain `Enter` (no modifier) and the per-row `Apply` button each commit exactly that single focused row to `applied` (see "Per-row Apply and Applied visual state" and "Filter bar keyboard shortcuts"). The `Unset` button clears the operator on every non-RAW `draft` row and the `Clear all` button resets `draft.rows`; neither touches `applied` (see "Filter bar footer Unset, Clear all, Export, SQL").

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
- **AND** the closest equivalent is `Clear all` which clears `draft.rows` only (see "Filter bar footer Unset, Clear all, Export, SQL")

#### Scenario: Unset does not delete rows

- **WHEN** the user has three populated draft rows and clicks `Unset`
- **THEN** all three rows are still rendered with their columns and values
- **AND** `applied` is unchanged

### Requirement: Raw SQL filter row

The filter bar SHALL let the user add a **RAW** filter row that carries a free-form SQL boolean expression, so that predicates the structured operators cannot express — most notably reaching inside `jsonb` columns (`->`, `->>`, `@>`, `?`, …) — are reachable from the data grid.

A RAW row is entered through the column picker: in addition to the named columns and the existing `Any column` pseudo-entry, the picker MUST offer a `Raw SQL` entry. Selecting `Raw SQL` MUST set the row's column to `{ kind: "raw" }` and fix its operator to `RAW`. While a row is in RAW mode:

- The operator picker MUST be hidden or disabled (the operator is implicitly `RAW`).
- In place of the structured value input, the row MUST render a single free-form expression input that spans the operator+value region, using the monospace token from `DESIGN.md`, with a placeholder illustrating the intended use (e.g. `data->>'estado' = 'activo'`).
- The row MUST retain its checkbox, per-row `Apply` / `Applied` affordance, and `−` / `+` buttons, identical to every other row.
- The footer `Operator: [Unset]` control MUST leave the row untouched — a RAW row has no user-chosen operator to deselect, and no picker with which to restore one.

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

- **WHEN** the user clicks `Operator: [Unset]` with a RAW row in the draft
- **THEN** the RAW row's operator is still `RAW`
- **AND** its expression is unchanged
- **AND** it still compiles into the footer `SQL` preview once applied

#### Scenario: Footer SQL preview shows the RAW expression verbatim

- **WHEN** the user has an applied RAW row `data->>'estado' = 'activo'` and opens the footer `SQL` preview
- **THEN** the previewed `WHERE` contains `(data->>'estado' = 'activo')` verbatim, joined with any other rows under the root combinator

### Requirement: Per-table filter persistence

The frontend SHALL persist the filter bar's `draft` and `applied` `FilterModel` per `(connectionId, schema, relation)` tuple under the settings key `pgTableFilter:<connectionId>:<schema>:<relation>`. The persisted record MUST contain both halves of the bar's state (`{ draft, applied }`) as a single coherent JSON object, so a partial-write (one half stale, the other fresh) is impossible. The persisted record MUST include the root `combinator` field for each tree; when reading a persisted record written before this change (no `combinator` field present), the loader MUST coerce it to `"AND"`.

The loader MUST accept a row whose `op` is `null` or absent and rehydrate it as an unset-operator row (see "Unset operator row state"). It MUST NOT treat a missing operator as a corrupt record, and MUST NOT discard the persisted record — either half of it — on that basis. A missing or non-object `column` MUST still cause the record to reset to the empty model, as today.

The persisted filter MUST survive: switching to a different tab and back, closing the table tab and reopening it, switching to a different connection and back, and restarting the app. The persisted filter MUST NOT be cleared by any of those events.

The persisted filter MUST be cleared *only* when the user explicitly invokes one of:
- the filter bar's `Reset` button,
- the bottom bar's `Clear filters` chip / affordance.

When the persisted filter references a column that no longer exists (schema drift), the system MUST surface the resulting `AppError::Postgres` through the same UI paths as today (inline near the Raw editor when in Raw mode; the existing first-load error banner when in Structured mode). The system MUST NOT auto-prune predicates or silently drop the persisted filter on schema drift.

The setting MUST be scoped per connection — two connections inspecting the same `<schema>.<relation>` MUST NOT share filter state.

#### Scenario: Default filter is empty

- **WHEN** the user opens a table tab for the first time and no setting is stored
- **THEN** the filter bar shows the empty filter model (no rows, no raw body) and `applied` is empty
- **AND** the first `postgres.queryTable` invocation has neither `filter_tree` nor `raw_where`

#### Scenario: Filter persists across tab switches

- **WHEN** the user has applied a Structured filter on `public.users` and clicks a different tab
- **AND** the user clicks back to the `public.users` tab
- **THEN** both the filter bar `draft` and the `applied` filter are restored exactly as they were
- **AND** the data grid reflects the restored `applied` filter (no spurious empty-filter fetch is visible)

#### Scenario: Filter persists across tab close + reopen

- **WHEN** the user has applied a filter on `public.users`, closes that tab, and reopens `public.users` from the schema browser
- **THEN** the filter bar shows the previously applied filter as both `draft` and `applied`

#### Scenario: Filter persists across app restart

- **WHEN** the user has applied a filter on `public.users` and quits Argus
- **AND** the user re-launches Argus and opens `public.users`
- **THEN** the filter bar shows the previously applied filter as both `draft` and `applied`

#### Scenario: Mid-edit draft persists on tab switch

- **WHEN** the user has typed a partial value into a filter row but has NOT pressed Apply, and switches tabs
- **AND** the user returns to the table's tab
- **THEN** the unapplied draft is preserved exactly (including the dirty indicator showing draft ≠ applied)

#### Scenario: Reset clears the persisted filter

- **WHEN** the user has applied filters and clicks `Reset` in the filter bar
- **THEN** both `draft` and `applied` become empty
- **AND** the next time the user reopens that table the filter is still empty (the persisted record was cleared)

#### Scenario: Persisted row with a null operator is rehydrated, not discarded

- **WHEN** the persisted record contains `draft.rows = [{ column: { kind: "named", name: "status" }, op: null, value: "ok" }]` and a non-empty `applied`
- **AND** the user opens that table
- **THEN** the draft row is restored with its column and value and an unset operator
- **AND** `applied` is restored unchanged (the record is NOT reset to the empty model)

#### Scenario: BottomBar Clear filters clears the persisted filter

- **WHEN** the user has applied filters and clicks the bottom bar's `Clear filters` chip
- **THEN** both `draft` and `applied` become empty and the persisted record is cleared

#### Scenario: Filter is per connection

- **WHEN** the user has applied a filter for `connectionA.public.users` and opens `connectionB.public.users`
- **THEN** `connectionB.public.users` shows the empty filter model, not `connectionA`'s filter

#### Scenario: Schema drift surfaces a Postgres error and does not auto-clear

- **WHEN** the persisted filter references a column that no longer exists in the relation
- **AND** the user opens that table
- **THEN** the data grid surfaces an `AppError::Postgres` (e.g. `42703 undefined_column`) through the existing error UX
- **AND** the persisted filter is unchanged (the user can choose to `Reset` or to fix the predicate)

#### Scenario: Persisted record without combinator field is loaded as AND

- **WHEN** the user opens a table whose persisted filter record was written before this change (no `combinator` field on the tree)
- **THEN** the loader coerces both `draft.tree.combinator` and `applied.tree.combinator` to `"AND"`
- **AND** the filter bar renders the tree with the `AND` toggle selected
- **AND** the compiled WHERE matches the pre-change behavior

#### Scenario: Combinator round-trips through persistence

- **WHEN** the user toggles the root combinator to `"OR"` and applies, then quits and re-launches Argus
- **THEN** the persisted record contains `combinator: "OR"` on both `draft.tree` and `applied.tree`
- **AND** reopening the table restores the toggle in the `OR` position

## REMOVED Requirements

### Requirement: Filter bar footer Unset, Export, SQL

**Reason**: Superseded by "Filter bar footer Unset, Clear all, Export, SQL". The
old requirement defined `Operator: [Unset]` as a control that resets every draft
row to a single empty row — a destructive wipe behind an operator-scoped label
(issue #278). Its two Unset scenarios ("Unset clears draft rows to a single empty
row", "Unset followed by Apply All clears the active filter") assert behaviour
that no longer exists and are dropped rather than rewritten in place.

**Migration**: No user or data migration. The replacement requirement keeps every
non-Unset control identical (`Export`, `SQL`, the shortcut hint strip,
`Apply All ▾`), redefines `Unset` as operator-scoped, and moves the wipe
behaviour to a new `Clear all` button — so the capability the old scenarios
covered is still reachable, under its own label.
