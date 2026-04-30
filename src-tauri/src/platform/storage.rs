use std::path::Path;

use rusqlite::Connection;
use tauri::{AppHandle, Manager};
use tracing::info;

use crate::error::{AppError, AppResult};

const MIGRATIONS: &[(&str, &str)] = &[
    (
        "0001_init.sql",
        include_str!("../../migrations/0001_init.sql"),
    ),
    (
        "0002_query_history.sql",
        include_str!("../../migrations/0002_query_history.sql"),
    ),
];

pub fn open_db(app: &AppHandle) -> AppResult<Connection> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Storage(format!("resolving app_data_dir: {e}")))?;

    std::fs::create_dir_all(&dir)?;

    let path = dir.join("argus.db");
    info!(path = %path.display(), "opening database");

    let mut conn = Connection::open(&path)
        .map_err(|e| AppError::Storage(format!("opening {}: {e}", path.display())))?;

    apply_migrations(&mut conn)?;
    Ok(conn)
}

#[cfg(test)]
pub fn open_in_memory() -> AppResult<Connection> {
    let mut conn = Connection::open_in_memory()?;
    apply_migrations(&mut conn)?;
    Ok(conn)
}

fn apply_migrations(conn: &mut Connection) -> AppResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS _migrations (
            version TEXT PRIMARY KEY,
            applied_at INTEGER NOT NULL
        )",
        [],
    )?;

    for (version, sql) in MIGRATIONS {
        let already: bool = conn
            .query_row(
                "SELECT 1 FROM _migrations WHERE version = ?1",
                [version],
                |_| Ok(true),
            )
            .unwrap_or(false);

        if already {
            continue;
        }

        info!(version, "applying migration");
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO _migrations (version, applied_at) VALUES (?1, strftime('%s','now'))",
            [version],
        )?;
        tx.commit()?;
    }

    Ok(())
}

#[allow(dead_code)]
pub fn ensure_parent(path: &Path) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(())
}
