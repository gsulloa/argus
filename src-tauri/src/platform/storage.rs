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
    (
        "0003_groups.sql",
        include_str!("../../migrations/0003_groups.sql"),
    ),
    (
        "0004_saved_queries.sql",
        include_str!("../../migrations/0004_saved_queries.sql"),
    ),
    (
        "0005_connection_context.sql",
        include_str!("../../migrations/0005_connection_context.sql"),
    ),
    (
        "0006_ai_settings.sql",
        include_str!("../../migrations/0006_ai_settings.sql"),
    ),
    (
        "0007_project_source.sql",
        include_str!("../../migrations/0007_project_source.sql"),
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

    enable_foreign_keys(&conn)?;
    apply_migrations(&mut conn)?;
    Ok(conn)
}

#[cfg(test)]
pub fn open_in_memory() -> AppResult<Connection> {
    let mut conn = Connection::open_in_memory()?;
    enable_foreign_keys(&conn)?;
    apply_migrations(&mut conn)?;
    Ok(conn)
}

fn enable_foreign_keys(conn: &Connection) -> AppResult<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    let on: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?;
    if on != 1 {
        return Err(AppError::Storage(
            "failed to enable PRAGMA foreign_keys".into(),
        ));
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use uuid::Uuid;

    #[test]
    fn fresh_db_has_groups_table_and_columns() {
        let conn = open_in_memory().expect("open in-memory");
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(connections)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(cols.iter().any(|c| c == "group_id"));
        assert!(cols.iter().any(|c| c == "sort_order"));

        let group_table_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'connection_groups'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(group_table_count, 1);
    }

    #[test]
    fn fk_set_null_fires_on_group_delete() {
        let conn = open_in_memory().expect("open in-memory");
        let group_id = Uuid::new_v4();
        let conn_id = Uuid::new_v4();
        let now: i64 = 1;
        conn.execute(
            "INSERT INTO connection_groups (id, name, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![group_id.as_bytes().to_vec(), "g", 1.0_f64, now],
        ).unwrap();
        conn.execute(
            "INSERT INTO connections (id, name, kind, params_json, group_id, sort_order, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                conn_id.as_bytes().to_vec(),
                "c",
                "postgres",
                "{}",
                group_id.as_bytes().to_vec(),
                1.0_f64,
                now,
            ],
        ).unwrap();

        conn.execute(
            "DELETE FROM connection_groups WHERE id = ?1",
            params![group_id.as_bytes().to_vec()],
        )
        .unwrap();

        let group_id_after: Option<Vec<u8>> = conn
            .query_row(
                "SELECT group_id FROM connections WHERE id = ?1",
                params![conn_id.as_bytes().to_vec()],
                |r| r.get(0),
            )
            .unwrap();
        assert!(group_id_after.is_none());
    }

    #[test]
    fn backfilled_sort_order_is_alphabetical() {
        let conn = Connection::open_in_memory().unwrap();
        enable_foreign_keys(&conn).unwrap();

        conn.execute_batch(include_str!("../../migrations/0001_init.sql"))
            .unwrap();
        conn.execute_batch(include_str!("../../migrations/0002_query_history.sql"))
            .unwrap();

        for (name, n) in [("zebra", 0_i64), ("apple", 1), ("mango", 2)] {
            let id = Uuid::new_v4();
            conn.execute(
                "INSERT INTO connections (id, name, kind, params_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![id.as_bytes().to_vec(), name, "postgres", "{}", n],
            ).unwrap();
        }

        conn.execute_batch(include_str!("../../migrations/0003_groups.sql"))
            .unwrap();

        let order: Vec<(String, f64)> = conn
            .prepare("SELECT name, sort_order FROM connections ORDER BY sort_order ASC")
            .unwrap()
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(order[0].0, "apple");
        assert_eq!(order[1].0, "mango");
        assert_eq!(order[2].0, "zebra");
        for w in order.windows(2) {
            assert!(w[0].1 < w[1].1);
        }
    }
}
