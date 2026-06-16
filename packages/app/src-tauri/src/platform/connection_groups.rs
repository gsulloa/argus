use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::platform::DbState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionGroup {
    pub id: Uuid,
    pub name: String,
    pub sort_order: f64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionGroupInput {
    pub name: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConnectionGroupUpdate {
    pub name: Option<String>,
    pub sort_order: Option<f64>,
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

fn row_to_group(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConnectionGroup> {
    let id_bytes: Vec<u8> = row.get(0)?;
    let id = Uuid::from_slice(&id_bytes).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Blob, Box::new(e))
    })?;
    Ok(ConnectionGroup {
        id,
        name: row.get(1)?,
        sort_order: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

pub fn list(conn: &rusqlite::Connection) -> AppResult<Vec<ConnectionGroup>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, sort_order, created_at, updated_at
         FROM connection_groups ORDER BY sort_order ASC",
    )?;
    let rows = stmt.query_map([], row_to_group)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get(conn: &rusqlite::Connection, id: Uuid) -> AppResult<Option<ConnectionGroup>> {
    let row = conn
        .query_row(
            "SELECT id, name, sort_order, created_at, updated_at
             FROM connection_groups WHERE id = ?1",
            params![id.as_bytes().to_vec()],
            row_to_group,
        )
        .optional()?;
    Ok(row)
}

pub fn create(
    conn: &rusqlite::Connection,
    input: ConnectionGroupInput,
) -> AppResult<ConnectionGroup> {
    validate_name(&input.name)?;
    let id = Uuid::new_v4();
    let now = now_unix();

    let max: f64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), 0.0) FROM connection_groups",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0.0);
    let sort_order = max + 1.0;

    conn.execute(
        "INSERT INTO connection_groups (id, name, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![id.as_bytes().to_vec(), input.name.trim(), sort_order, now,],
    )?;

    Ok(ConnectionGroup {
        id,
        name: input.name.trim().to_string(),
        sort_order,
        created_at: now,
        updated_at: now,
    })
}

pub fn update(
    conn: &rusqlite::Connection,
    id: Uuid,
    update: ConnectionGroupUpdate,
) -> AppResult<ConnectionGroup> {
    let mut current = get(conn, id)?
        .ok_or_else(|| AppError::NotFound(format!("connection_group {id} not found")))?;

    if let Some(name) = update.name.as_deref() {
        validate_name(name)?;
        current.name = name.trim().to_string();
    }
    if let Some(sort_order) = update.sort_order {
        current.sort_order = sort_order;
    }
    current.updated_at = now_unix();

    conn.execute(
        "UPDATE connection_groups SET name = ?2, sort_order = ?3, updated_at = ?4 WHERE id = ?1",
        params![
            current.id.as_bytes().to_vec(),
            current.name,
            current.sort_order,
            current.updated_at,
        ],
    )?;

    Ok(current)
}

pub fn delete(conn: &rusqlite::Connection, id: Uuid) -> AppResult<()> {
    let affected = conn.execute(
        "DELETE FROM connection_groups WHERE id = ?1",
        params![id.as_bytes().to_vec()],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!(
            "connection_group {id} not found"
        )));
    }
    Ok(())
}

// ---------------- Tauri commands ----------------

#[tauri::command]
pub fn connection_groups_list(state: State<'_, DbState>) -> AppResult<Vec<ConnectionGroup>> {
    let conn = state.0.lock().expect("db poisoned");
    list(&conn)
}

#[tauri::command]
pub fn connection_groups_create(
    state: State<'_, DbState>,
    input: ConnectionGroupInput,
) -> AppResult<ConnectionGroup> {
    let conn = state.0.lock().expect("db poisoned");
    create(&conn, input)
}

#[tauri::command]
pub fn connection_groups_update(
    state: State<'_, DbState>,
    id: String,
    update: ConnectionGroupUpdate,
) -> AppResult<ConnectionGroup> {
    let id = Uuid::parse_str(&id).map_err(|e| AppError::Validation(format!("bad uuid: {e}")))?;
    let conn = state.0.lock().expect("db poisoned");
    self::update(&conn, id, update)
}

#[tauri::command]
pub fn connection_groups_delete(state: State<'_, DbState>, id: String) -> AppResult<()> {
    let id = Uuid::parse_str(&id).map_err(|e| AppError::Validation(format!("bad uuid: {e}")))?;
    let conn = state.0.lock().expect("db poisoned");
    delete(&conn, id)
}

// ---------------- tests ----------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::storage::open_in_memory;

    fn fresh() -> rusqlite::Connection {
        open_in_memory().expect("open in-memory db")
    }

    #[test]
    fn list_empty() {
        let c = fresh();
        assert!(list(&c).unwrap().is_empty());
    }

    #[test]
    fn create_assigns_increasing_sort_order() {
        let c = fresh();
        let g1 = create(
            &c,
            ConnectionGroupInput {
                name: "Production".into(),
            },
        )
        .unwrap();
        let g2 = create(
            &c,
            ConnectionGroupInput {
                name: "Staging".into(),
            },
        )
        .unwrap();
        assert!(g2.sort_order > g1.sort_order);
        assert!(g1.sort_order > 0.0);
    }

    #[test]
    fn create_validates_name() {
        let c = fresh();
        let err = create(&c, ConnectionGroupInput { name: "  ".into() }).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert!(list(&c).unwrap().is_empty());
    }

    #[test]
    fn list_orders_by_sort_order() {
        let c = fresh();
        let _g1 = create(
            &c,
            ConnectionGroupInput {
                name: "First".into(),
            },
        )
        .unwrap();
        let g2 = create(
            &c,
            ConnectionGroupInput {
                name: "Second".into(),
            },
        )
        .unwrap();
        update(
            &c,
            g2.id,
            ConnectionGroupUpdate {
                sort_order: Some(0.5),
                ..Default::default()
            },
        )
        .unwrap();
        let names: Vec<_> = list(&c).unwrap().into_iter().map(|g| g.name).collect();
        assert_eq!(names, vec!["Second", "First"]);
    }

    #[test]
    fn update_renames_and_bumps_updated_at() {
        let c = fresh();
        let g = create(&c, ConnectionGroupInput { name: "Old".into() }).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(1));
        let updated = update(
            &c,
            g.id,
            ConnectionGroupUpdate {
                name: Some("New".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(updated.name, "New");
        assert!(updated.updated_at >= g.updated_at);
        assert_eq!(updated.sort_order, g.sort_order);
    }

    #[test]
    fn update_unknown_returns_not_found() {
        let c = fresh();
        let err = update(&c, Uuid::new_v4(), ConnectionGroupUpdate::default()).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn duplicate_names_allowed() {
        let c = fresh();
        let _g1 = create(
            &c,
            ConnectionGroupInput {
                name: "prod".into(),
            },
        )
        .unwrap();
        let _g2 = create(
            &c,
            ConnectionGroupInput {
                name: "prod".into(),
            },
        )
        .unwrap();
        assert_eq!(list(&c).unwrap().len(), 2);
    }

    #[test]
    fn delete_empty_group() {
        let c = fresh();
        let g = create(&c, ConnectionGroupInput { name: "g".into() }).unwrap();
        delete(&c, g.id).unwrap();
        assert!(list(&c).unwrap().is_empty());
    }

    #[test]
    fn delete_unknown_is_not_found() {
        let c = fresh();
        let err = delete(&c, Uuid::new_v4()).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn delete_non_empty_preserves_connections_via_fk() {
        let c = fresh();
        let g = create(&c, ConnectionGroupInput { name: "g".into() }).unwrap();
        let conn_id = Uuid::new_v4();
        let now: i64 = 1;
        c.execute(
            "INSERT INTO connections (id, name, kind, params_json, group_id, sort_order, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                conn_id.as_bytes().to_vec(),
                "c",
                "postgres",
                "{}",
                g.id.as_bytes().to_vec(),
                1.0_f64,
                now,
            ],
        ).unwrap();

        delete(&c, g.id).unwrap();

        let group_id_after: Option<Vec<u8>> = c
            .query_row(
                "SELECT group_id FROM connections WHERE id = ?1",
                params![conn_id.as_bytes().to_vec()],
                |r| r.get(0),
            )
            .unwrap();
        assert!(group_id_after.is_none());

        let row_count: i64 = c
            .query_row("SELECT COUNT(*) FROM connections", [], |r| r.get(0))
            .unwrap();
        assert_eq!(row_count, 1);
    }
}
