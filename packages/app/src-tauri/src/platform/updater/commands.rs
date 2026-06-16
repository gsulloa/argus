use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::UpdaterExt;

use super::{PendingUpdate, UpdaterState};

#[derive(Debug, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub body: Option<String>,
    pub date: Option<String>,
}

/// Check for an update, download it if available, store it in state, and
/// return metadata. Returns `None` when the app is already up-to-date.
#[tauri::command]
pub async fn updater_check_and_download(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<Option<UpdateInfo>, String> {
    tracing::info!(target: "updater", "check_started");

    let updater = app.updater().map_err(|e| {
        tracing::error!(target: "updater", error = %e, "updater_build_failed");
        e.to_string()
    })?;

    let maybe_update = updater.check().await.map_err(|e| {
        tracing::warn!(target: "updater", error = %e, "check_failed");
        e.to_string()
    })?;

    match maybe_update {
        None => {
            tracing::info!(target: "updater", available = false, "check_complete");
            Ok(None)
        }
        Some(update) => {
            let version = update.version.clone();
            let body = update.body.clone();
            let date = update.date.map(|d| d.to_string());

            tracing::info!(
                target: "updater",
                available = true,
                version = %version,
                "check_complete"
            );
            tracing::info!(target: "updater", version = %version, "download_started");

            let bytes = update.download(|_chunk, _total| {}, || {}).await.map_err(|e| {
                tracing::error!(target: "updater", error = %e, version = %version, "download_failed");
                e.to_string()
            })?;

            tracing::info!(target: "updater", version = %version, "download_complete");

            let mut pending = state.pending.lock().await;
            *pending = Some(PendingUpdate { update, bytes });

            Ok(Some(UpdateInfo {
                version,
                body,
                date,
            }))
        }
    }
}

/// User-triggered install and restart. Guards against double-invocation via
/// `installing` CAS flag. On error, puts the `Update` back into state.
#[tauri::command]
pub async fn updater_install_and_restart(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<(), String> {
    // CAS: false → true. If already true, another install is in flight.
    if state
        .installing
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        tracing::warn!(target: "updater", "install_already_in_progress");
        return Ok(());
    }

    let pending_opt = {
        let mut lock = state.pending.lock().await;
        lock.take()
    };

    let Some(pending) = pending_opt else {
        state.installing.store(false, Ordering::Release);
        tracing::warn!(target: "updater", "install_called_with_no_pending_update");
        return Ok(());
    };

    let version = pending.update.version.clone();
    tracing::info!(target: "updater", version = %version, trigger = "user_action", "install_started");

    match pending.update.install(&pending.bytes) {
        Ok(()) => {
            tracing::info!(target: "updater", version = %version, "install_complete");
            // Arm the ExitRequested short-circuit BEFORE clearing `installing`, so any
            // quit racing the two writes still sees an intercepting state.
            state.relaunching.store(true, Ordering::Release);
            state.installing.store(false, Ordering::Release);
            tracing::info!(target: "updater", "relaunch_invoked");
            app.restart();
        }
        Err(e) => {
            tracing::error!(target: "updater", error = %e, version = %version, "install_failed");
            // Put the update back so the user can retry.
            let mut lock = state.pending.lock().await;
            *lock = Some(PendingUpdate {
                update: pending.update,
                bytes: pending.bytes,
            });
            state.installing.store(false, Ordering::Release);
            return Err(e.to_string());
        }
    }
}

/// Non-command helper called by the `RunEvent::ExitRequested` hook.
/// Applies the pending update with a 10-second timeout; does NOT restart.
pub async fn apply_pending_on_exit(app: &AppHandle) {
    let state = app.state::<UpdaterState>();

    let pending_opt = {
        let mut lock = state.pending.lock().await;
        lock.take()
    };

    let Some(pending) = pending_opt else {
        return;
    };

    let version = pending.update.version.clone();
    tracing::info!(target: "updater", version = %version, trigger = "quit", "install_started");

    let result = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::task::spawn_blocking(move || pending.update.install(&pending.bytes)),
    )
    .await;

    match result {
        Ok(Ok(Ok(()))) => {
            tracing::info!(target: "updater", version = %version, "install_complete");
        }
        Ok(Ok(Err(e))) => {
            tracing::error!(target: "updater", error = %e, version = %version, "install_failed");
        }
        Ok(Err(e)) => {
            tracing::error!(target: "updater", error = %e, version = %version, "install_task_panicked");
        }
        Err(_elapsed) => {
            tracing::error!(target: "updater", version = %version, "install_timeout_on_exit");
        }
    }
}

/// Log an updater event originating from the renderer. Maps `level` to the
/// appropriate `tracing` macro; unknown levels fall back to `info`.
#[tauri::command]
pub fn log_updater_event(
    level: String,
    msg: String,
    fields: Option<serde_json::Value>,
) -> Result<(), String> {
    let fields_str = fields
        .as_ref()
        .map(|f| serde_json::to_string(f).unwrap_or_else(|_| "{}".to_string()))
        .unwrap_or_else(|| "{}".to_string());

    match level.as_str() {
        "warn" => tracing::warn!(target: "updater", fields = %fields_str, "{}", msg),
        "error" => tracing::error!(target: "updater", fields = %fields_str, "{}", msg),
        _ => tracing::info!(target: "updater", fields = %fields_str, "{}", msg),
    }

    Ok(())
}

/// Read the last `max_lines` updater-tagged lines from the active log file.
/// Returns a placeholder string when no matching lines are found.
#[tauri::command]
pub async fn updater_logs_tail(app: AppHandle, max_lines: usize) -> Result<String, String> {
    let max_lines = max_lines.min(1000);

    let log_dir = app.path().app_log_dir().map_err(|e| {
        tracing::error!(target: "updater", error = %e, "log_dir_resolution_failed");
        e.to_string()
    })?;

    // Find the active log file: prefer `argus.log`, else newest `argus.log.*`
    let log_path = find_log_file(&log_dir)?;

    let Some(path) = log_path else {
        return Ok("(no updater events recorded yet)".to_string());
    };

    let content = std::fs::read(&path).map_err(|e| {
        tracing::error!(target: "updater", error = %e, "log_read_failed");
        e.to_string()
    })?;

    if content.is_empty() {
        return Ok("(no updater events recorded yet)".to_string());
    }

    // Collect lines containing "updater" from the end of the file.
    // We do a reverse pass over up to 1 MB to bound memory usage.
    const MAX_READ: usize = 1024 * 1024; // 1 MB
    let slice = if content.len() > MAX_READ {
        &content[content.len() - MAX_READ..]
    } else {
        &content
    };

    let text = String::from_utf8_lossy(slice);
    let matching: Vec<&str> = text
        .lines()
        .filter(|line| line.contains("updater"))
        .collect();

    if matching.is_empty() {
        return Ok("(no updater events recorded yet)".to_string());
    }

    // Return the last `max_lines` lines, oldest-to-newest order.
    let start = matching.len().saturating_sub(max_lines);
    let result = matching[start..].join("\n");
    Ok(result)
}

fn find_log_file(log_dir: &std::path::Path) -> Result<Option<std::path::PathBuf>, String> {
    // migration-sensitive: log file stem; see config::app_identity::LOG_FILE_STEM.
    let stem = crate::config::app_identity::LOG_FILE_STEM;
    let rotated_prefix = format!("{stem}.");
    let plain = log_dir.join(stem);
    if plain.exists() {
        // Also check if there are rotated files newer than the plain one. Rolling
        // appender writes to `argus.log.YYYY-MM-DD`; the plain file is the
        // current day's file. Return the plain one unless a rotated file is
        // strictly newer.
        return Ok(Some(plain));
    }

    // No plain file — look for rotated `argus.log.*` files and pick the newest.
    let entries = std::fs::read_dir(log_dir).map_err(|e| e.to_string())?;
    let mut candidates: Vec<(String, std::path::PathBuf)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with(&rotated_prefix) {
                Some((name, e.path()))
            } else {
                None
            }
        })
        .collect();

    if candidates.is_empty() {
        return Ok(None);
    }

    // Sort descending by file name (date suffix sorts lexicographically).
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(Some(candidates.remove(0).1))
}

/// Reveal the log directory in the OS file manager.
#[tauri::command]
pub fn updater_logs_reveal(app: AppHandle) -> Result<(), String> {
    let log_dir = app.path().app_log_dir().map_err(|e| {
        tracing::error!(target: "updater", error = %e, "log_dir_resolution_failed");
        e.to_string()
    })?;

    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut cmd = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut cmd = std::process::Command::new("explorer");

    cmd.arg(&log_dir);

    match cmd.spawn() {
        Ok(_) => {
            tracing::info!(target: "updater", "logs_revealed");
            Ok(())
        }
        Err(_) => Err(format!("Log folder: {}", log_dir.display())),
    }
}
