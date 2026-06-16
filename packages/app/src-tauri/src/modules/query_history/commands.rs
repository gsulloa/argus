use tauri::State;

use crate::error::AppResult;
use crate::modules::query_history::{
    self, ClearResponse, HistoryFilters, ListRequest, ListResponse,
};
use crate::platform::DbState;

#[tauri::command]
pub fn query_history_list(
    state: State<'_, DbState>,
    request: Option<ListRequest>,
) -> AppResult<ListResponse> {
    let conn = state.0.lock().expect("db poisoned");
    query_history::list_entries(&conn, request.unwrap_or_default())
}

#[tauri::command]
pub fn query_history_delete(state: State<'_, DbState>, id: String) -> AppResult<()> {
    let conn = state.0.lock().expect("db poisoned");
    query_history::delete_one(&conn, &id)
}

#[tauri::command]
pub fn query_history_clear(
    state: State<'_, DbState>,
    filters: Option<HistoryFilters>,
) -> AppResult<ClearResponse> {
    let conn = state.0.lock().expect("db poisoned");
    query_history::clear(&conn, filters.unwrap_or_default())
}

#[tauri::command]
pub fn query_history_distinct_connections(
    state: State<'_, DbState>,
) -> AppResult<Vec<DistinctConnection>> {
    let conn = state.0.lock().expect("db poisoned");
    let pairs = query_history::distinct_connections(&conn)?;
    Ok(pairs
        .into_iter()
        .map(|(id, name)| DistinctConnection {
            id: id.to_string(),
            name,
        })
        .collect())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DistinctConnection {
    pub id: String,
    pub name: String,
}
