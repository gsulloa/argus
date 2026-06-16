//! Single source of truth for the application's name and brand identifiers.
//!
//! ⚠️ Renaming the app is NOT just changing `APP_DISPLAY_NAME`. That constant
//! controls only display-safe surfaces (window title, dialogs, UI chrome).
//! The `migration-sensitive` constants below are keyed-on by already-installed
//! instances; changing any of them orphans existing user state. A real rename
//! is a deliberate, documented procedure — see `RENAMING.md` at the repo root.
//!
//! This module made renaming *cheaper*, not *automatic*.

// ─── Display-safe ───────────────────────────────────────────────────────────
// Change freely; affects only what the user reads.

/// Human-facing application name shown in window titles, dialogs, and UI chrome.
pub const APP_DISPLAY_NAME: &str = "Argus";

// ─── Migration-sensitive ─────────────────────────────────────────────────────
// Changing any of these breaks already-installed instances. Each comment states
// exactly what breaks. Do NOT change these casually — see `RENAMING.md`.

/// Tauri bundle identifier. Determines the on-disk app data/config/log dirs,
/// the updater signature identity, and macOS code-signing.
/// MUST stay in sync with `bundle.identifier` in `tauri.conf.json` (that file
/// is static JSON and cannot reference this constant).
/// Changing it: existing installs' app data dir, stored DB, and logs are orphaned.
pub const BUNDLE_IDENTIFIER: &str = "com.argus.app";

/// OS keychain service name under which all secrets are stored.
/// Changing it: every stored connection password and AI API key becomes
/// unreachable (the user must re-enter all credentials).
pub const KEYCHAIN_SERVICE: &str = "argus";

/// SQLite database filename inside the app data dir.
/// Changing it: the existing database is not found and looks like total data loss
/// (connections, saved queries, history, settings) until manually migrated.
pub const DB_FILENAME: &str = "argus.db";

/// Log file stem inside the app log dir. The daily appender writes
/// `<LOG_FILE_STEM>.YYYY-MM-DD`; the updater also looks up the plain file.
/// Changing it: previously written logs are no longer discovered.
pub const LOG_FILE_STEM: &str = "argus.log";

/// Cargo binary name (see `[package] name` / `[lib] name` in `Cargo.toml`).
/// The MCP sidecar is spawned as `<CARGO_BIN_NAME> __mcp-doc-writer ...`, so the
/// produced binary name and the sidecar command are a coupled pair.
/// Changing it: the Claude CLI cannot launch the MCP doc-writer sidecar.
pub const CARGO_BIN_NAME: &str = "argus";

/// Subcommand the Claude CLI invokes on the binary to run the MCP doc-writer.
/// Internal protocol token, not user-facing; documented here for completeness.
pub const MCP_SIDECAR_SUBCOMMAND: &str = "__mcp-doc-writer";

/// Prefix for power-user environment-variable overrides (e.g. `ARGUS_CLAUDE_BIN`,
/// `ARGUS_CODEX_BIN`). Documented in README.
/// Changing it: users' existing env-var overrides stop being read.
pub const ENV_VAR_PREFIX: &str = "ARGUS";
