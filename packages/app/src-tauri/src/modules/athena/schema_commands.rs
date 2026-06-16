//! Athena schema browser commands (via Glue).

use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::athena::errors::sdk_err_to_app;
use crate::modules::athena::pool::AthenaClientRegistry;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct DatabaseInfo {
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RelationInfo {
    pub name: String,
    pub kind: String, // "table" | "view"
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnEntry {
    pub name: String,
    pub ty: String,
}

// ---------------------------------------------------------------------------
// athena_list_databases
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn athena_list_databases(
    registry: State<'_, AthenaClientRegistry>,
    id: Uuid,
) -> AppResult<Vec<DatabaseInfo>> {
    let acquired = registry.acquire(&id).await?;
    let glue = &acquired.glue;

    let mut databases: Vec<DatabaseInfo> = Vec::new();
    let mut next_token: Option<String> = None;

    loop {
        let resp = glue
            .get_databases()
            .set_next_token(next_token)
            .send()
            .await
            .map_err(|e| sdk_err_to_app(&e))?;

        for db in resp.database_list() {
            databases.push(DatabaseInfo { name: db.name().to_string() });
        }

        next_token = resp.next_token().map(str::to_string);
        if next_token.is_none() {
            break;
        }
    }

    Ok(databases)
}

// ---------------------------------------------------------------------------
// athena_list_relations
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn athena_list_relations(
    registry: State<'_, AthenaClientRegistry>,
    id: Uuid,
    database: String,
) -> AppResult<Vec<RelationInfo>> {
    let acquired = registry.acquire(&id).await?;
    let glue = &acquired.glue;

    let mut relations: Vec<RelationInfo> = Vec::new();
    let mut next_token: Option<String> = None;

    loop {
        let resp = glue
            .get_tables()
            .database_name(&database)
            .set_next_token(next_token)
            .send()
            .await
            .map_err(|e| sdk_err_to_app(&e))?;

        for table in resp.table_list() {
            let kind = if table.table_type() == Some("VIRTUAL_VIEW") {
                "view".to_string()
            } else {
                "table".to_string()
            };
            relations.push(RelationInfo {
                name: table.name().to_string(),
                kind,
            });
        }

        next_token = resp.next_token().map(str::to_string);
        if next_token.is_none() {
            break;
        }
    }

    Ok(relations)
}

// ---------------------------------------------------------------------------
// athena_list_columns
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn athena_list_columns(
    registry: State<'_, AthenaClientRegistry>,
    id: Uuid,
    database: String,
    relation: String,
) -> AppResult<Vec<ColumnEntry>> {
    let acquired = registry.acquire(&id).await?;
    let glue = &acquired.glue;

    let resp = glue
        .get_table()
        .database_name(&database)
        .name(&relation)
        .send()
        .await
        .map_err(|e| sdk_err_to_app(&e))?;

    let table_def = resp
        .table
        .ok_or_else(|| AppError::NotFound(format!("table {database}.{relation} not found")))?;

    let mut columns: Vec<ColumnEntry> = Vec::new();

    // StorageDescriptor columns first.
    if let Some(sd) = table_def.storage_descriptor() {
        for col in sd.columns() {
            columns.push(ColumnEntry {
                name: col.name().to_string(),
                ty: col.r#type().unwrap_or_default().to_string(),
            });
        }
    }

    // Partition keys after storage descriptor columns.
    for key in table_def.partition_keys() {
        columns.push(ColumnEntry {
            name: key.name().to_string(),
            ty: key.r#type().unwrap_or_default().to_string(),
        });
    }

    Ok(columns)
}

// ---------------------------------------------------------------------------
// Helper used by the introspector (no Tauri command annotation)
// ---------------------------------------------------------------------------

/// Fetch columns for a Glue table, returning (storage_cols + partition_keys).
/// Used by `AthenaIntrospector`.
pub async fn fetch_table_columns(
    glue: &aws_sdk_glue::Client,
    database: &str,
    table: &str,
) -> AppResult<Vec<ColumnEntry>> {
    let resp = glue
        .get_table()
        .database_name(database)
        .name(table)
        .send()
        .await
        .map_err(|e| sdk_err_to_app(&e))?;

    let table_def = match resp.table {
        Some(t) => t,
        None => return Ok(vec![]),
    };

    let mut columns: Vec<ColumnEntry> = Vec::new();

    if let Some(sd) = table_def.storage_descriptor() {
        for col in sd.columns() {
            columns.push(ColumnEntry {
                name: col.name().to_string(),
                ty: col.r#type().unwrap_or_default().to_string(),
            });
        }
    }

    for key in table_def.partition_keys() {
        columns.push(ColumnEntry {
            name: key.name().to_string(),
            ty: key.r#type().unwrap_or_default().to_string(),
        });
    }

    Ok(columns)
}
