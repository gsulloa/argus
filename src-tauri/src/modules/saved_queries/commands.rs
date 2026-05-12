use tauri::State;

use crate::error::AppResult;
use crate::modules::saved_queries::{
    self, FolderDeleteResponse, ListResponse, SavedQuery, SavedQueryFolder, UpdateQueryRequest,
};
use crate::platform::DbState;

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn saved_queries_list(state: State<'_, DbState>) -> AppResult<ListResponse> {
    let conn = state.0.lock().expect("db poisoned");
    saved_queries::list(&conn)
}

// ---------------------------------------------------------------------------
// Folder commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn saved_queries_folder_create(
    state: State<'_, DbState>,
    parent_id: Option<String>,
    name: String,
) -> AppResult<SavedQueryFolder> {
    let conn = state.0.lock().expect("db poisoned");
    saved_queries::folder_create(&conn, parent_id, name)
}

#[tauri::command]
pub fn saved_queries_folder_update(
    state: State<'_, DbState>,
    id: String,
    name: String,
) -> AppResult<SavedQueryFolder> {
    let conn = state.0.lock().expect("db poisoned");
    saved_queries::folder_update(&conn, id, name)
}

#[tauri::command]
pub fn saved_queries_folder_move(
    state: State<'_, DbState>,
    id: String,
    target_parent_id: Option<String>,
    target_sort_order: Option<i64>,
) -> AppResult<()> {
    let conn = state.0.lock().expect("db poisoned");
    saved_queries::folder_move(&conn, id, target_parent_id, target_sort_order)
}

#[tauri::command]
pub fn saved_queries_folder_delete(
    state: State<'_, DbState>,
    id: String,
) -> AppResult<FolderDeleteResponse> {
    let conn = state.0.lock().expect("db poisoned");
    saved_queries::folder_delete(&conn, id)
}

// ---------------------------------------------------------------------------
// Query commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn saved_queries_create(
    state: State<'_, DbState>,
    folder_id: Option<String>,
    name: String,
    sql: String,
    last_connection_id: Option<String>,
) -> AppResult<SavedQuery> {
    let conn = state.0.lock().expect("db poisoned");
    saved_queries::create(&conn, folder_id, name, sql, last_connection_id)
}

#[tauri::command]
pub fn saved_queries_update(
    state: State<'_, DbState>,
    request: UpdateQueryRequest,
) -> AppResult<SavedQuery> {
    let conn = state.0.lock().expect("db poisoned");
    saved_queries::update(&conn, request)
}

#[tauri::command]
pub fn saved_queries_move(
    state: State<'_, DbState>,
    id: String,
    target_folder_id: Option<String>,
    target_sort_order: Option<i64>,
) -> AppResult<()> {
    let conn = state.0.lock().expect("db poisoned");
    saved_queries::move_query(&conn, id, target_folder_id, target_sort_order)
}

#[tauri::command]
pub fn saved_queries_delete(state: State<'_, DbState>, id: String) -> AppResult<()> {
    let conn = state.0.lock().expect("db poisoned");
    saved_queries::delete(&conn, id)
}

#[tauri::command]
pub fn saved_queries_duplicate(state: State<'_, DbState>, id: String) -> AppResult<SavedQuery> {
    let conn = state.0.lock().expect("db poisoned");
    saved_queries::duplicate(&conn, id)
}
