# updater-logs Specification

## Purpose
TBD - created by archiving change fix-updater-and-add-logs-viewer. Update Purpose after archive.
## Requirements
### Requirement: In-app logs viewer is reachable from the version dropdown

The frontend SHALL render a **"View update logs…"** menu item in the version-indicator dropdown in the status bar. This item MUST always be visible (not gated on whether a pending update exists) so the user can inspect updater behavior in any state — including when no update has been detected and the user wants to know why. Selecting the item MUST open a modal dialog (`UpdaterLogsDialog`) that displays recent updater log entries.

#### Scenario: Menu item is visible with no pending update

- **WHEN** the user opens the version dropdown and no update is detected or pending
- **THEN** the "View update logs…" item is rendered in the dropdown above the "About Argus" item

#### Scenario: Menu item is visible with a pending update

- **WHEN** the user opens the version dropdown and an update is downloaded and pending
- **THEN** the "View update logs…" item is rendered in the dropdown alongside the other update-related items

#### Scenario: Selecting the item opens the modal

- **WHEN** the user clicks "View update logs…"
- **THEN** the version dropdown closes, the `UpdaterLogsDialog` modal opens, and the modal immediately calls `updater_logs_tail` and renders the result

### Requirement: Logs viewer shows the last 200 updater log lines

The logs viewer MUST display the last 200 lines from the active daily log file (`argus.log` under the platform's app log directory) that are tagged with `target=updater`. Filtering MUST happen in Rust (in the `updater_logs_tail` command) so the renderer receives only relevant lines. The lines MUST be rendered in a monospaced container with the most recent line at the bottom and the oldest at the top. The dialog MUST provide a **Refresh** button that re-invokes `updater_logs_tail` to fetch a fresh snapshot.

#### Scenario: Tail returns most recent 200 updater lines

- **WHEN** `argus.log` contains 1000 lines total of which 350 are tagged `target=updater`
- **THEN** `updater_logs_tail({ max_lines: 200 })` returns the most recent 200 updater-tagged lines, ordered oldest-to-newest

#### Scenario: Empty log file shows placeholder

- **WHEN** `argus.log` does not exist or contains zero updater-tagged lines
- **THEN** the modal renders a placeholder line "(no updater events recorded yet)" instead of an empty pane

#### Scenario: Refresh button re-tails the log

- **WHEN** the user has the modal open and clicks "Refresh"
- **THEN** `updater_logs_tail` is invoked again and the rendered text is replaced with the new snapshot

### Requirement: Logs viewer reveals the log folder in the OS file manager

The logs viewer modal MUST provide a **Reveal in Finder** (macOS) / **Open log folder** (Linux/Windows) button that opens the platform app log directory in the OS file manager via a Rust command `updater_logs_reveal`. The command MUST use the platform-appropriate native tool (`open` on macOS, `xdg-open` on Linux, `explorer` on Windows) and MUST log the invocation as a `tracing` event with `target=updater`. If the launch fails, the Rust command MUST return the absolute log directory path so the renderer can display it for manual navigation.

#### Scenario: Reveal opens the log folder on macOS

- **WHEN** the user clicks "Reveal in Finder" on macOS
- **THEN** the Rust command spawns `open <log_dir>` and the Finder window opens at `~/Library/Logs/Argus/`

#### Scenario: Reveal failure surfaces the log path

- **WHEN** the OS reveal tool is unavailable or fails to launch
- **THEN** the Rust command returns `Err` with the absolute log directory path, and the renderer displays a fallback line "Log folder: <path>" so the user can copy and navigate manually

### Requirement: Logs viewer can copy log text to clipboard

The logs viewer modal MUST provide a **Copy** button that copies the currently-rendered log text to the system clipboard. The button MUST give visual feedback on success (e.g., label briefly changes to "Copied"). This enables the user to paste the logs into a bug report or support email without leaving the app.

#### Scenario: Copy puts log text on the clipboard

- **WHEN** the user clicks "Copy" with 50 lines rendered in the viewer
- **THEN** the system clipboard contains those 50 lines joined with newlines, and the button label briefly displays "Copied"

### Requirement: Renderer-originated events are logged via a Rust command

The frontend SHALL invoke a Tauri command `log_updater_event(level, msg, fields?)` to record updater-related events that originate in the renderer (e.g., user clicked Skip, user opened the logs viewer, user dismissed an error toast). The command MUST emit a `tracing` event with `target = "updater"` at the requested level (`info`, `warn`, or `error`) and the supplied message and fields. This ensures renderer-side state transitions are durably recorded in the same log file as Rust-side events.

#### Scenario: Renderer event reaches the log file

- **WHEN** the renderer calls `log_updater_event({ level: "info", msg: "user_opened_logs_viewer" })`
- **THEN** `argus.log` contains a new line at `info` level tagged `target=updater` with that message

#### Scenario: Invalid level falls back to info

- **WHEN** the renderer calls `log_updater_event` with an unrecognized level string
- **THEN** the command emits the event at `info` level (no error returned), so renderer typos do not lose events
