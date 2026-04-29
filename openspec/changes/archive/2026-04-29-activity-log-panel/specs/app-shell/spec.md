## ADDED Requirements

### Requirement: Bottom panel slot

The shell SHALL provide a bottom panel slot positioned between the center work area and the status bar. The slot MUST be optional — when no bottom panel is registered or active, the shell layout MUST collapse the slot to zero height with no DOM presence and the center work area MUST occupy the freed space. When a bottom panel is active, the slot MUST honor a height controlled by the panel's owner (within slot-imposed bounds 120px–480px) and MUST expose a 4px horizontal drag handle along its top edge that follows the same `useDragHandle` pattern as the sidebar/inspector handles. The slot MUST span the full width of the shell (`grid-column: 1 / -1`).

#### Scenario: No active bottom panel collapses the slot

- **WHEN** no capability has registered or activated a bottom panel
- **THEN** the layout grid renders without a row for the slot and the center area extends down to the status-bar boundary

#### Scenario: Active bottom panel reserves a row

- **WHEN** the activity-log panel is active and open at 240px
- **THEN** the layout grid has a 240px row above the status bar and a 4px drag handle row immediately above it

#### Scenario: Drag handle resizes the slot

- **WHEN** the user drags the bottom-panel handle up by 60px
- **THEN** the slot height grows by 60px (subject to the 120–480 clamp)

## MODIFIED Requirements

### Requirement: Four-region layout

The shell SHALL present four primary regions: a left sidebar, a center work area containing tabs, a right inspector panel, and a bottom status bar. The right inspector panel MUST be collapsible. The left sidebar MUST be resizable horizontally with the resize handle persisted across launches. In addition, the shell SHALL accommodate an optional bottom panel slot between the center work area and the status bar (see "Bottom panel slot"); when a panel is active in that slot, the visual region count effectively becomes five, but the four primary regions MUST continue to behave as specified.

#### Scenario: Default layout on first launch

- **WHEN** the user launches Argus with no prior preferences
- **THEN** the window shows a left sidebar (~240px), a center area, a collapsed-by-default right inspector, no active bottom panel, and a bottom status bar

#### Scenario: Toggling the right inspector

- **WHEN** the user presses ⌘\ (Cmd+Backslash) on macOS or Ctrl+\ elsewhere, or clicks the inspector toggle in the status bar
- **THEN** the right inspector panel toggles between collapsed and expanded states

#### Scenario: Sidebar width persists across launches

- **WHEN** the user drags the sidebar resize handle to a new width and quits
- **AND** the user relaunches Argus
- **THEN** the sidebar opens at the previously chosen width

#### Scenario: Bottom panel does not interfere with inspector toggling

- **WHEN** the activity-log bottom panel is open and the user toggles the inspector
- **THEN** the inspector opens or closes normally and the bottom panel keeps its current height
