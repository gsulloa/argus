## MODIFIED Requirements

### Requirement: Filter bar surface

The viewer tab SHALL render a filter bar pinned to the top of the data grid, above the column header row and below any tab title chrome. The filter bar MUST be the only filter surface in the data grid — there MUST NOT be a per-column header funnel or popover. Removing the popover MUST NOT remove the existing column-header sort affordance (sort remains accessible from the column header).

The bar MUST always be visible while a `postgres-table-data` tab is mounted; it MUST NOT auto-collapse on scroll. It MAY be collapsed manually by the user via a toggle (chevron) in the bar; the collapsed state MUST NOT discard any draft or applied filters.

The bar MUST contain, in order: a Mode toggle (Structured / Raw SQL), the body for the active mode (the conditions UI for Structured, the WHERE editor for Raw), and an action row with `Reset`, `Apply`, and `Open in SQL Editor`. The `Apply` button MUST be the rightmost primary control.

While the table tab is focused and active AND the keyboard focus is not inside a CodeMirror editor surface (the SQL editor, the Raw WHERE editor, or any future CodeMirror surface), pressing `⌘F` (macOS) / `Ctrl+F` (other) MUST bring keyboard focus into the filter bar's body. The handler MUST resolve the focus target in this order: (a) if the bar is collapsed, expand it first; (b) if the body is in Structured mode and has at least one root child, focus the first row's column picker; (c) if the body is in Structured mode and has no rows, focus the `+ AND row` add button; (d) if the body is in Raw mode, focus the Raw WHERE editor textarea. The handler MUST call `preventDefault()` to suppress any platform/webview default search behavior. The handler MUST NOT fire on other tabs (it is scoped to the active table tab). The handler MUST NOT fire when the active subtab is `Structure` or `Raw` of the viewer tab (those subtabs do not host the filter bar).

#### Scenario: Bar is the only filter surface

- **WHEN** the user opens a `postgres-table-data` tab
- **THEN** the filter bar is rendered above the data grid
- **AND** there is no funnel icon or filter popover trigger on any column header

#### Scenario: Sort affordance survives popover removal

- **WHEN** the user clicks a column header
- **THEN** the existing sort cycle (`asc → desc → none`) fires
- **AND** no filter popover is shown

#### Scenario: Collapsing the bar preserves state

- **WHEN** the bar has applied filters and the user toggles the bar collapsed, then expanded
- **THEN** all applied and draft filters are preserved exactly

#### Scenario: Cmd+F expands a collapsed bar and focuses the first row

- **WHEN** the user has collapsed the bar with one root condition already present and the table tab is focused (focus is somewhere in the grid)
- **AND** the user presses `⌘F` (macOS) or `Ctrl+F` (other)
- **THEN** the bar expands
- **AND** keyboard focus moves to the first row's column picker
- **AND** no browser/webview "find in page" UI appears

#### Scenario: Cmd+F focuses the empty-state add button

- **WHEN** the user has an expanded bar with no rows (empty Structured body) and presses `⌘F` from anywhere outside the bar
- **THEN** keyboard focus moves to the `+ AND row` button in the body's empty state

#### Scenario: Cmd+F focuses the Raw WHERE editor when in Raw mode

- **WHEN** the bar is in Raw mode and the user presses `⌘F` from outside the bar
- **THEN** keyboard focus moves to the Raw WHERE editor textarea

#### Scenario: Cmd+F does not fire from inside a CodeMirror editor

- **WHEN** the user has keyboard focus inside the Raw WHERE editor or any other CodeMirror surface and presses `⌘F`
- **THEN** the tab-level handler does NOT preventDefault
- **AND** CodeMirror's built-in search panel opens

#### Scenario: Cmd+F is scoped to the active tab

- **WHEN** the user has two `postgres-table-data` tabs open, the active tab is Tab A, and Tab B is mounted but not active
- **AND** the user presses `⌘F`
- **THEN** only Tab A's filter bar receives focus; Tab B's filter bar is unaffected

#### Scenario: Cmd+F does not fire on the Structure or Raw subtab

- **WHEN** the user is on the Structure or Raw subtab of a `postgres-table-data` tab and presses `⌘F`
- **THEN** the filter bar (which is not visible) does NOT receive focus
- **AND** the active subtab does not change

### Requirement: Filter draft and applied state

`TableViewerTab` SHALL maintain two filter values for each tab: `draft` and `applied`. Only `applied` MUST be passed to `postgres_query_table` and `postgres_count_table`. Edits to the filter bar MUST update `draft` only. The bar MUST display a dirty indicator (a small `●` adjacent to the `Apply` button) whenever `draft` differs from `applied`. The bar MUST bind `Cmd+Enter` (macOS) / `Ctrl+Enter` (other) to "Apply" and `Esc` to "Discard draft" while focused. Pressing `Apply` MUST set `applied = draft`. Pressing `Reset` MUST set `draft` to the empty filter model AND set `applied` to the empty filter model in one update (clearing both at once). Discarding draft MUST set `draft = applied` (no fetch). Mode toggling rules are described under "Raw WHERE mode".

In addition to the all-or-nothing Apply, each root child of the Structured body MUST render a per-row Apply affordance (a small `▶` icon-button at the row's right edge, `aria-label="Apply only this row"`, tooltip `"Apply only this row (replaces active filter)"`). Activating it MUST set `applied` to a `FilterModel` whose tree contains exactly that one child (preserving the child's full structure — if the child is an OR group, the whole group is applied as the only root child). The per-row Apply MUST NOT modify `draft`. After a per-row Apply, the dirty indicator MUST reflect that `draft` no longer equals `applied` (assuming the draft has more than one row). The compiled WHERE for a single-child applied tree MUST behave identically to a full Apply on a draft that has only that one row.

#### Scenario: Editing a row updates draft only

- **WHEN** the user adds a condition row and types into the value input
- **THEN** the bar dirty indicator becomes visible
- **AND** the data grid does NOT re-fetch
- **AND** `applied` is unchanged

#### Scenario: Apply commits draft and triggers fetch

- **WHEN** the user has a dirty draft and presses `Apply` (or `Cmd+Enter`)
- **THEN** `applied` becomes equal to `draft`
- **AND** the dirty indicator disappears
- **AND** `postgres.queryTable` is invoked with the new `applied` filters

#### Scenario: Esc discards draft to applied

- **WHEN** the user has a dirty draft and presses `Esc` while focused inside the bar
- **THEN** `draft` returns to the value of `applied`
- **AND** the dirty indicator disappears
- **AND** no fetch is triggered

#### Scenario: Reset clears both draft and applied

- **WHEN** the user has applied filters and presses `Reset`
- **THEN** both `draft` and `applied` become empty
- **AND** `postgres.queryTable` is invoked with no `filter_tree` and no `raw_where`

#### Scenario: Per-row Apply replaces the active filter with that single row

- **WHEN** the user has three rows in `draft` and clicks the per-row Apply button on the second row (a condition `status = "ok"`)
- **THEN** `applied` becomes a tree whose only child is `{ kind: "condition", column: { kind: "named", name: "status" }, op: "=", value: "ok" }`
- **AND** `draft` is unchanged (still has all three rows)
- **AND** the dirty indicator shows that `draft ≠ applied`
- **AND** `postgres.queryTable` is invoked with the single-condition `filter_tree`

#### Scenario: Per-row Apply on an OR-group row applies the whole group

- **WHEN** `draft` contains one condition row and one OR group of two conditions, and the user clicks the per-row Apply button on the OR group row
- **THEN** `applied` becomes a tree whose only child is that OR group (with both inner conditions)
- **AND** the compiled WHERE is `(p_or1 OR p_or2)`

#### Scenario: Per-row Apply preserves the root combinator field

- **WHEN** `draft.tree.combinator === "OR"` and the user clicks per-row Apply on any row
- **THEN** `applied.tree.combinator === "OR"` is preserved on the single-child tree (no-op semantically, but the field round-trips)

### Requirement: AND root with OR groups

The Structured filter model SHALL be a tree with an explicit root combinator (`combinator: "AND" | "OR"`, defaulting to `"AND"` when absent). Children of the root are either condition leaves or OR groups. An OR group MUST contain at least one condition leaf and MUST NOT contain another group (one level of nesting maximum). Removing the last condition from an OR group MUST collapse the group node out of the tree. The bar MUST expose two add affordances: `+ AND row` (adds a condition leaf as a sibling of root children) and `+ OR group` (adds an OR group with one empty condition row inside). The names of the add buttons refer to ROW TYPES (single condition vs. OR-group), not to the root combinator — they are stable regardless of `combinator`.

The bar MUST expose a segmented `AND | OR` toggle adjacent to the add buttons that switches the root `combinator` between the two values. The toggle MUST be hidden when the tree has zero children (no semantic effect). When `combinator === "OR"`, the inline inter-row connector pills (between root children) MUST read `"OR"` instead of `"AND"`. Toggling the combinator MUST update `draft.tree.combinator` only (it does NOT auto-apply); the user must press `Apply` for the new combinator to take effect.

The compiled `WHERE` body MUST join root children with `" AND "` or `" OR "` based on `tree.combinator`. Each OR group MUST always be wrapped in parentheses regardless of the root combinator. An empty tree (no children) MUST result in no `WHERE` clause being emitted. The Rust `FilterTree` struct MUST tolerate the absence of the `combinator` field on the wire (`#[serde(default)]` → `RootCombinator::And`).

#### Scenario: Flat AND children compile to ANDed predicates

- **WHEN** the tree has three sibling condition leaves at root and `combinator` is `"AND"` (or absent)
- **THEN** the compiled WHERE is `<p1> AND <p2> AND <p3>` with no parens

#### Scenario: Flat OR children compile to ORed predicates

- **WHEN** the tree has three sibling condition leaves at root and `combinator` is `"OR"`
- **THEN** the compiled WHERE is `<p1> OR <p2> OR <p3>` with no parens

#### Scenario: OR group compiles to a parenthesized OR

- **WHEN** the tree has one root condition and one OR group of two conditions and `combinator` is `"AND"`
- **THEN** the compiled WHERE is `<p_root> AND (<p_or1> OR <p_or2>)`

#### Scenario: OR-root with OR group nests but compiles correctly

- **WHEN** the tree has one root condition and one OR group of two conditions and `combinator` is `"OR"`
- **THEN** the compiled WHERE is `<p_root> OR (<p_or1> OR <p_or2>)`

#### Scenario: OR group with one condition still parenthesizes

- **WHEN** an OR group contains exactly one condition
- **THEN** the compiled WHERE wraps it as `(<p>)` (the parens make the boundary explicit; the result is semantically equivalent)

#### Scenario: Empty OR group is collapsed

- **WHEN** the user removes the last condition from an OR group
- **THEN** the OR group node is removed from the tree
- **AND** the compiled WHERE no longer contains it

#### Scenario: Cannot nest OR group inside OR group

- **WHEN** the frontend attempts to send a tree with an `or_group` inside another `or_group`
- **THEN** the backend returns `AppError::Validation` and no SQL is dispatched

#### Scenario: Empty tree emits no WHERE

- **WHEN** the user has no conditions and no OR groups
- **THEN** the issued SQL has no `WHERE` clause

#### Scenario: Root combinator toggle is hidden when tree is empty

- **WHEN** the tree has zero children
- **THEN** the `AND | OR` toggle is NOT rendered in the body

#### Scenario: Toggling root combinator marks draft dirty

- **WHEN** `draft.tree.combinator === "AND"`, `applied.tree.combinator === "AND"`, and the user clicks the `OR` segment of the toggle
- **THEN** `draft.tree.combinator === "OR"`
- **AND** the dirty indicator appears
- **AND** no fetch is triggered until the user presses `Apply`

#### Scenario: Connector pills re-read when combinator flips

- **WHEN** the tree has three root condition leaves and `combinator` is flipped from `"AND"` to `"OR"`
- **THEN** the two inter-row connector pills displayed between rows read `"OR"` instead of `"AND"`

#### Scenario: Missing combinator on the wire defaults to AND

- **WHEN** the Rust backend receives a `filter_tree` payload that has no `combinator` field
- **THEN** the SQL compiler treats it as `RootCombinator::And` and emits `AND`-joined root predicates

### Requirement: Per-table filter persistence

The frontend SHALL persist the filter bar's `draft` and `applied` `FilterModel` per `(connectionId, schema, relation)` tuple under the settings key `pgTableFilter:<connectionId>:<schema>:<relation>`. The persisted record MUST contain both halves of the bar's state (`{ draft, applied }`) as a single coherent JSON object, so a partial-write (one half stale, the other fresh) is impossible. The persisted record MUST include the root `combinator` field for each tree; when reading a persisted record written before this change (no `combinator` field present), the loader MUST coerce it to `"AND"`.

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
