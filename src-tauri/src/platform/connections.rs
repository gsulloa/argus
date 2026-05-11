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
    pub group_id: Option<Uuid>,
    pub sort_order: f64,
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
    pub group_id: Option<Uuid>,
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

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionMove {
    pub group_id: Option<Uuid>,
    pub sort_order: f64,
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

fn group_exists(conn: &rusqlite::Connection, group_id: &Uuid) -> AppResult<bool> {
    let exists: Option<i32> = conn
        .query_row(
            "SELECT 1 FROM connection_groups WHERE id = ?1",
            params![group_id.as_bytes().to_vec()],
            |r| r.get(0),
        )
        .optional()?;
    Ok(exists.is_some())
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
    let group_id_bytes: Option<Vec<u8>> = row.get(4)?;
    let group_id = match group_id_bytes {
        Some(bytes) => Some(Uuid::from_slice(&bytes).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Blob, Box::new(e))
        })?),
        None => None,
    };
    let sort_order: f64 = row.get(5)?;
    let created_at: i64 = row.get(6)?;
    let updated_at: i64 = row.get(7)?;

    Ok(Connection {
        id,
        name,
        kind,
        params,
        group_id,
        sort_order,
        created_at,
        updated_at,
    })
}

const SELECT_CONNECTION_COLS: &str =
    "id, name, kind, params_json, group_id, sort_order, created_at, updated_at";

pub fn list(conn: &rusqlite::Connection) -> AppResult<Vec<Connection>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.name, c.kind, c.params_json, c.group_id, c.sort_order, c.created_at, c.updated_at \
         FROM connections c \
         LEFT JOIN connection_groups g ON g.id = c.group_id \
         ORDER BY (c.group_id IS NULL) ASC, COALESCE(g.sort_order, 0) ASC, c.sort_order ASC",
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
    if let Some(g) = input.group_id.as_ref() {
        if !group_exists(conn, g)? {
            return Err(AppError::NotFound(format!(
                "connection_group {g} not found"
            )));
        }
    }
    let id = Uuid::new_v4();
    let now = now_unix();
    let params_json = serde_json::to_string(&input.params)?;

    let max: f64 = match input.group_id.as_ref() {
        Some(g) => conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), 0.0) FROM connections WHERE group_id = ?1",
                params![g.as_bytes().to_vec()],
                |r| r.get(0),
            )
            .unwrap_or(0.0),
        None => conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), 0.0) FROM connections WHERE group_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0.0),
    };
    let sort_order = max + 1.0;

    conn.execute(
        "INSERT INTO connections (id, name, kind, params_json, group_id, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            id.as_bytes().to_vec(),
            input.name.trim(),
            input.kind,
            params_json,
            input.group_id.map(|g| g.as_bytes().to_vec()),
            sort_order,
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
        group_id: input.group_id,
        sort_order,
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
            &format!("SELECT {SELECT_CONNECTION_COLS} FROM connections WHERE id = ?1"),
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

pub fn move_(conn: &rusqlite::Connection, id: Uuid, m: ConnectionMove) -> AppResult<Connection> {
    if let Some(g) = m.group_id.as_ref() {
        if !group_exists(conn, g)? {
            return Err(AppError::NotFound(format!(
                "connection_group {g} not found"
            )));
        }
    }
    let now = now_unix();
    let affected = conn.execute(
        "UPDATE connections SET group_id = ?2, sort_order = ?3, updated_at = ?4 WHERE id = ?1",
        params![
            id.as_bytes().to_vec(),
            m.group_id.map(|g| g.as_bytes().to_vec()),
            m.sort_order,
            now,
        ],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("connection {id} not found")));
    }
    let row = conn.query_row(
        &format!("SELECT {SELECT_CONNECTION_COLS} FROM connections WHERE id = ?1"),
        params![id.as_bytes().to_vec()],
        row_to_connection,
    )?;
    Ok(row)
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

pub fn refresh_secret(conn: &rusqlite::Connection, id: Uuid) -> AppResult<Option<String>> {
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
    secrets::refresh(&id)
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
pub fn connections_move(
    state: State<'_, DbState>,
    id: String,
    r#move: ConnectionMove,
) -> AppResult<Connection> {
    let id = Uuid::parse_str(&id).map_err(|e| AppError::Validation(format!("bad uuid: {e}")))?;
    let conn = state.0.lock().expect("db poisoned");
    self::move_(&conn, id, r#move)
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

#[tauri::command]
pub fn connections_refresh_secret(
    state: State<'_, DbState>,
    id: String,
) -> AppResult<Option<String>> {
    let id = Uuid::parse_str(&id).map_err(|e| AppError::Validation(format!("bad uuid: {e}")))?;
    let conn = state.0.lock().expect("db poisoned");
    refresh_secret(&conn, id)
}

// ---------------- tests ----------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::connection_groups;
    use crate::platform::storage::open_in_memory;

    fn fresh() -> rusqlite::Connection {
        // Each test uses a freshly generated `Uuid`, so the global secrets
        // store does not need to be wiped between tests. Wiping it here would
        // race with concurrent cache tests in `secrets::cache_tests` and erase
        // their state mid-execution.
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
                group_id: None,
                secret: Some("hunter2".into()),
            },
        )
        .unwrap();
        let listed = list(&c).unwrap();
        assert_eq!(listed.len(), 1);
        let json = serde_json::to_string(&listed[0]).unwrap();
        assert!(!json.contains("hunter2"));
        assert_eq!(get_secret(&c, made.id).unwrap().as_deref(), Some("hunter2"));
        assert!(listed[0].group_id.is_none());
        assert!(listed[0].sort_order > 0.0);
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
                group_id: None,
                secret: None,
            },
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert!(list(&c).unwrap().is_empty());
    }

    #[test]
    fn create_with_unknown_group_fails() {
        let c = fresh();
        let err = create(
            &c,
            ConnectionInput {
                name: "x".into(),
                kind: "postgres".into(),
                params: JsonValue::Null,
                group_id: Some(Uuid::new_v4()),
                secret: None,
            },
        )
        .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        assert!(list(&c).unwrap().is_empty());
    }

    #[test]
    fn create_inside_group_inherits_group_id() {
        let c = fresh();
        let g = connection_groups::create(
            &c,
            connection_groups::ConnectionGroupInput {
                name: "Production".into(),
            },
        )
        .unwrap();
        let made = create(
            &c,
            ConnectionInput {
                name: "x".into(),
                kind: "postgres".into(),
                params: JsonValue::Null,
                group_id: Some(g.id),
                secret: None,
            },
        )
        .unwrap();
        assert_eq!(made.group_id, Some(g.id));
    }

    #[test]
    fn update_renames_and_does_not_change_group() {
        let c = fresh();
        let g = connection_groups::create(
            &c,
            connection_groups::ConnectionGroupInput {
                name: "Production".into(),
            },
        )
        .unwrap();
        let made = create(
            &c,
            ConnectionInput {
                name: "Old".into(),
                kind: "postgres".into(),
                params: JsonValue::Null,
                group_id: Some(g.id),
                secret: None,
            },
        )
        .unwrap();
        let original_sort = made.sort_order;
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
        assert_eq!(updated.group_id, Some(g.id));
        assert_eq!(updated.sort_order, original_sort);
        assert!(updated.updated_at >= made.updated_at);
    }

    #[test]
    fn move_changes_group_and_sort_order() {
        let c = fresh();
        let g = connection_groups::create(
            &c,
            connection_groups::ConnectionGroupInput {
                name: "Production".into(),
            },
        )
        .unwrap();
        let made = create(
            &c,
            ConnectionInput {
                name: "x".into(),
                kind: "postgres".into(),
                params: JsonValue::Null,
                group_id: None,
                secret: Some("s".into()),
            },
        )
        .unwrap();
        let moved = move_(
            &c,
            made.id,
            ConnectionMove {
                group_id: Some(g.id),
                sort_order: 2.5,
            },
        )
        .unwrap();
        assert_eq!(moved.group_id, Some(g.id));
        assert_eq!(moved.sort_order, 2.5);
        assert!(moved.updated_at >= made.updated_at);
        assert_eq!(get_secret(&c, made.id).unwrap().as_deref(), Some("s"));
    }

    #[test]
    fn move_to_ungrouped_clears_group_id() {
        let c = fresh();
        let g = connection_groups::create(
            &c,
            connection_groups::ConnectionGroupInput {
                name: "Production".into(),
            },
        )
        .unwrap();
        let made = create(
            &c,
            ConnectionInput {
                name: "x".into(),
                kind: "postgres".into(),
                params: JsonValue::Null,
                group_id: Some(g.id),
                secret: None,
            },
        )
        .unwrap();
        let moved = move_(
            &c,
            made.id,
            ConnectionMove {
                group_id: None,
                sort_order: 1.0,
            },
        )
        .unwrap();
        assert!(moved.group_id.is_none());
        assert_eq!(moved.sort_order, 1.0);
    }

    #[test]
    fn move_unknown_id_returns_not_found() {
        let c = fresh();
        let err = move_(
            &c,
            Uuid::new_v4(),
            ConnectionMove {
                group_id: None,
                sort_order: 1.0,
            },
        )
        .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn move_into_unknown_group_returns_not_found() {
        let c = fresh();
        let made = create(
            &c,
            ConnectionInput {
                name: "x".into(),
                kind: "postgres".into(),
                params: JsonValue::Null,
                group_id: None,
                secret: None,
            },
        )
        .unwrap();
        let err = move_(
            &c,
            made.id,
            ConnectionMove {
                group_id: Some(Uuid::new_v4()),
                sort_order: 1.0,
            },
        )
        .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        let row = list(&c).unwrap();
        assert!(row[0].group_id.is_none());
    }

    #[test]
    fn list_orders_by_group_then_sort_order_ungrouped_last() {
        let c = fresh();
        let g_a = connection_groups::create(
            &c,
            connection_groups::ConnectionGroupInput { name: "A".into() },
        )
        .unwrap();
        let g_b = connection_groups::create(
            &c,
            connection_groups::ConnectionGroupInput { name: "B".into() },
        )
        .unwrap();
        let _ungrouped = create(
            &c,
            ConnectionInput {
                name: "u".into(),
                kind: "postgres".into(),
                params: JsonValue::Null,
                group_id: None,
                secret: None,
            },
        )
        .unwrap();
        let _b_first = create(
            &c,
            ConnectionInput {
                name: "b1".into(),
                kind: "postgres".into(),
                params: JsonValue::Null,
                group_id: Some(g_b.id),
                secret: None,
            },
        )
        .unwrap();
        let _a_first = create(
            &c,
            ConnectionInput {
                name: "a1".into(),
                kind: "postgres".into(),
                params: JsonValue::Null,
                group_id: Some(g_a.id),
                secret: None,
            },
        )
        .unwrap();
        let names: Vec<_> = list(&c).unwrap().into_iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["a1", "b1", "u"]);
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
                group_id: None,
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
                group_id: None,
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
    fn refresh_secret_picks_up_external_keychain_edit() {
        let c = fresh();
        let made = create(
            &c,
            ConnectionInput {
                name: "ext".into(),
                kind: "postgres".into(),
                params: JsonValue::Null,
                group_id: None,
                secret: Some("old".into()),
            },
        )
        .unwrap();
        assert_eq!(get_secret(&c, made.id).unwrap().as_deref(), Some("old"));
        secrets::_backend_set_for_tests(&made.id, "new").unwrap();
        let v = refresh_secret(&c, made.id).unwrap();
        assert_eq!(v.as_deref(), Some("new"));
        assert_eq!(get_secret(&c, made.id).unwrap().as_deref(), Some("new"));
    }

    #[test]
    fn refresh_secret_unknown_is_not_found() {
        let c = fresh();
        let err = refresh_secret(&c, Uuid::new_v4()).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }
}
