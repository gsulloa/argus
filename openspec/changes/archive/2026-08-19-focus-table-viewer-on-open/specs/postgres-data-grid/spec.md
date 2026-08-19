## ADDED Requirements

### Requirement: Table viewer tab acquires keyboard focus on activation

When a `postgres-table-data` tab becomes the active tab — either because it just mounted as the active tab (opened from the schema tree, the ⌘P / ⌥⌘P table quick switcher, a saved/context query, or any other entry point) or because the user switched to it from another tab — the viewer SHALL move keyboard focus into itself, so that every viewer-scoped shortcut (`⌘F` filter bar, `⌘R` reload, `⌘Z` undo, `⌘1`/`⌘2`/`⌘3`/`⌘4` subtabs, `⌘S` save) and every data-grid key binding (`⌘C` copy, `⌘V` row paste, `⌘A` select-all, `Backspace`/`Delete` bulk-delete toggle, `Escape` clear) is live from the first keystroke, with no priming click.

The focus target SHALL be resolved in this order:

1. The data grid root — the `tabIndex={0}` element that owns the grid's `onKeyDown` handling — when the Data subtab is active and the grid is mounted and focusable. Because the grid root is a descendant of the tab root, focusing it also satisfies the tab-level listener's `root.contains(document.activeElement)` guard, so both layers of shortcut become live at once.
2. Otherwise the tab root element (which carries `tabIndex={-1}`), so the tab-root shortcuts still receive events during the first load, an error state, an empty relation, or while the Structure / Raw / Docs subtab is active.

The fallback MUST be selected by verifying that focus actually landed inside the tab root, NOT by testing whether a grid reference exists. The viewer keeps the grid mounted under `display: none` while a non-Data subtab is showing, and focusing an element that is not rendered is a silent no-op — so a reference-existence test would leave focus outside the tab in exactly the case the fallback exists to serve.

The auto-focus MUST NOT steal focus. It SHALL be a no-op when any of the following holds at the moment it would run:

- Focus already sits inside this tab's root (the user has already clicked or focus was restored there).
- The currently focused element is a text-entry surface anywhere in the document: an `<input>`, `<textarea>`, `<select>`, a contentEditable element, or a node inside a CodeMirror surface (`.cm-editor`).
- The command palette or the table quick-switcher overlay is open and owns focus (their focus trap must not be broken mid-flight).

The focus move MUST happen after the tab's content has been committed to the DOM (e.g. on a `requestAnimationFrame` / post-paint tick) so the grid root exists when it is targeted, and MUST fire at most once per activation — it MUST NOT re-focus the grid on every re-render, on data refresh, on subtab change, or while the tab stays active.

Focusing the grid SHALL be **non-destructive**: it MUST NOT set an active cell, select a row range, or otherwise change selection state. It only moves DOM focus.

Deactivating a tab SHALL NOT move focus anywhere; only activation focuses.

Because focusing the grid root reproduces the focus state a click already produces, the grid root MUST NOT show a user-agent focus outline: activating a tab via a keyboard path (⌘P) would otherwise draw a `:focus-visible` ring around the whole grid container while a mouse path would not.

#### Scenario: Opening a table from the schema tree focuses the grid

- **WHEN** the user activates the table node `public.users` in the schema tree and a `postgres-table-data` tab opens as the active tab
- **THEN** keyboard focus lands on the data grid root without any further click
- **AND** pressing `⌘F` immediately shows the filter bar and focuses its first row's value input
- **AND** no browser/webview "find in page" UI appears

#### Scenario: Opening a table from the quick switcher focuses the grid

- **WHEN** the user opens the table quick switcher with `⌘P`, selects `public.orders`, and presses Enter
- **THEN** the quick switcher closes and the `postgres-table-data` tab becomes active
- **AND** keyboard focus lands on the data grid root
- **AND** pressing `⌘R` immediately reloads the table query

#### Scenario: Grid key bindings work without a priming click

- **WHEN** a table tab has just been opened, rows are loaded, and the user clicks a single cell then presses `⌘A`
- **THEN** every loaded row is selected and a subsequent `⌘C` copies the selection
- **AND** `Escape` clears the selection

#### Scenario: Focus does not change selection

- **WHEN** a table tab becomes active and focus lands on the grid root
- **THEN** no active cell is set and no row range is selected
- **AND** a `Backspace` or `Delete` keystroke does not mark any row for deletion

#### Scenario: No focus ring is drawn around the grid container

- **WHEN** the user opens a table via the ⌘P quick switcher (a keyboard-modality path) and focus lands on the grid root
- **THEN** no user-agent focus outline is rendered around the grid container
- **AND** the appearance matches opening the same table by clicking the schema tree

#### Scenario: Switching back to an already-open table tab re-focuses it

- **WHEN** the user is in the SQL editor tab and clicks back to an already-open `postgres-table-data` tab
- **THEN** keyboard focus lands in the table viewer (grid root, or the tab root when the grid is not mounted)
- **AND** `⌘F` works without a click

#### Scenario: Falls back to the tab root while the grid is not available

- **WHEN** a table tab becomes active while its first `postgres_query_table` is still in flight (the grid is not yet rendered)
- **THEN** keyboard focus lands on the tab root element
- **AND** `⌘1` / `⌘2` / `⌘3` still switch subtabs

#### Scenario: Falls back to the tab root when the grid is mounted but hidden

- **WHEN** the user switches back to a table tab that is sitting on the Structure, Raw, or Docs subtab, where the grid is still mounted but `display: none`
- **THEN** focusing the grid is a no-op, so keyboard focus lands on the tab root element instead
- **AND** `⌘1` returns to the Data subtab without a priming click

#### Scenario: Does not steal focus from a text input

- **WHEN** the user is typing in the connection search box, an inspector field, or the filter bar's value input, and a `postgres-table-data` tab becomes active in the background or the same tab re-renders
- **THEN** focus stays in that input and the caret position is unchanged
- **AND** the keystrokes are not swallowed by the grid

#### Scenario: Does not steal focus from a CodeMirror surface

- **WHEN** focus is inside a CodeMirror editor (SQL editor, filter-bar Raw editor) and a table viewer tab activation would otherwise fire
- **THEN** focus stays inside the CodeMirror surface

#### Scenario: Does not break the palette focus trap

- **WHEN** the command palette or the table quick switcher is open with focus inside its search input
- **THEN** the table viewer does not pull focus out of the overlay while it is open

#### Scenario: Focus is not re-taken on re-render or refresh

- **WHEN** an active table tab reloads its rows (`⌘R`, paging, sort or filter change) while the user has focus in the inspector or the filter bar
- **THEN** focus is not moved back to the grid root

#### Scenario: Only the newly activated tab focuses

- **WHEN** two `postgres-table-data` tabs are open and the user switches from Tab A to Tab B
- **THEN** only Tab B moves focus, and Tab A does not fight for it
