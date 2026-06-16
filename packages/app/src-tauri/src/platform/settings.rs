use rusqlite::{params, OptionalExtension};
use tauri::State;

use crate::error::AppResult;
use crate::platform::DbState;

pub fn get(conn: &rusqlite::Connection, key: &str) -> AppResult<Option<String>> {
    let v: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |r| r.get(0),
        )
        .optional()?;
    Ok(v)
}

pub fn set(conn: &rusqlite::Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[tauri::command]
pub fn settings_get(state: State<'_, DbState>, key: String) -> AppResult<Option<String>> {
    let conn = state.0.lock().expect("db poisoned");
    get(&conn, &key)
}

#[tauri::command]
pub fn settings_set(state: State<'_, DbState>, key: String, value: String) -> AppResult<()> {
    let conn = state.0.lock().expect("db poisoned");
    set(&conn, &key, &value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::storage::open_in_memory;

    #[test]
    fn upsert_and_read() {
        let c = open_in_memory().unwrap();
        assert!(get(&c, "k").unwrap().is_none());
        set(&c, "k", "v1").unwrap();
        set(&c, "k", "v2").unwrap();
        assert_eq!(get(&c, "k").unwrap().as_deref(), Some("v2"));
    }
}
