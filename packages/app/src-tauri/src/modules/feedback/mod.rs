//! In-app feedback submission.
//!
//! Exposes a single `submit_feedback` Tauri command that collects safe diagnostic
//! metadata, POSTs a feedback record to the configured endpoint (phase 1), and
//! uploads any user-chosen attachments via presigned PUT URLs (phase 2).
//!
//! Build-time env vars:
//!   ARGUS_FEEDBACK_ENDPOINT  — HTTPS URL of the feedback API (default: https://feedback.argusdb.app/feedback)
//!   ARGUS_FEEDBACK_APP_KEY   — Static app-key header value (NO safe default; command
//!                              returns a config error if absent at build time).

pub mod command;

pub use command::submit_feedback;
