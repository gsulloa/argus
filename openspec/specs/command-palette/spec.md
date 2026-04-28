# command-palette Specification

## Purpose
TBD - created by archiving change bootstrap-tauri-shell. Update Purpose after archive.
## Requirements
### Requirement: Palette open and dismiss

The command palette SHALL open as a modal overlay centered over the window when invoked, and dismiss when the user presses Escape, clicks outside, or activates a command. While open, the palette MUST trap focus and return focus to the previously focused element on dismiss.

#### Scenario: Opening the palette

- **WHEN** the user presses ⌘K
- **THEN** the palette appears with a focused search input

#### Scenario: Dismissing with Escape

- **WHEN** the palette is open and the user presses Escape
- **THEN** the palette closes and focus returns to the element that was focused before opening

#### Scenario: Dismissing by clicking outside

- **WHEN** the palette is open and the user clicks on the backdrop area
- **THEN** the palette closes

### Requirement: Command registry

The platform SHALL expose a command registry through which any module can register and unregister commands. A command MUST have an `id` (unique, stable string), a `label` (human-readable), an optional `group` (label used to cluster related commands), an optional `keywords` list (additional search terms), an optional `hotkey` descriptor, and a `run` handler invoked when the command is activated. Registering a command with an existing `id` MUST replace the previous registration for that id.

#### Scenario: Registering and listing a command

- **WHEN** a module registers a command `{ id: "demo.hello", label: "Hello world", run: handler }`
- **AND** the user opens the palette
- **THEN** the command "Hello world" appears in the palette list

#### Scenario: Unregistering a command

- **WHEN** a module unregisters the command id `demo.hello`
- **AND** the user opens the palette
- **THEN** the command "Hello world" no longer appears

#### Scenario: Registering with a duplicate id replaces the prior command

- **WHEN** a command with id `demo.hello` is already registered
- **AND** another `register({ id: "demo.hello", label: "Hi again", run: handler2 })` call occurs
- **THEN** the palette shows only "Hi again" with the new handler

### Requirement: Fuzzy search

When the user types in the palette search input, the visible commands SHALL be filtered by case-insensitive fuzzy match against the command label, group name, and keywords. Results MUST be ordered by match quality (better matches first).

#### Scenario: Filtering by label

- **WHEN** the palette is open with commands "Open Connection", "Edit Connection", "Run Query"
- **AND** the user types `open`
- **THEN** "Open Connection" is visible at the top of the list

#### Scenario: Matching by keyword

- **WHEN** a command "Open Connection" has keyword `new` and the user types `new`
- **THEN** "Open Connection" appears in the filtered results

### Requirement: Command activation

Activating a command (Enter key on a highlighted result, click, or matching hotkey when the palette is closed) SHALL invoke its `run` handler. After activation by Enter or click, the palette MUST close before the handler runs unless the command opts in to staying open.

#### Scenario: Activating with Enter

- **WHEN** a command is highlighted in the palette and the user presses Enter
- **THEN** the palette closes and the command's `run` handler is invoked exactly once

#### Scenario: Activating with a registered hotkey

- **WHEN** a command is registered with hotkey ⌘E and the palette is closed
- **AND** the user presses ⌘E
- **THEN** the command's `run` handler is invoked without opening the palette

### Requirement: Empty state

When no commands are registered, the palette SHALL show an empty-state message indicating that the application is in a bootstrap state and pointing the user to the documentation or a placeholder hint.

#### Scenario: Empty palette on first launch

- **WHEN** the user launches Argus with no modules registering commands
- **AND** the user opens the palette with ⌘K
- **THEN** the palette displays a friendly "No commands available yet" empty state

#### Scenario: Empty results from a search

- **WHEN** at least one command is registered but none match the user's query
- **THEN** the palette shows a "No matching commands" message distinct from the bootstrap empty state

