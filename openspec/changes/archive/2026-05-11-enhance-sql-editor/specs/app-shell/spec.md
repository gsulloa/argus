## MODIFIED Requirements

### Requirement: Base keyboard shortcuts

The shell SHALL register the following base shortcuts at startup, available globally inside the application window: ⌘K (Cmd+K) opens the command palette, ⌘⇧P is a synonym for ⌘K, ⌘P opens the table quick-switcher, ⌘W closes the active tab, ⌘\ toggles the right inspector, ⌘, opens settings (no settings UI yet — opens an empty placeholder tab).

These shortcuts MUST fire regardless of the focused element. In particular, they MUST work when focus is inside a CodeMirror SQL editor surface (whose `.cm-content` element is `contenteditable`), inside a native `<input>`, `<textarea>`, or `<select>`, or inside any other contenteditable region. The handler MUST call `event.preventDefault()` on match so the keystroke does not also reach the underlying editor or input as a textual command.

#### Scenario: Opening the palette with ⌘K

- **WHEN** the user presses ⌘K (or Ctrl+K on non-macOS)
- **THEN** the command palette opens centered over the window

#### Scenario: Settings shortcut

- **WHEN** the user presses ⌘, (or Ctrl+, on non-macOS)
- **THEN** a tab of kind `settings-placeholder` opens (or focuses if already open)

#### Scenario: Shortcuts fire from inside the SQL editor

- **WHEN** the user has focus inside a `postgres-query` tab's CodeMirror editor (`.cm-content` is the active element)
- **AND** the user presses ⌘K
- **THEN** the command palette opens
- **AND** the editor document is unchanged (no character inserted, no edit transaction dispatched)

#### Scenario: ⌘P opens the table quick-switcher from the SQL editor

- **WHEN** the user has focus inside the SQL editor
- **AND** the user presses ⌘P
- **THEN** the table quick-switcher opens

#### Scenario: Tab close shortcut fires from a focused input

- **WHEN** the user has focus inside any `<input>` or `<textarea>` (e.g. the connection name field, a filter bar, the palette search)
- **AND** the user presses ⌘W
- **THEN** the active tab is closed
- **AND** no character is inserted into the input
