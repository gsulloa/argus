## Why

Argus does not exist yet. Before any database functionality can be built, the project needs a desktop application shell that establishes the technology stack, the layout patterns, and the cross-cutting infrastructure (settings, secrets, persistence) that every future capability will depend on. This change creates that foundation as a runnable, empty skeleton — no Postgres logic, no real connections, just the chrome.

Building the shell first lets every later change focus on a single vertical (connection form, schema browser, data grid, SQL editor, etc.) without re-litigating the platform.

## What Changes

- Initialize a Tauri 2 desktop project with a React + Vite + TypeScript frontend and a Rust backend.
- Create the main window with a TablePlus-style four-region layout: left sidebar, center work area with tabs, right inspector panel (collapsible), bottom status bar.
- Add a command palette (⌘K) with empty command registry — the chrome only, no commands registered yet.
- Add an empty connections list in the sidebar with a "+" button that opens a placeholder dialog (no real form yet).
- Set up local persistence: SQLite database in the OS-appropriate App Support directory for non-secret metadata, and OS keychain integration (via the `keyring` crate) for secrets.
- Add light and dark themes with system-default detection, plus base keyboard shortcuts (⌘K palette, ⌘W close tab, ⌘⇧P palette alias, ⌘, settings).
- Provide working development and build scripts (`pnpm tauri dev`, `pnpm tauri build`).

## Capabilities

### New Capabilities

- `app-shell`: The desktop window, four-region layout, central tab system, theming, and base keyboard shortcut bindings.
- `command-palette`: The ⌘K command palette UI and command-registry contract that other capabilities will register against.
- `connection-registry`: Persistent storage of connection metadata (SQLite) and connection secrets (OS keychain), exposed to the frontend via Tauri commands. No connection-type-specific fields yet — only a generic `Connection { id, name, kind, params_json, created_at }` envelope.

### Modified Capabilities

<!-- None — this is the first change. -->

## Impact

- **New code**: Entire repository structure (`src-tauri/` for Rust, `src/` for React, configuration files, build scripts).
- **New dependencies**:
  - Rust: `tauri`, `tokio`, `rusqlite` (or `sqlx` with sqlite feature), `keyring`, `serde`, `serde_json`, `thiserror`, `tracing`.
  - JS: `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `typescript`, `@tauri-apps/api`, `@tauri-apps/cli`, a CSS-in-JS or CSS module solution to be picked in design, and a minimal icon set.
- **New files on user system**: SQLite DB and keychain entries created on first launch in standard OS-specific locations.
- **No breaking changes**: greenfield project.
- **Out of scope** (deferred to later changes): Postgres connection logic, schema browsing, data viewing/editing, SQL editor, query history, SSH tunneling, read-only toggle wiring (the toggle lives in `add-postgres-connection`).
