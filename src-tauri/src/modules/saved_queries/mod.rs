//! Saved queries: personal library of named SQL queries organized in nested
//! folders, backed by the `saved_query_folders` and `saved_queries` SQLite
//! tables created in migration `0004_saved_queries.sql`.
//!
//! All public functions take a `&rusqlite::Connection` (already has
//! `PRAGMA foreign_keys = ON` applied by `storage::open_db`).

pub mod commands;

use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SavedQueryFolder {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SavedQuery {
    pub id: String,
    pub folder_id: Option<String>,
    pub name: String,
    pub sql: String,
    pub sort_order: i64,
    pub last_connection_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListResponse {
    pub folders: Vec<SavedQueryFolder>,
    pub queries: Vec<SavedQuery>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderDeleteResponse {
    pub folders_deleted: i64,
    pub queries_deleted: i64,
}

// ---------------------------------------------------------------------------
// Explicit-null handling for `last_connection_id` in update.
//
// The frontend can send three states:
//   - field absent  → don't touch the column
//   - field = some string → set to that UUID
//   - field = null  → clear the column (set to NULL)
//
// We represent this with `Option<Option<String>>`:
//   - None (outer)            → absent, no change
//   - Some(None)              → present null, clear
//   - Some(Some("uuid..."))   → present value, set
//
// In serde, `#[serde(default)]` makes absent JSON keys map to `None` (outer).
// `#[serde(deserialize_with = ...)]` is not needed because
// `Option<Option<T>>` already deserializes `null` as `Some(None)` and
// a missing key as `None` when combined with `#[serde(default)]`.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateQueryRequest {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub sql: Option<String>,
    /// - `None`         → field absent in JSON → leave column untouched
    /// - `Some(None)`   → field present as `null` in JSON → set column to NULL
    /// - `Some(Some(s))`→ field present with a value → set column to that value
    #[serde(default)]
    pub last_connection_id: Option<Option<String>>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn row_to_folder(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedQueryFolder> {
    Ok(SavedQueryFolder {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        name: row.get(2)?,
        sort_order: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn row_to_query(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedQuery> {
    let last_conn_bytes: Option<Vec<u8>> = row.get(5)?;
    let last_connection_id = last_conn_bytes
        .as_deref()
        .map(Uuid::from_slice)
        .transpose()
        .map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Blob, Box::new(e))
        })?
        .map(|u| u.to_string());
    Ok(SavedQuery {
        id: row.get(0)?,
        folder_id: row.get(1)?,
        name: row.get(2)?,
        sql: row.get(3)?,
        sort_order: row.get(4)?,
        last_connection_id,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

/// Parse a UUID string into its bytes for BLOB storage, or return Validation
/// error.
fn parse_uuid_bytes(s: &str, field: &str) -> AppResult<Vec<u8>> {
    Uuid::parse_str(s)
        .map(|u| u.as_bytes().to_vec())
        .map_err(|e| AppError::Validation(format!("invalid {field} uuid: {e}")))
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/// Return all folders and queries ordered by `(parent_id|folder_id NULLS
/// FIRST, sort_order ASC, name COLLATE NOCASE ASC)`. Two flat SELECTs — no
/// per-row queries.
pub fn list(conn: &rusqlite::Connection) -> AppResult<ListResponse> {
    let mut stmt = conn.prepare(
        "SELECT id, parent_id, name, sort_order, created_at, updated_at
         FROM saved_query_folders
         ORDER BY parent_id NULLS FIRST, sort_order ASC, name COLLATE NOCASE ASC",
    )?;
    let folders: Result<Vec<_>, _> = stmt.query_map([], row_to_folder)?.collect();
    let folders = folders?;

    let mut stmt = conn.prepare(
        "SELECT id, folder_id, name, sql, sort_order, last_connection_id, created_at, updated_at
         FROM saved_queries
         ORDER BY folder_id NULLS FIRST, sort_order ASC, name COLLATE NOCASE ASC",
    )?;
    let queries: Result<Vec<_>, _> = stmt.query_map([], row_to_query)?.collect();
    let queries = queries?;

    Ok(ListResponse { folders, queries })
}

// ---------------------------------------------------------------------------
// Folder CRUD
// ---------------------------------------------------------------------------

pub fn folder_create(
    conn: &rusqlite::Connection,
    parent_id: Option<String>,
    name: String,
) -> AppResult<SavedQueryFolder> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }

    // Validate parent exists if provided.
    if let Some(ref pid) = parent_id {
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM saved_query_folders WHERE id = ?1",
                params![pid],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !exists {
            return Err(AppError::Validation("parent folder not found".into()));
        }
    }

    // Compute next sort_order among siblings.
    let sort_order: i64 = match &parent_id {
        Some(pid) => conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM saved_query_folders WHERE parent_id = ?1",
                params![pid],
                |r| r.get(0),
            )
            .unwrap_or(0),
        None => conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM saved_query_folders WHERE parent_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0),
    };

    let id = Uuid::new_v4().to_string();
    let now = now_ms();

    conn.execute(
        "INSERT INTO saved_query_folders (id, parent_id, name, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, parent_id, name, sort_order, now],
    )?;

    conn.query_row(
        "SELECT id, parent_id, name, sort_order, created_at, updated_at
         FROM saved_query_folders WHERE id = ?1",
        params![id],
        row_to_folder,
    )
    .map_err(AppError::from)
}

pub fn folder_update(
    conn: &rusqlite::Connection,
    id: String,
    name: String,
) -> AppResult<SavedQueryFolder> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }

    let now = now_ms();
    let affected = conn.execute(
        "UPDATE saved_query_folders SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, now, id],
    )?;

    if affected == 0 {
        return Err(AppError::NotFound(format!("folder {id} not found")));
    }

    conn.query_row(
        "SELECT id, parent_id, name, sort_order, created_at, updated_at
         FROM saved_query_folders WHERE id = ?1",
        params![id],
        row_to_folder,
    )
    .map_err(AppError::from)
}

/// Move a folder to a new parent (or root) with optional sort position.
/// Uses a recursive CTE to detect cycles: rejects if `target_parent_id` is
/// `id` itself or any descendant of `id`.
pub fn folder_move(
    conn: &rusqlite::Connection,
    id: String,
    target_parent_id: Option<String>,
    target_sort_order: Option<i64>,
) -> AppResult<()> {
    // Cycle detection: check if target_parent_id is `id` or a descendant.
    if let Some(ref tpid) = target_parent_id {
        let is_cycle: bool = conn
            .query_row(
                "WITH RECURSIVE descendants(fid) AS (
                     SELECT ?1
                     UNION ALL
                     SELECT f.id
                     FROM saved_query_folders f
                     JOIN descendants d ON f.parent_id = d.fid
                 )
                 SELECT 1 FROM descendants WHERE fid = ?2 LIMIT 1",
                params![id, tpid],
                |_| Ok(true),
            )
            .unwrap_or(false);

        if is_cycle {
            return Err(AppError::Validation(
                "cannot move folder into its own descendant".into(),
            ));
        }
    }

    let now = now_ms();

    let sort_order = match target_sort_order {
        Some(target) => {
            // Renumber siblings densely: shift existing items at >= target up by 1.
            match &target_parent_id {
                Some(pid) => {
                    conn.execute(
                        "UPDATE saved_query_folders
                         SET sort_order = sort_order + 1, updated_at = ?1
                         WHERE parent_id = ?2 AND sort_order >= ?3 AND id != ?4",
                        params![now, pid, target, id],
                    )?;
                }
                None => {
                    conn.execute(
                        "UPDATE saved_query_folders
                         SET sort_order = sort_order + 1, updated_at = ?1
                         WHERE parent_id IS NULL AND sort_order >= ?2 AND id != ?3",
                        params![now, target, id],
                    )?;
                }
            }
            target
        }
        None => {
            // Append: max + 1 among new siblings (excluding self).
            match &target_parent_id {
                Some(pid) => conn
                    .query_row(
                        "SELECT COALESCE(MAX(sort_order), -1) + 1
                         FROM saved_query_folders WHERE parent_id = ?1 AND id != ?2",
                        params![pid, id],
                        |r| r.get(0),
                    )
                    .unwrap_or(0),
                None => conn
                    .query_row(
                        "SELECT COALESCE(MAX(sort_order), -1) + 1
                         FROM saved_query_folders WHERE parent_id IS NULL AND id != ?1",
                        params![id],
                        |r| r.get(0),
                    )
                    .unwrap_or(0),
            }
        }
    };

    conn.execute(
        "UPDATE saved_query_folders SET parent_id = ?1, sort_order = ?2, updated_at = ?3 WHERE id = ?4",
        params![target_parent_id, sort_order, now, id],
    )?;

    Ok(())
}

/// Delete a folder and return counts of all recursively deleted rows.
/// Counts via recursive CTE *before* deleting; cascade handles the actual
/// removal.
pub fn folder_delete(
    conn: &rusqlite::Connection,
    id: String,
) -> AppResult<FolderDeleteResponse> {
    // Verify folder exists.
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM saved_query_folders WHERE id = ?1",
            params![id],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !exists {
        return Err(AppError::NotFound(format!("folder {id} not found")));
    }

    // Count folders (including the root itself) via recursive CTE.
    let folders_deleted: i64 = conn.query_row(
        "WITH RECURSIVE subtree(fid) AS (
             SELECT ?1
             UNION ALL
             SELECT f.id
             FROM saved_query_folders f
             JOIN subtree s ON f.parent_id = s.fid
         )
         SELECT COUNT(*) FROM subtree",
        params![id],
        |r| r.get(0),
    )?;

    // Count queries in any folder in the subtree.
    let queries_deleted: i64 = conn.query_row(
        "WITH RECURSIVE subtree(fid) AS (
             SELECT ?1
             UNION ALL
             SELECT f.id
             FROM saved_query_folders f
             JOIN subtree s ON f.parent_id = s.fid
         )
         SELECT COUNT(*) FROM saved_queries q
         JOIN subtree s ON q.folder_id = s.fid",
        params![id],
        |r| r.get(0),
    )?;

    // DELETE — ON DELETE CASCADE propagates through the subtree.
    conn.execute(
        "DELETE FROM saved_query_folders WHERE id = ?1",
        params![id],
    )?;

    Ok(FolderDeleteResponse {
        folders_deleted,
        queries_deleted,
    })
}

// ---------------------------------------------------------------------------
// Query CRUD
// ---------------------------------------------------------------------------

pub fn create(
    conn: &rusqlite::Connection,
    folder_id: Option<String>,
    name: String,
    sql: String,
    last_connection_id: Option<String>,
) -> AppResult<SavedQuery> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }

    // Validate folder exists if provided.
    if let Some(ref fid) = folder_id {
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM saved_query_folders WHERE id = ?1",
                params![fid],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !exists {
            return Err(AppError::Validation("folder not found".into()));
        }
    }

    // Compute next sort_order among siblings.
    let sort_order: i64 = match &folder_id {
        Some(fid) => conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM saved_queries WHERE folder_id = ?1",
                params![fid],
                |r| r.get(0),
            )
            .unwrap_or(0),
        None => conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM saved_queries WHERE folder_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0),
    };

    let id = Uuid::new_v4().to_string();
    let now = now_ms();

    // Encode last_connection_id as BLOB bytes if provided.
    let conn_bytes: Option<Vec<u8>> = last_connection_id
        .as_deref()
        .map(|s| parse_uuid_bytes(s, "last_connection_id"))
        .transpose()?;

    conn.execute(
        "INSERT INTO saved_queries (id, folder_id, name, sql, sort_order, last_connection_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![id, folder_id, name, sql, sort_order, conn_bytes, now],
    )?;

    conn.query_row(
        "SELECT id, folder_id, name, sql, sort_order, last_connection_id, created_at, updated_at
         FROM saved_queries WHERE id = ?1",
        params![id],
        row_to_query,
    )
    .map_err(AppError::from)
}

pub fn update(conn: &rusqlite::Connection, req: UpdateQueryRequest) -> AppResult<SavedQuery> {
    let UpdateQueryRequest {
        id,
        name,
        sql,
        last_connection_id,
    } = req;

    // Ensure row exists.
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM saved_queries WHERE id = ?1",
            params![id],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !exists {
        return Err(AppError::NotFound(format!("saved_query {id} not found")));
    }

    let now = now_ms();

    if let Some(ref n) = name {
        let n = n.trim();
        if n.is_empty() {
            return Err(AppError::Validation("name is required".into()));
        }
        conn.execute(
            "UPDATE saved_queries SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![n, now, id],
        )?;
    }

    if let Some(ref s) = sql {
        conn.execute(
            "UPDATE saved_queries SET sql = ?1, updated_at = ?2 WHERE id = ?3",
            params![s, now, id],
        )?;
    }

    // Explicit-null handling: only update if field was present in payload.
    if let Some(conn_id_opt) = last_connection_id {
        let conn_bytes: Option<Vec<u8>> = conn_id_opt
            .as_deref()
            .map(|s| parse_uuid_bytes(s, "last_connection_id"))
            .transpose()?;
        conn.execute(
            "UPDATE saved_queries SET last_connection_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![conn_bytes, now, id],
        )?;
    }

    conn.query_row(
        "SELECT id, folder_id, name, sql, sort_order, last_connection_id, created_at, updated_at
         FROM saved_queries WHERE id = ?1",
        params![id],
        row_to_query,
    )
    .map_err(AppError::from)
}

/// Move a query to a new folder (or root) with optional sort position.
/// When `target_sort_order` is specified, siblings at that position and above
/// are shifted up by 1 to maintain a dense sequence.
pub fn move_query(
    conn: &rusqlite::Connection,
    id: String,
    target_folder_id: Option<String>,
    target_sort_order: Option<i64>,
) -> AppResult<()> {
    // Ensure query exists.
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM saved_queries WHERE id = ?1",
            params![id],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !exists {
        return Err(AppError::NotFound(format!("saved_query {id} not found")));
    }

    let now = now_ms();

    let sort_order = match target_sort_order {
        Some(target) => {
            // Renumber siblings: shift items at >= target up by 1.
            match &target_folder_id {
                Some(fid) => {
                    conn.execute(
                        "UPDATE saved_queries
                         SET sort_order = sort_order + 1, updated_at = ?1
                         WHERE folder_id = ?2 AND sort_order >= ?3 AND id != ?4",
                        params![now, fid, target, id],
                    )?;
                }
                None => {
                    conn.execute(
                        "UPDATE saved_queries
                         SET sort_order = sort_order + 1, updated_at = ?1
                         WHERE folder_id IS NULL AND sort_order >= ?2 AND id != ?3",
                        params![now, target, id],
                    )?;
                }
            }
            target
        }
        None => {
            // Append: max + 1 among new siblings (excluding self).
            match &target_folder_id {
                Some(fid) => conn
                    .query_row(
                        "SELECT COALESCE(MAX(sort_order), -1) + 1
                         FROM saved_queries WHERE folder_id = ?1 AND id != ?2",
                        params![fid, id],
                        |r| r.get(0),
                    )
                    .unwrap_or(0),
                None => conn
                    .query_row(
                        "SELECT COALESCE(MAX(sort_order), -1) + 1
                         FROM saved_queries WHERE folder_id IS NULL AND id != ?1",
                        params![id],
                        |r| r.get(0),
                    )
                    .unwrap_or(0),
            }
        }
    };

    conn.execute(
        "UPDATE saved_queries SET folder_id = ?1, sort_order = ?2, updated_at = ?3 WHERE id = ?4",
        params![target_folder_id, sort_order, now, id],
    )?;

    Ok(())
}

pub fn delete(conn: &rusqlite::Connection, id: String) -> AppResult<()> {
    let affected = conn.execute(
        "DELETE FROM saved_queries WHERE id = ?1",
        params![id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("saved_query {id} not found")));
    }
    Ok(())
}

/// Duplicate a query into the same folder.
///
/// Name suffix rules:
/// - First copy → `<name> (copy)`
/// - If that already exists → `<name> (copy 2)`, `(copy 3)`, etc.
///   Uses the smallest integer N >= 2 not already taken by a sibling.
pub fn duplicate(conn: &rusqlite::Connection, id: String) -> AppResult<SavedQuery> {
    // Fetch original.
    let original = conn
        .query_row(
            "SELECT id, folder_id, name, sql, sort_order, last_connection_id, created_at, updated_at
             FROM saved_queries WHERE id = ?1",
            params![id],
            row_to_query,
        )
        .map_err(|_| AppError::NotFound(format!("saved_query {id} not found")))?;

    // Find existing sibling names that match `<original> (copy)` or
    // `<original> (copy <n>)` to determine the suffix.
    let siblings: Vec<String> = match &original.folder_id {
        Some(fid) => {
            let mut stmt = conn.prepare(
                "SELECT name FROM saved_queries WHERE folder_id = ?1",
            )?;
            let rows: Result<Vec<String>, _> =
                stmt.query_map(params![fid], |r| r.get(0))?.collect();
            rows?
        }
        None => {
            let mut stmt = conn.prepare(
                "SELECT name FROM saved_queries WHERE folder_id IS NULL",
            )?;
            let rows: Result<Vec<String>, _> =
                stmt.query_map([], |r| r.get(0))?.collect();
            rows?
        }
    };

    let base_copy = format!("{} (copy)", original.name);
    let new_name = if !siblings.iter().any(|s| s == &base_copy) {
        base_copy
    } else {
        // Find smallest N >= 2 not taken.
        let prefix = format!("{} (copy ", original.name);
        let mut used: Vec<u64> = siblings
            .iter()
            .filter_map(|s| {
                let rest = s.strip_prefix(&prefix)?.strip_suffix(')')?;
                rest.parse::<u64>().ok()
            })
            .collect();
        used.sort_unstable();
        let n = (2u64..).find(|n| !used.contains(n)).unwrap_or(2);
        format!("{} (copy {n})", original.name)
    };

    // Append sort_order among siblings.
    let sort_order: i64 = match &original.folder_id {
        Some(fid) => conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM saved_queries WHERE folder_id = ?1",
                params![fid],
                |r| r.get(0),
            )
            .unwrap_or(0),
        None => conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM saved_queries WHERE folder_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0),
    };

    let new_id = Uuid::new_v4().to_string();
    let now = now_ms();

    // Encode last_connection_id bytes for BLOB storage.
    let conn_bytes: Option<Vec<u8>> = original
        .last_connection_id
        .as_deref()
        .map(|s| parse_uuid_bytes(s, "last_connection_id"))
        .transpose()?;

    conn.execute(
        "INSERT INTO saved_queries (id, folder_id, name, sql, sort_order, last_connection_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            new_id,
            original.folder_id,
            new_name,
            original.sql,
            sort_order,
            conn_bytes,
            now,
        ],
    )?;

    conn.query_row(
        "SELECT id, folder_id, name, sql, sort_order, last_connection_id, created_at, updated_at
         FROM saved_queries WHERE id = ?1",
        params![new_id],
        row_to_query,
    )
    .map_err(AppError::from)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::storage::open_in_memory;

    // Helper: create a folder at root with default name.
    fn mk_folder(conn: &rusqlite::Connection, name: &str) -> SavedQueryFolder {
        folder_create(conn, None, name.to_string()).unwrap()
    }

    fn mk_folder_under(
        conn: &rusqlite::Connection,
        parent_id: &str,
        name: &str,
    ) -> SavedQueryFolder {
        folder_create(conn, Some(parent_id.to_string()), name.to_string()).unwrap()
    }

    fn mk_query(conn: &rusqlite::Connection, folder_id: Option<&str>, name: &str) -> SavedQuery {
        create(
            conn,
            folder_id.map(String::from),
            name.to_string(),
            "SELECT 1".to_string(),
            None,
        )
        .unwrap()
    }

    // 1. list returns empty arrays for fresh DB
    #[test]
    fn list_empty_db() {
        let conn = open_in_memory().unwrap();
        let resp = list(&conn).unwrap();
        assert!(resp.folders.is_empty());
        assert!(resp.queries.is_empty());
    }

    // 2. delete non-existent query → NotFound
    #[test]
    fn delete_not_found() {
        let conn = open_in_memory().unwrap();
        let err = delete(&conn, "nonexistent".into()).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    // 3. update non-existent query → NotFound
    #[test]
    fn update_not_found() {
        let conn = open_in_memory().unwrap();
        let req = UpdateQueryRequest {
            id: "nonexistent".into(),
            name: Some("x".into()),
            sql: None,
            last_connection_id: None,
        };
        let err = update(&conn, req).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    // 4. folder_update non-existent id → NotFound
    #[test]
    fn folder_update_not_found() {
        let conn = open_in_memory().unwrap();
        let err = folder_update(&conn, "nonexistent".into(), "x".into()).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    // 5. folder_move cycle: parent → child → grandchild → try move parent under grandchild
    #[test]
    fn folder_move_rejects_cycle() {
        let conn = open_in_memory().unwrap();
        let parent = mk_folder(&conn, "parent");
        let child = mk_folder_under(&conn, &parent.id, "child");
        let grandchild = mk_folder_under(&conn, &child.id, "grandchild");

        let err = folder_move(
            &conn,
            parent.id.clone(),
            Some(grandchild.id.clone()),
            None,
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        // Also self-move.
        let err2 = folder_move(
            &conn,
            parent.id.clone(),
            Some(parent.id.clone()),
            None,
        )
        .unwrap_err();
        assert!(matches!(err2, AppError::Validation(_)));
    }

    // 6. folder_delete with nested content: correct counts and cascade
    #[test]
    fn folder_delete_cascade_counts() {
        let conn = open_in_memory().unwrap();
        let root = mk_folder(&conn, "root");
        let sub = mk_folder_under(&conn, &root.id, "sub");
        mk_query(&conn, Some(&root.id), "q1");
        mk_query(&conn, Some(&root.id), "q2");
        mk_query(&conn, Some(&sub.id), "q3");

        let resp = folder_delete(&conn, root.id.clone()).unwrap();
        // 2 folders (root + sub), 3 queries
        assert_eq!(resp.folders_deleted, 2);
        assert_eq!(resp.queries_deleted, 3);

        // Verify nothing remains.
        let lr = list(&conn).unwrap();
        assert!(lr.folders.is_empty());
        assert!(lr.queries.is_empty());
    }

    // 7. duplicate: first → (copy), second → (copy 2), gaps handled
    #[test]
    fn duplicate_suffix_increment() {
        let conn = open_in_memory().unwrap();
        let q = mk_query(&conn, None, "Revenue");

        // First duplicate → "Revenue (copy)"
        let d1 = duplicate(&conn, q.id.clone()).unwrap();
        assert_eq!(d1.name, "Revenue (copy)");

        // Second duplicate → "Revenue (copy 2)"
        let d2 = duplicate(&conn, q.id.clone()).unwrap();
        assert_eq!(d2.name, "Revenue (copy 2)");

        // Third duplicate → "Revenue (copy 3)"
        let d3 = duplicate(&conn, q.id.clone()).unwrap();
        assert_eq!(d3.name, "Revenue (copy 3)");
    }

    // 8. duplicate: when (copy 2) and (copy 3) exist but not (copy 2) — verify
    //    gap-filling: if (copy) and (copy 3) exist but not (copy 2), next should be (copy 2)
    #[test]
    fn duplicate_fills_gap() {
        let conn = open_in_memory().unwrap();
        let q = mk_query(&conn, None, "Revenue");

        // Create "Revenue (copy)" manually.
        create(
            &conn,
            None,
            "Revenue (copy)".to_string(),
            "SELECT 1".to_string(),
            None,
        )
        .unwrap();
        // Create "Revenue (copy 3)" manually (skip 2).
        create(
            &conn,
            None,
            "Revenue (copy 3)".to_string(),
            "SELECT 1".to_string(),
            None,
        )
        .unwrap();

        // Duplicate should pick (copy 2).
        let d = duplicate(&conn, q.id.clone()).unwrap();
        assert_eq!(d.name, "Revenue (copy 2)");
    }

    // 9. move_query with target_sort_order renumbers siblings densely
    #[test]
    fn move_query_renumbers_siblings() {
        let conn = open_in_memory().unwrap();
        let folder = mk_folder(&conn, "folder");
        create(
            &conn,
            Some(folder.id.clone()),
            "A".into(),
            "SELECT 1".into(),
            None,
        )
        .unwrap();
        create(
            &conn,
            Some(folder.id.clone()),
            "B".into(),
            "SELECT 1".into(),
            None,
        )
        .unwrap();
        create(
            &conn,
            Some(folder.id.clone()),
            "C".into(),
            "SELECT 1".into(),
            None,
        )
        .unwrap();

        // Create query D at root, then move it into folder at position 1 (between A and B).
        let d = create(&conn, None, "D".into(), "SELECT 1".into(), None).unwrap();
        move_query(&conn, d.id.clone(), Some(folder.id.clone()), Some(1)).unwrap();

        // After move: A=0, D=1, B=2, C=3
        let lr = list(&conn).unwrap();
        let folder_queries: Vec<&SavedQuery> = lr
            .queries
            .iter()
            .filter(|q| q.folder_id.as_deref() == Some(&folder.id))
            .collect();

        let names: Vec<&str> = folder_queries.iter().map(|q| q.name.as_str()).collect();
        assert_eq!(names, vec!["A", "D", "B", "C"]);

        let orders: Vec<i64> = folder_queries.iter().map(|q| q.sort_order).collect();
        assert_eq!(orders, vec![0, 1, 2, 3]);
    }

    // 10. migration smoke test: tables exist after open_in_memory
    #[test]
    fn migration_creates_tables() {
        let conn = open_in_memory().unwrap();
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('saved_query_folders', 'saved_queries') ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(tables, vec!["saved_queries", "saved_query_folders"]);
    }

    // 11. explicit-null: last_connection_id = Some(None) clears the column
    #[test]
    fn update_clears_last_connection_id() {
        let conn = open_in_memory().unwrap();
        let conn_id = Uuid::new_v4().to_string();
        let q = create(
            &conn,
            None,
            "test".into(),
            "SELECT 1".into(),
            Some(conn_id.clone()),
        )
        .unwrap();
        assert_eq!(q.last_connection_id, Some(conn_id));

        // Clear via explicit null.
        let updated = update(
            &conn,
            UpdateQueryRequest {
                id: q.id.clone(),
                name: None,
                sql: None,
                last_connection_id: Some(None),
            },
        )
        .unwrap();
        assert_eq!(updated.last_connection_id, None);
    }

    // 12. explicit-null: absent last_connection_id leaves column untouched
    #[test]
    fn update_absent_last_connection_id_is_noop() {
        let conn = open_in_memory().unwrap();
        let conn_id = Uuid::new_v4().to_string();
        let q = create(
            &conn,
            None,
            "test".into(),
            "SELECT 1".into(),
            Some(conn_id.clone()),
        )
        .unwrap();

        // Update only sql, leave last_connection_id untouched.
        let updated = update(
            &conn,
            UpdateQueryRequest {
                id: q.id.clone(),
                name: None,
                sql: Some("SELECT 2".into()),
                last_connection_id: None,
            },
        )
        .unwrap();
        assert_eq!(updated.last_connection_id, Some(conn_id));
        assert_eq!(updated.sql, "SELECT 2");
    }

    // 13. folder_delete empty folder returns folders_deleted=1, queries_deleted=0
    #[test]
    fn folder_delete_empty() {
        let conn = open_in_memory().unwrap();
        let f = mk_folder(&conn, "empty");
        let resp = folder_delete(&conn, f.id).unwrap();
        assert_eq!(resp.folders_deleted, 1);
        assert_eq!(resp.queries_deleted, 0);
    }
}
