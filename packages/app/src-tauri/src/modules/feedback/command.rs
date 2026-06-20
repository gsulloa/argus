//! `submit_feedback` Tauri command — two-phase feedback submission.
//!
//! Phase 1: POST JSON manifest to the feedback endpoint.
//! Phase 2: PUT each attachment's bytes to the presigned URL returned in phase 1.

use std::path::Path;
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tracing::{info, warn};

use crate::error::{AppError, AppResult};

// ---------------------------------------------------------------------------
// Build-time constants
// ---------------------------------------------------------------------------

/// HTTPS endpoint for the feedback API (phase 1 POST).
const ENDPOINT: &str = match option_env!("ARGUS_FEEDBACK_ENDPOINT") {
    Some(v) => v,
    None => "https://feedback.argusdb.app/feedback",
};

/// Static app-key injected at build time. `None` when the env var is absent.
const APP_KEY: Option<&str> = option_env!("ARGUS_FEEDBACK_APP_KEY");

// ---------------------------------------------------------------------------
// Validation limits
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LEN: usize = 5_000;
const MAX_ATTACHMENTS: usize = 3;
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024; // 5 MB

// ---------------------------------------------------------------------------
// HTTP timeout
// ---------------------------------------------------------------------------

const SUBMIT_TIMEOUT: Duration = Duration::from_secs(30);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentManifestItem {
    filename: String,
    content_type: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedbackMetadata {
    app_version: String,
    os: String,
    os_version: String,
    arch: String,
    locale: String,
    #[serde(rename = "activeEngineType", skip_serializing_if = "Option::is_none")]
    engine: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedbackRequest {
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    metadata: FeedbackMetadata,
    attachments: Vec<AttachmentManifestItem>,
}

/// Presigned upload entry returned by phase 1.
#[derive(Deserialize)]
struct UploadEntry {
    filename: String,
    url: String,
    #[allow(dead_code)]
    key: String,
}

/// Phase 1 response body.
#[derive(Deserialize)]
struct FeedbackResponse {
    id: String,
    uploads: Vec<UploadEntry>,
}

/// Success value returned to the frontend.
#[derive(Serialize)]
pub struct FeedbackResult {
    pub id: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Return a best-effort MIME type for common image extensions.
/// Falls back to `application/octet-stream` for unknown extensions.
fn guess_content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// Read the locale best-effort: `LANG` / `LC_ALL` env vars, then empty string.
fn detect_locale() -> String {
    std::env::var("LANG")
        .or_else(|_| std::env::var("LC_ALL"))
        .unwrap_or_default()
}

/// Best-effort OS version string — not critical, empty on failure.
fn detect_os_version() -> String {
    // On macOS `sw_vers -productVersion` is reliable but spawning a process is
    // heavy for a one-shot metadata field. Read /System/Library/CoreServices/SystemVersion.plist
    // or fall back gracefully. We use a light inline approach.
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
        {
            if output.status.success() {
                let v = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !v.is_empty() {
                    return v;
                }
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        // `winver` is more involved; return empty for now.
    }
    String::new()
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/// Submit in-app feedback to the configured endpoint.
///
/// Frontend invokes via:
///   `invoke('submit_feedback', { message, category, email, engine, attachmentPaths })`
///
/// Returns `{ id: string }` on success, or a serialised `AppError` on failure.
#[tauri::command]
pub async fn submit_feedback(
    app: AppHandle,
    message: String,
    category: Option<String>,
    email: Option<String>,
    engine: Option<String>,
    attachment_paths: Vec<String>,
) -> AppResult<FeedbackResult> {
    // ── Guard: app-key must be present at build time ──────────────────────
    let app_key = APP_KEY.ok_or_else(|| {
        AppError::Internal(
            "Feedback is not configured: ARGUS_FEEDBACK_APP_KEY was not set at build time".into(),
        )
    })?;

    // ── Local validation ──────────────────────────────────────────────────
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err(AppError::Validation("Message must not be empty".into()));
    }
    if message.len() > MAX_MESSAGE_LEN {
        return Err(AppError::Validation(format!(
            "Message must be at most {MAX_MESSAGE_LEN} characters"
        )));
    }
    if attachment_paths.len() > MAX_ATTACHMENTS {
        return Err(AppError::Validation(format!(
            "At most {MAX_ATTACHMENTS} attachments are allowed"
        )));
    }

    // Validate category value if provided.
    if let Some(ref cat) = category {
        if !matches!(cat.as_str(), "bug" | "idea" | "other") {
            return Err(AppError::Validation(format!(
                "Invalid category '{cat}'; must be one of: bug, idea, other"
            )));
        }
    }

    // ── Collect attachment metadata (no bytes yet) ────────────────────────
    let mut manifest: Vec<AttachmentManifestItem> = Vec::with_capacity(attachment_paths.len());
    for raw_path in &attachment_paths {
        let path = Path::new(raw_path);
        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| {
                AppError::Validation(format!("Attachment path has no filename: {raw_path}"))
            })?
            .to_string();
        let meta = std::fs::metadata(path).map_err(|e| {
            AppError::Validation(format!("Cannot read attachment '{filename}': {e}"))
        })?;
        let size = meta.len();
        if size > MAX_FILE_BYTES {
            return Err(AppError::Validation(format!(
                "Attachment '{filename}' is {size} bytes; maximum is {MAX_FILE_BYTES} bytes (5 MB)"
            )));
        }
        let content_type = guess_content_type(path).to_string();
        manifest.push(AttachmentManifestItem {
            filename,
            content_type,
            size,
        });
    }

    // ── Collect safe metadata ─────────────────────────────────────────────
    let app_version = app.package_info().version.to_string();
    let os = std::env::consts::OS.to_string();
    let os_version = detect_os_version();
    let arch = std::env::consts::ARCH.to_string();
    let locale = detect_locale();

    let metadata = FeedbackMetadata {
        app_version,
        os,
        os_version,
        arch,
        locale,
        engine,
    };

    let payload = FeedbackRequest {
        message,
        category,
        email,
        metadata,
        attachments: manifest,
    };

    // ── Phase 1: POST feedback record ─────────────────────────────────────
    let client = Client::builder()
        .timeout(SUBMIT_TIMEOUT)
        .build()
        .map_err(|e| AppError::Internal(format!("http client init failed: {e}")))?;

    let resp = client
        .post(ENDPOINT)
        .header("X-Argus-Feedback-Key", app_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                AppError::Internal("Feedback submission timed out".into())
            } else {
                AppError::Internal(format!("Feedback request failed: {e}"))
            }
        })?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "Feedback endpoint returned {status}: {body}"
        )));
    }

    let phase1: FeedbackResponse = resp.json().await.map_err(|e| {
        AppError::Internal(format!("Failed to parse feedback response: {e}"))
    })?;

    info!(target: "feedback", id = %phase1.id, "feedback record created");

    // ── Phase 2: PUT each attachment to its presigned URL ─────────────────
    if !attachment_paths.is_empty() {
        let upload_client = Client::builder()
            .timeout(UPLOAD_TIMEOUT)
            .build()
            .map_err(|e| AppError::Internal(format!("upload client init failed: {e}")))?;

        for raw_path in &attachment_paths {
            let path = Path::new(raw_path);
            let filename = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            // Find the matching upload entry by filename.
            let upload_entry = phase1.uploads.iter().find(|u| u.filename == filename);
            let entry = match upload_entry {
                Some(e) => e,
                None => {
                    warn!(
                        target: "feedback",
                        id = %phase1.id,
                        filename = %filename,
                        "no presigned URL returned for attachment — skipping upload"
                    );
                    continue;
                }
            };

            let bytes = std::fs::read(path).map_err(|e| {
                AppError::Internal(format!(
                    "Feedback record {} was created but attachment '{}' could not be read: {e}",
                    phase1.id, filename
                ))
            })?;

            let content_type = guess_content_type(path).to_string();

            let upload_resp = upload_client
                .put(&entry.url)
                .header("Content-Type", content_type)
                .body(bytes)
                .send()
                .await
                .map_err(|e| {
                    AppError::Internal(format!(
                        "Feedback record {} was created but upload of '{}' failed: {e}",
                        phase1.id, filename
                    ))
                })?;

            let upload_status = upload_resp.status();
            if !upload_status.is_success() {
                let body = upload_resp.text().await.unwrap_or_default();
                return Err(AppError::Internal(format!(
                    "Feedback record {} was created but S3 upload of '{}' returned {upload_status}: {body}",
                    phase1.id, filename
                )));
            }

            info!(
                target: "feedback",
                id = %phase1.id,
                filename = %filename,
                "attachment uploaded"
            );
        }
    }

    Ok(FeedbackResult { id: phase1.id })
}
