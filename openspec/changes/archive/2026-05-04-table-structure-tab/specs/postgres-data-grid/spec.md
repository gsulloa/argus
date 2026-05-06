## MODIFIED Requirements

### Requirement: Per-table viewer tab

The frontend SHALL register a tab kind `postgres-table-data` and SHALL render it when the user activates a table, view, or materialized view in the schema tree. The tab's payload MUST be `{ connectionId, connectionName, schema, relation, relationKind: "table" | "view" | "materialized-view" }`. The tab MUST have a stable id `pgtbl:<connectionId>:<schema>:<relation>` so that re-activating the same node focuses the existing tab rather than opening a duplicate. Activating any other object kind (function, type, extension, index, trigger) MUST continue to open the existing `postgres-object-placeholder` tab. The viewer tab MUST persist its scroll position across tab switches inside the same session (not across app restarts).

The viewer tab body SHALL render an internal sub-tabset with three tabs in this order: **Data**, **Structure**, **Raw**. The sub-tabset header MUST be a segmented control rendered above the body of all three subtabs and MUST be visible regardless of which subtab is active. Only one subtab is rendered at a time.

The Data subtab MUST host the existing data UI (filter bar, virtualized data grid, inspector, bottom bar, edit affordances) without behavior changes. The Structure and Raw subtabs MUST be rendered by components owned by the `postgres-table-structure` capability and receive `{ connectionId, schema, relation, relationKind }` as props.

The active subtab is per-tab in-memory state with these rules:

- A freshly opened table tab MUST start on **Data**.
- Switching to a different browser tab and back to the table tab MUST preserve the active subtab.
- Closing and reopening the table tab MUST reset the active subtab to **Data** (no persistence across tab close).
- The active subtab MUST NOT be persisted across app restarts.

While the table tab is focused AND the keyboard focus is not inside an `<input>`, `<textarea>`, or a CodeMirror editor, the following keyboard shortcuts MUST be active:

- `Cmd+1` (macOS) / `Ctrl+1` (other) → activate **Data**.
- `Cmd+2` / `Ctrl+2` → activate **Structure**.
- `Cmd+3` / `Ctrl+3` → activate **Raw**.

Switching subtabs MUST NOT trigger a `postgres_query_table`, `postgres_count_table`, or any data-grid fetch. The first activation of Structure or Raw is the only place a `postgres_table_structure` call is dispatched (see the `postgres-table-structure` capability for the contract).

#### Scenario: Activating a table opens the data viewer

- **WHEN** the user activates the table node `analytics.events`
- **THEN** a center-area tab of kind `postgres-table-data` opens with payload `{ connectionId, connectionName, schema: "analytics", relation: "events", relationKind: "table" }`
- **AND** the placeholder tab is NOT opened
- **AND** the active subtab is **Data**

#### Scenario: Activating a view opens the data viewer

- **WHEN** the user activates a view or materialized view node
- **THEN** the same `postgres-table-data` tab opens with `relationKind: "view"` or `"materialized-view"` respectively
- **AND** the active subtab is **Data**

#### Scenario: Activating a function still opens the placeholder

- **WHEN** the user activates a function, type, extension, index, or trigger node
- **THEN** the existing `postgres-object-placeholder` tab opens (this change does not implement those viewers)

#### Scenario: Reactivation focuses the existing tab

- **WHEN** the user activates the same table node a second time
- **THEN** the existing `postgres-table-data` tab is focused and no new tab is opened
- **AND** the active subtab is whatever it was before the user navigated away

#### Scenario: Sub-tabset header is always visible

- **WHEN** the table tab is open on any subtab
- **THEN** the segmented Data / Structure / Raw control is rendered at the top of the viewer body
- **AND** the currently active subtab is visually selected in the control

#### Scenario: Switching subtabs does not refetch data

- **WHEN** the Data subtab has loaded rows and the user clicks **Structure**
- **THEN** no new `postgres_query_table` invocation is dispatched
- **AND** when the user clicks **Data** again, the previously buffered rows and scroll position are still in place

#### Scenario: Subtab choice survives tab switching

- **WHEN** the user is on the Structure subtab of `public.users` and clicks a different browser tab, then clicks back to `public.users`
- **THEN** the Structure subtab is still active

#### Scenario: Closing the tab resets the subtab

- **WHEN** the user is on the Structure subtab of `public.users`, closes the tab, and reopens `public.users` from the schema browser
- **THEN** the table tab opens on the **Data** subtab

#### Scenario: Cmd+1 / Cmd+2 / Cmd+3 activate subtabs

- **WHEN** the table tab is focused, the focus is not inside an editor, and the user presses `Cmd+2` (macOS) or `Ctrl+2` (other)
- **THEN** the Structure subtab becomes active
- **AND** pressing `Cmd+1` returns to Data, `Cmd+3` switches to Raw

#### Scenario: Subtab shortcuts do not fire from inside an editor

- **WHEN** the user has keyboard focus inside the filter-bar Raw editor or inside an inline cell editor and presses `Cmd+2`
- **THEN** the active subtab does NOT change
- **AND** the keystroke is handled by the focused editor (or ignored)

### Requirement: Read-only execution path

`postgres_query_table` and `postgres_count_table` MUST execute through the pool's read-only-aware execute helper (the same `executeQuery` path used by the schema browser) so that future read-only enforcement changes apply uniformly. They MUST NOT use any `executeMutation`-style helper. When the connection is writable AND the relation has a PK, the viewer SHALL expose mutation affordances (inline cell editing, "Add row", delete-on-`⌫`, `⌘S` to commit) routed through the `postgres-data-edit` capability commands. When the connection is `read_only: true`, mutation affordances MUST NOT be rendered AND the viewer MUST display a "Read-only connection — edits disabled" banner in the bottom bar.

Mutation affordances and the read-only banner are scoped to the **Data** subtab. The Structure and Raw subtabs are read-only on every connection and MUST NOT render an "edits disabled" banner of their own (the Structure / Raw surfaces never edit anything to begin with).

#### Scenario: Read-only flag does not block reads

- **WHEN** the user opens the viewer on a connection in `read_only: true`
- **THEN** rows load normally on the Data subtab and no error is surfaced
- **AND** no UI affordance for mutating the data is rendered (edit, add, delete affordances are hidden)
- **AND** the bottom bar shows the "Read-only connection — edits disabled" banner on the Data subtab only

#### Scenario: Writable connection exposes mutation affordances

- **WHEN** the user opens a table viewer on a connection with `params.read_only: false` for a relation that has a PK
- **THEN** double-clicking a non-PK cell on the Data subtab enters inline edit mode
- **AND** the bottom bar renders the "Add row" and "Save" controls

#### Scenario: Structure and Raw subtabs never render the edits-disabled banner

- **WHEN** the user is on the Structure or Raw subtab on a `read_only: true` connection
- **THEN** the "Read-only connection — edits disabled" banner is NOT shown on those subtabs
- **AND** no mutation affordances are rendered on those subtabs
