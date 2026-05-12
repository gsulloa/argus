# Changelog

All notable changes to Argus are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions map to the `version` field in `package.json` and `tauri.conf.json`.

---

## [Unreleased]

### Added

- **Saved Queries panel** in the sidebar (between Connections and Plataforma): organize queries in hierarchical folders with drag-and-drop reordering, search/filter, inline rename, duplicate, move, and delete.
- **Cmd+S / Ctrl+S** saves the current query by name. First save prompts for a name and folder; subsequent saves overwrite silently.
- **Connection selector** in the SQL editor toolbar — switch the active connection inline without reopening the tab. The last-used connection is remembered per saved query and restored on next open.
- **Unsaved-changes indicator** (`●`) on saved-query tabs. Closing a dirty saved-query tab now asks for confirmation instead of silently discarding changes.
- Query tabs opened from the sidebar reuse an already-open tab for the same saved query (focus instead of duplicate).

### Changed

- Tab IDs for SQL editor tabs are now `pgquery:<uuid>` (no embedded connection ID). Existing in-session tab buffers stored under the old format (`pgquery:<connId>:<uuid>`) are silently discarded on first launch after upgrade — SQL is preserved in the editor until the tab is closed.

---

## [0.1.4] — 2025-05-07

### Added

- macOS: disambiguate Developer ID cert via `APPLE_SIGNING_IDENTITY` so builds succeed when multiple certificates are in the keychain.

---

## [0.1.3] — 2025-04-28

### Added

- Beta release pipeline: CI build on merge to `master`, R2 hosting, silent auto-updater.

---

## [0.1.2] — 2025-04-22

### Added

- SQL editor: format button, live query timer, CSV/JSON export, and fix for swallowed keyboard shortcuts.
- Structured filter: type-aware Postgres parameter binding for `WHERE` clause filters.

---

*Older versions pre-date this changelog.*
