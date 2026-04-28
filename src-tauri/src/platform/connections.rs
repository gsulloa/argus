use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::State;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::platform::{secrets, DbState};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    pub id: Uuid,
    pub name: String,
    pub kind: String,
    pub params: JsonValue,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionInput {
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub params: JsonValue,
    #[serde(default)]
    pub secret: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConnectionUpdate {
    pub name: Option<String>,
    pub params: Option<JsonValue>,
    /// Triple state: missing field = leave secret untouched, `Some(Some(s))` = replace,
    /// `Some(None)` = delete the keychain entry.
    #[serde(default, deserialize_with = "deserialize_secret_field")]
    pub secret: Option<Option<String>>,
}

fn deserialize_secret_field<'de, D>(d: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v: Option<Option<String>> = Option::<Option<String>>::deserialize(d)?;
    Ok(v)
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn validate_name(name: &str) -> AppResult<()> {
    if name.trim().is_empty() {
        return Err(AppError::Validation("name must not be empty".into()));
    }
    Ok(())
}

fn row_to_connection(row: &rusqlite::Row<'_>) -> rusqlite::Result<Connection> {
    let id_bytes: Vec<u8> = row.get(0)?;
    let id = Uuid::from_slice(&id_bytes).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Blob, Box::new(e))
    })?;
    let name: String = row.get(1)?;
    let kind: String = row.get(2)?;
    let params_json: String = row.get(3)?;
    let params: JsonValue = serde_json::from_str(&params_json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let created_at: i64 = row.get(4)?;
    let updated_at: i64 = row.get(5)?;

    Ok(Connection {
        id,
        name,
        kind,
        params,
        created_at,
        updated_at,
    })
}

pub fn list(conn: &rusqlite::Connection) -> AppResult<Vec<Connection>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, kind, params_json, created_at, updated_at
         FROM connections ORDER BY name COLLATE NOCASE ASC",
    )?;
    let rows = stmt.query_map([], row_to_connection)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn create(conn: &rusqlite::Connection, input: ConnectionInput) -> AppResult<Connection> {
    validate_name(&input.name)?;
    let id = Uuid::new_v4();
    let now = now_unix();
    let params_json = serde_json::to_string(&input.params)?;

    conn.execute(
        "INSERT INTO connections (id, name, kind, params_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![
            id.as_bytes().to_vec(),
            input.name.trim(),
            input.kind,
            params_json,
            now,
        ],
    )?;

    if let Some(secret) = input.secret.as_deref() {
        if !secret.is_empty() {
            secrets::set(&id, secret)?;
        }
    }

    Ok(Connection {
        id,
        name: input.name.trim().to_string(),
        kind: input.kind,
        params: input.params,
        created_at: now,
        updated_at: now,
    })
}

pub fn update(
    conn: &rusqlite::Connection,
    id: Uuid,
    update: ConnectionUpdate,
) -> AppResult<Connection> {
    let existing: Option<Connection> = conn
        .query_row(
            "SELECT id, name, kind, params_json, created_at, updated_at
             FROM connections WHERE id = ?1",
            params![id.as_bytes().to_vec()],
            row_to_connection,
        )
        .optional()?;

    let mut current =
        existing.ok_or_else(|| AppError::NotFound(format!("connection {id} not found")))?;

    if let Some(name) = update.name.as_deref() {
        validate_name(name)?;
        current.name = name.trim().to_string();
    }
    if let Some(params) = update.params {
        current.params = params;
    }
    current.updated_at = now_unix();

    let params_json = serde_json::to_string(&current.params)?;
    conn.execute(
        "UPDATE connections SET name = ?2, params_json = ?3, updated_at = ?4 WHERE id = ?1",
        params![
            current.id.as_bytes().to_vec(),
            current.name,
            params_json,
            current.updated_at,
        ],
    )?;

    match update.secret {
        Some(Some(s)) => {
            secrets::set(&current.id, &s)?;
        }
        Some(None) => {
            secrets::delete(&current.id)?;
        }
        None => {}
    }

    Ok(current)
}

pub fn delete(conn: &rusqlite::Connection, id: Uuid) -> AppResult<()> {
    let affected = conn.execute(
        "DELETE FROM connections WHERE id = ?1",
        params![id.as_bytes().to_vec()],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("connection {id} not found")));
    }
    secrets::delete(&id)?;
    Ok(())
}

pub fn get_secret(conn: &rusqlite::Connection, id: Uuid) -> AppResult<Option<String>> {
    let exists: Option<i32> = conn
        .query_row(
            "SELECT 1 FROM connections WHERE id = ?1",
            params![id.as_bytes().to_vec()],
            |r| r.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("connection {id} not found")));
    }
    secrets::get(&id)
}

// ---------------- Tauri commands ----------------

#[tauri::command]
pub fn connections_list(state: State<'_, DbState>) -> AppResult<Vec<Connection>> {
    let conn = state.0.lock().expect("db poisoned");
    list(&conn)
}

#[tauri::command]
pub fn connections_create(
    state: State<'_, DbState>,
    input: ConnectionInput,
) -> AppResult<Connection> {
    let conn = state.0.lock().expect("db poisoned");
    create(&conn, input)
}

#[tauri::command]
pub fn connections_update(
    state: State<'_, DbState>,
    id: String,
    update: ConnectionUpdate,
) -> AppResult<Connection> {
    let id = Uuid::parse_str(&id).map_err(|e| AppError::Validation(format!("bad uuid: {e}")))?;
    let conn = state.0.lock().expect("db poisoned");
    self::update(&conn, id, update)
}

#[tauri::command]
pub fn connections_delete(state: State<'_, DbState>, id: String) -> AppResult<()> {
    let id = Uuid::parse_str(&id).map_err(|e| AppError::Validation(format!("bad uuid: {e}")))?;
    let conn = state.0.lock().expect("db poisoned");
    delete(&conn, id)
}

#[tauri::command]
pub fn connections_get_secret(state: State<'_, DbState>, id: String) -> AppResult<Option<String>> {
    let id = Uuid::parse_str(&id).map_err(|e| AppError::Validation(format!("bad uuid: {e}")))?;
    let conn = state.0.lock().expect("db poisoned");
    get_secret(&conn, id)
}

// ---------------- tests ----------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::storage::open_in_memory;

    fn fresh() -> rusqlite::Connection {
        secrets::_clear_for_tests();
        open_in_memory().expect("open in-memory db")
    }

    #[test]
    fn list_empty() {
        let c = fresh();
        assert!(list(&c).unwrap().is_empty());
    }

    #[test]
    fn create_and_list_excludes_secret() {
        let c = fresh();
        let made = create(
            &c,
            ConnectionInput {
                name: "Local".into(),
                kind: "postgres".into(),
                params: serde_json::json!({"host": "localhost"}),
                secret: Some("hunter2".into()),
            },
        )
        .unwrap();
        let listed = list(&c).unwrap();
        assert_eq!(listed.len(), 1);
        let json = serde_json::to_string(&listed[0]).unwrap();
        assert!(!json.contains("hunter2"));
        assert_eq!(get_secret(&c, made.id).unwrap().as_deref(), Some("hunter2"));
    }

    #[test]
    fn create_validates_name() {
        let c = fresh();
        let err = create(
            &c,
            ConnectionInput {
                name: "   ".into(),
                kind: "postgres".into(),
                params: JsonValue::Null,
                secret: None,
            },
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert!(list(&c).unwrap().is_empty());
    }

    #[test]
    fn update_renames_and_bumps_updated_at() {
        let c = fresh();
        let made = create(
            &c,
            ConnectionInput {
                name: "Old".into(),
                kind: "postgres".into(),
                params: serde_json::json!({}),
                secret: None,
            },
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_secs(1));
        let updated = update(
            &c,
            made.id,
            ConnectionUpdate {
                name: Some("New".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(updated.name, "New");
        assert!(updated.updated_at >= made.updated_at);
    }

    #[test]
    fn update_replaces_and_clears_secret() {
        let c = fresh();
        let made = create(
            &c,
            ConnectionInput {
                name: "x".into(),
                kind: "postgres".into(),
                params: JsonValue::Null,
                secret: Some("a".into()),
            },
        )
        .unwrap();
        update(
            &c,
            made.id,
            ConnectionUpdate {
                secret: Some(Some("b".into())),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(get_secret(&c, made.id).unwrap().as_deref(), Some("b"));

        update(
            &c,
            made.id,
            ConnectionUpdate {
                secret: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(get_secret(&c, made.id).unwrap().is_none());
    }

    #[test]
    fn update_unknown_returns_not_found() {
        let c = fresh();
        let err = update(&c, Uuid::new_v4(), ConnectionUpdate::default()).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn delete_removes_row_and_secret() {
        let c = fresh();
        let made = create(
            &c,
            ConnectionInput {
                name: "x".into(),
                kind: "postgres".into(),
                params: JsonValue::Null,
                secret: Some("s".into()),
            },
        )
        .unwrap();
        delete(&c, made.id).unwrap();
        assert!(list(&c).unwrap().is_empty());
        assert!(secrets::get(&made.id).unwrap().is_none());
    }

    #[test]
    fn delete_unknown_is_not_found() {
        let c = fresh();
        let err = delete(&c, Uuid::new_v4()).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn get_secret_unknown_is_not_found() {
        let c = fresh();
        let err = get_secret(&c, Uuid::new_v4()).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn list_orders_by_name() {
        let c = fresh();
        for n in ["zebra", "apple", "mango"] {
            create(
                &c,
                ConnectionInput {
                    name: n.into(),
                    kind: "postgres".into(),
                    params: JsonValue::Null,
                    secret: None,
                },
            )
            .unwrap();
        }
        let names: Vec<_> = list(&c).unwrap().into_iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["apple", "mango", "zebra"]);
    }
}
