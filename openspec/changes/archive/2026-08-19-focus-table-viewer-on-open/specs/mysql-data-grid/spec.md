## ADDED Requirements

### Requirement: MySQL table viewer tab acquires keyboard focus on activation

When a MySQL table viewer tab becomes the active tab — either because it just mounted as the active tab (opened from the schema tree, the table quick switcher, or any other entry point) or because the user switched to it from another tab — the viewer SHALL move keyboard focus into itself, so that its root-scoped shortcuts (`⌘R` reload, `⌘Z` undo, `⌘S` save) and every data-grid key binding (`⌘C` copy, `⌘V` row paste, `⌘A` select-all, `Backspace`/`Delete`, `Escape`) are live from the first keystroke, with no priming click. This matters more for MySQL than for a window-level listener because these shortcuts are bound to a React `onKeyDown` on the tab root, which receives nothing while focus sits on `document.body`.

The focus target SHALL be resolved in this order:

1. The data grid root — the `tabIndex={0}` element that owns the grid's `onKeyDown` handling — when the Data subtab is active and the grid is mounted and focusable. Because it is a descendant of the tab root, focusing it also makes the tab root's React `onKeyDown` receive bubbled key events.
2. Otherwise the tab root element (which carries `tabIndex={-1}`).

The auto-focus MUST NOT steal focus. It SHALL be a no-op when focus already sits inside this tab's root, when the currently focused element is a text-entry surface anywhere in the document (`<input>`, `<textarea>`, `<select>`, contentEditable, or a node inside a CodeMirror `.cm-editor` surface), or while the command palette / table quick-switcher overlay owns focus.

The focus move MUST happen after the tab's content has been committed to the DOM and MUST fire at most once per activation — never on re-render, data refresh, or subtab change while the tab stays active. Deactivating a tab SHALL NOT move focus anywhere.

Focusing the grid SHALL be **non-destructive**: it MUST NOT set an active cell or select a row range. The grid root MUST NOT show a user-agent focus outline.

#### Scenario: Opening a MySQL table focuses the grid

- **WHEN** the user activates a table node and a MySQL table viewer tab opens as the active tab
- **THEN** keyboard focus lands on the data grid root without any further click
- **AND** pressing `⌘R` immediately reloads the table query

#### Scenario: Grid key bindings work without a priming click

- **WHEN** a MySQL table tab has just been opened, rows are loaded, and the user clicks a single cell then presses `⌘A`
- **THEN** every loaded row is selected and a subsequent `⌘C` copies the selection

#### Scenario: Focus does not change selection

- **WHEN** a MySQL table tab becomes active and focus lands on the grid root
- **THEN** no active cell is set and no row range is selected
- **AND** no user-agent focus outline is drawn around the grid container

#### Scenario: Falls back to the tab root while the grid is not available

- **WHEN** a MySQL table tab becomes active while its first query is still in flight or it is showing an error state
- **THEN** keyboard focus lands on the tab root element, so the root `onKeyDown` shortcuts still receive events

#### Scenario: Does not steal focus from a text input

- **WHEN** the user is typing in any input, textarea, select, or CodeMirror surface and a MySQL table viewer tab activation would otherwise fire
- **THEN** focus stays where the user is typing and the caret position is unchanged

#### Scenario: Focus is not re-taken on re-render or refresh

- **WHEN** an active MySQL table tab reloads its rows while the user has focus in the inspector or the filter bar
- **THEN** focus is not moved back to the grid root
