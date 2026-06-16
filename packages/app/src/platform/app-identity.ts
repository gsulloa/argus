/**
 * Single source of truth for the application's display name on the frontend.
 *
 * ⚠️ This controls only display-safe UI chrome (sidebar brand, status bar,
 * window/about labels). It does NOT rename an existing install. Frontend
 * persisted state keyed on the name is migration-sensitive — see below and
 * `RENAMING.md` at the repo root.
 *
 * This module made renaming *cheaper*, not *automatic*.
 */

// ─── Display-safe ────────────────────────────────────────────────────────────
/** Human-facing application name shown in UI chrome. */
export const APP_DISPLAY_NAME = "Argus";

// ─── Migration-sensitive (documented; not re-exported for casual edits) ──────
// Changing these orphans existing user state in the browser/OS:
//
//   • Tauri bundle identifier  "com.argus.app"  (also in tauri.conf.json + Rust
//     config::app_identity::BUNDLE_IDENTIFIER) — drives the on-disk data dir.
//   • localStorage key prefix  "argus."  (e.g. "argus.ai.panelOpen",
//     "argus.ai.panelWidth", "argus.ai.autoApply", "argus.recentTables.v1")
//     — renaming the prefix loses users' saved panel sizes / recent tables.
//   • Command IDs / event names / log tags ("argus.*", "argus:*", "[argus]")
//     are an internal namespace, not display copy — safe but pointless to churn.
//
// The brand identifier shown in the About/version UI is mirrored here so the
// VersionIndicator does not hardcode its own copy:
/** Tauri bundle identifier (mirrors tauri.conf.json + Rust BUNDLE_IDENTIFIER). */
export const BUNDLE_IDENTIFIER = "com.argus.app";
