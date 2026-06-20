//! Athena NamedQuery commands.
//!
//! Exposes `athena_list_named_queries` and `athena_get_named_query`.
//! Mirrors `schema_commands.rs` for client acquisition and error mapping.

use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::athena::errors::sdk_err_to_app;
use crate::modules::athena::pool::AthenaClientRegistry;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/// Lightweight summary returned by the listing command (no query_string).
#[derive(Debug, Clone, Serialize)]
pub struct NamedQuerySummary {
    pub named_query_id: String,
    pub name: String,
    pub description: Option<String>,
    pub database: String,
    pub work_group: String,
}

/// Full detail including query_string, returned by the get command.
#[derive(Debug, Clone, Serialize)]
pub struct NamedQueryDetail {
    pub named_query_id: String,
    pub name: String,
    pub description: Option<String>,
    pub database: String,
    pub work_group: String,
    pub query_string: String,
}

/// Identity returned by the create command (no query_string needed).
#[derive(Debug, Clone, Serialize)]
pub struct CreatedNamedQuery {
    pub named_query_id: String,
    pub work_group: String,
    pub database: String,
}

// ---------------------------------------------------------------------------
// Pure helpers (testable without AWS)
// ---------------------------------------------------------------------------

/// Split a slice of IDs into chunks of at most `size` elements.
pub fn chunk_ids(ids: &[String], size: usize) -> Vec<Vec<String>> {
    ids.chunks(size).map(|c| c.to_vec()).collect()
}

/// Sort a list of summaries by `(work_group, name)`, both case-insensitively, in place.
pub fn sort_summaries_by_workgroup_then_name(summaries: &mut [NamedQuerySummary]) {
    summaries.sort_by(|a, b| {
        let wg_cmp = a
            .work_group
            .to_lowercase()
            .cmp(&b.work_group.to_lowercase());
        if wg_cmp != std::cmp::Ordering::Equal {
            wg_cmp
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });
}

// ---------------------------------------------------------------------------
// athena_list_named_queries
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn athena_list_named_queries(
    registry: State<'_, AthenaClientRegistry>,
    id: Uuid,
) -> AppResult<Vec<NamedQuerySummary>> {
    let acquired = registry.acquire(&id).await?;
    let athena = &acquired.athena;

    // Phase 1 — paginate ListWorkGroups to collect every workgroup name.
    let mut workgroup_names: Vec<String> = Vec::new();
    let mut next_token: Option<String> = None;

    loop {
        let resp = athena
            .list_work_groups()
            .set_next_token(next_token)
            .send()
            .await
            .map_err(|e| sdk_err_to_app(&e))?;

        for wg in resp.work_groups() {
            if let Some(name) = wg.name() {
                workgroup_names.push(name.to_string());
            }
        }

        next_token = resp.next_token().map(str::to_string);
        if next_token.is_none() {
            break;
        }
    }

    // Phase 2 — for each workgroup, paginate ListNamedQueries.
    // A workgroup that returns an error is skipped (not a fatal failure).
    let mut all_ids: Vec<String> = Vec::new();

    'workgroups: for wg_name in &workgroup_names {
        let mut wg_next_token: Option<String> = None;

        loop {
            let result = athena
                .list_named_queries()
                .work_group(wg_name)
                .set_next_token(wg_next_token)
                .send()
                .await;

            match result {
                Err(_) => {
                    // This workgroup could not be enumerated (e.g. DISABLED,
                    // insufficient permissions). Skip it and continue with others.
                    continue 'workgroups;
                }
                Ok(resp) => {
                    for id_str in resp.named_query_ids() {
                        all_ids.push(id_str.to_string());
                    }
                    wg_next_token = resp.next_token().map(str::to_string);
                    if wg_next_token.is_none() {
                        break;
                    }
                }
            }
        }
    }

    if all_ids.is_empty() {
        return Ok(Vec::new());
    }

    // Phase 3 — resolve all IDs via BatchGetNamedQuery in batches of ≤ 50.
    // BatchGetNamedQuery resolves by ID account-wide; no per-workgroup repetition needed.
    let mut summaries: Vec<NamedQuerySummary> = Vec::new();
    let batches = chunk_ids(&all_ids, 50);

    for batch in batches {
        let resolved = resolve_batch(athena, batch).await?;
        summaries.extend(resolved);
    }

    sort_summaries_by_workgroup_then_name(&mut summaries);
    Ok(summaries)
}

/// Execute one BatchGetNamedQuery call; on unprocessed IDs, retry that sub-batch
/// once. Any IDs still unprocessed after the retry are silently omitted.
async fn resolve_batch(
    athena: &aws_sdk_athena::Client,
    ids: Vec<String>,
) -> AppResult<Vec<NamedQuerySummary>> {
    let resp = athena
        .batch_get_named_query()
        .set_named_query_ids(Some(ids))
        .send()
        .await
        .map_err(|e| sdk_err_to_app(&e))?;

    let mut summaries: Vec<NamedQuerySummary> = resp
        .named_queries()
        .iter()
        .map(named_query_to_summary)
        .collect();

    let unprocessed: Vec<String> = resp
        .unprocessed_named_query_ids()
        .iter()
        .filter_map(|u| u.named_query_id().map(str::to_string))
        .collect();

    if unprocessed.is_empty() {
        return Ok(summaries);
    }

    // Retry the unprocessed sub-batch once.
    let retry_resp = athena
        .batch_get_named_query()
        .set_named_query_ids(Some(unprocessed))
        .send()
        .await
        .map_err(|e| sdk_err_to_app(&e))?;

    for nq in retry_resp.named_queries() {
        summaries.push(named_query_to_summary(nq));
    }
    // Any still-unprocessed IDs after the retry are intentionally omitted.

    Ok(summaries)
}

// ---------------------------------------------------------------------------
// athena_get_named_query
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn athena_get_named_query(
    registry: State<'_, AthenaClientRegistry>,
    id: Uuid,
    named_query_id: String,
) -> AppResult<NamedQueryDetail> {
    let acquired = registry.acquire(&id).await?;
    let athena = &acquired.athena;

    let resp = athena
        .get_named_query()
        .named_query_id(&named_query_id)
        .send()
        .await
        .map_err(|e| sdk_err_to_app(&e))?;

    let nq = resp
        .named_query()
        .ok_or_else(|| AppError::NotFound(format!("named query {named_query_id} not found")))?;

    Ok(named_query_to_detail(nq))
}

// ---------------------------------------------------------------------------
// athena_create_named_query
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn athena_create_named_query(
    registry: State<'_, AthenaClientRegistry>,
    id: Uuid,
    name: String,
    query_string: String,
    database: String,
    work_group: String,
    description: Option<String>,
) -> AppResult<CreatedNamedQuery> {
    let acquired = registry.acquire(&id).await?;

    if registry.read_only_for(&id).await == Some(true) {
        return Err(AppError::Validation("connection is read-only".into()));
    }

    let athena = &acquired.athena;

    let resp = athena
        .create_named_query()
        .name(&name)
        .database(&database)
        .query_string(&query_string)
        .work_group(&work_group)
        .set_description(description)
        .send()
        .await
        .map_err(|e| sdk_err_to_app(&e))?;

    let named_query_id = resp.named_query_id().unwrap_or_default().to_string();

    Ok(CreatedNamedQuery {
        named_query_id,
        work_group,
        database,
    })
}

// ---------------------------------------------------------------------------
// athena_update_named_query
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn athena_update_named_query(
    registry: State<'_, AthenaClientRegistry>,
    id: Uuid,
    named_query_id: String,
    name: String,
    query_string: String,
    description: Option<String>,
) -> AppResult<()> {
    let acquired = registry.acquire(&id).await?;

    if registry.read_only_for(&id).await == Some(true) {
        return Err(AppError::Validation("connection is read-only".into()));
    }

    let athena = &acquired.athena;

    athena
        .update_named_query()
        .named_query_id(&named_query_id)
        .name(&name)
        .query_string(&query_string)
        .set_description(description)
        .send()
        .await
        .map_err(|e| sdk_err_to_app(&e))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// athena_delete_named_query
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn athena_delete_named_query(
    registry: State<'_, AthenaClientRegistry>,
    id: Uuid,
    named_query_id: String,
) -> AppResult<()> {
    let acquired = registry.acquire(&id).await?;

    if registry.read_only_for(&id).await == Some(true) {
        return Err(AppError::Validation("connection is read-only".into()));
    }

    let athena = &acquired.athena;

    athena
        .delete_named_query()
        .named_query_id(&named_query_id)
        .send()
        .await
        .map_err(|e| sdk_err_to_app(&e))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

fn named_query_to_summary(nq: &aws_sdk_athena::types::NamedQuery) -> NamedQuerySummary {
    NamedQuerySummary {
        named_query_id: nq.named_query_id().unwrap_or_default().to_string(),
        name: nq.name().to_string(),
        description: nq.description().map(str::to_string),
        database: nq.database().to_string(),
        work_group: nq.work_group().unwrap_or_default().to_string(),
    }
}

fn named_query_to_detail(nq: &aws_sdk_athena::types::NamedQuery) -> NamedQueryDetail {
    NamedQueryDetail {
        named_query_id: nq.named_query_id().unwrap_or_default().to_string(),
        name: nq.name().to_string(),
        description: nq.description().map(str::to_string),
        database: nq.database().to_string(),
        work_group: nq.work_group().unwrap_or_default().to_string(),
        query_string: nq.query_string().to_string(),
    }
}

// ---------------------------------------------------------------------------
// Unit tests (pure helpers only — no AWS calls)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------
    // chunk_ids
    // ------------------------------------------------------------------

    #[test]
    fn chunk_ids_empty() {
        let chunks = chunk_ids(&[], 50);
        assert!(chunks.is_empty());
    }

    #[test]
    fn chunk_ids_exactly_one_batch() {
        let ids: Vec<String> = (0..50).map(|i| format!("id-{i}")).collect();
        let chunks = chunk_ids(&ids, 50);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].len(), 50);
    }

    #[test]
    fn chunk_ids_splits_into_multiple_batches() {
        // 127 ids → 3 chunks: 50, 50, 27
        let ids: Vec<String> = (0..127).map(|i| format!("id-{i}")).collect();
        let chunks = chunk_ids(&ids, 50);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].len(), 50);
        assert_eq!(chunks[1].len(), 50);
        assert_eq!(chunks[2].len(), 27);
    }

    #[test]
    fn chunk_ids_fewer_than_batch_size() {
        let ids: Vec<String> = (0..10).map(|i| format!("id-{i}")).collect();
        let chunks = chunk_ids(&ids, 50);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].len(), 10);
    }

    #[test]
    fn chunk_ids_preserves_values() {
        let ids = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let chunks = chunk_ids(&ids, 2);
        assert_eq!(chunks[0], vec!["a", "b"]);
        assert_eq!(chunks[1], vec!["c"]);
    }

    // ------------------------------------------------------------------
    // sort_summaries_by_workgroup_then_name
    // ------------------------------------------------------------------

    fn make_summary(work_group: &str, name: &str) -> NamedQuerySummary {
        NamedQuerySummary {
            named_query_id: "id".to_string(),
            name: name.to_string(),
            description: None,
            database: "db".to_string(),
            work_group: work_group.to_string(),
        }
    }

    #[test]
    fn sort_summaries_empty() {
        let mut v: Vec<NamedQuerySummary> = Vec::new();
        sort_summaries_by_workgroup_then_name(&mut v);
        assert!(v.is_empty());
    }

    #[test]
    fn sort_summaries_already_sorted() {
        let mut v = vec![
            make_summary("primary", "alpha"),
            make_summary("primary", "beta"),
            make_summary("primary", "gamma"),
        ];
        sort_summaries_by_workgroup_then_name(&mut v);
        assert_eq!(v[0].name, "alpha");
        assert_eq!(v[1].name, "beta");
        assert_eq!(v[2].name, "gamma");
    }

    #[test]
    fn sort_summaries_reverse_order() {
        let mut v = vec![
            make_summary("primary", "zebra"),
            make_summary("primary", "mango"),
            make_summary("primary", "apple"),
        ];
        sort_summaries_by_workgroup_then_name(&mut v);
        assert_eq!(v[0].name, "apple");
        assert_eq!(v[1].name, "mango");
        assert_eq!(v[2].name, "zebra");
    }

    #[test]
    fn sort_summaries_case_insensitive() {
        // "Beta" should sort between "alpha" and "gamma", not after "gamma"
        let mut v = vec![
            make_summary("primary", "gamma"),
            make_summary("primary", "Beta"),
            make_summary("primary", "alpha"),
        ];
        sort_summaries_by_workgroup_then_name(&mut v);
        assert_eq!(v[0].name, "alpha");
        assert_eq!(v[1].name, "Beta");
        assert_eq!(v[2].name, "gamma");
    }

    #[test]
    fn sort_summaries_mixed_case() {
        let mut v = vec![
            make_summary("primary", "ZEBRA"),
            make_summary("primary", "apple"),
            make_summary("primary", "Mango"),
        ];
        sort_summaries_by_workgroup_then_name(&mut v);
        assert_eq!(v[0].name, "apple");
        assert_eq!(v[1].name, "Mango");
        assert_eq!(v[2].name, "ZEBRA");
    }

    #[test]
    fn sort_summaries_multiple_workgroups_grouped_and_ordered() {
        // Entries from "primary" and "analytics" workgroups mixed together.
        // Expected order: analytics entries first (a < p), within each workgroup by name.
        let mut v = vec![
            make_summary("primary", "zebra-query"),
            make_summary("analytics", "visits-per-day"),
            make_summary("primary", "alpha-query"),
            make_summary("analytics", "downloads-by-platform"),
        ];
        sort_summaries_by_workgroup_then_name(&mut v);

        // analytics workgroup comes before primary (a < p)
        assert_eq!(v[0].work_group, "analytics");
        assert_eq!(v[0].name, "downloads-by-platform");

        assert_eq!(v[1].work_group, "analytics");
        assert_eq!(v[1].name, "visits-per-day");

        assert_eq!(v[2].work_group, "primary");
        assert_eq!(v[2].name, "alpha-query");

        assert_eq!(v[3].work_group, "primary");
        assert_eq!(v[3].name, "zebra-query");
    }

    #[test]
    fn sort_summaries_workgroup_order_is_case_insensitive() {
        // "Analytics" (capital A) should still sort before "primary"
        let mut v = vec![
            make_summary("primary", "query-b"),
            make_summary("Analytics", "query-a"),
        ];
        sort_summaries_by_workgroup_then_name(&mut v);

        assert_eq!(v[0].work_group, "Analytics");
        assert_eq!(v[0].name, "query-a");

        assert_eq!(v[1].work_group, "primary");
        assert_eq!(v[1].name, "query-b");
    }
}
