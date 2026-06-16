use aws_sdk_dynamodb::Client as DynamoClient;

use crate::error::{AppError, AppResult};
use crate::modules::dynamo::tables::types::ListTablesResult;

// ---------------------------------------------------------------------------
// Pager — abstracts the AWS ListTables loop for testability
// ---------------------------------------------------------------------------

/// Abstraction over a single ListTables page fetch.
/// Takes the optional `exclusive_start_table_name` for this page.
/// Returns `(table_names, last_evaluated_table_name)`.
///
/// The production implementation uses the real SDK client; tests provide a
/// closure-backed mock via `MockPageProvider`.
#[async_trait::async_trait]
pub trait PageProvider: Send + Sync {
    async fn fetch_page(
        &self,
        exclusive_start: Option<&str>,
    ) -> AppResult<(Vec<String>, Option<String>)>;
}

// ---------------------------------------------------------------------------
// Real SDK implementation
// ---------------------------------------------------------------------------

pub struct DynamoPageProvider {
    pub client: DynamoClient,
}

#[async_trait::async_trait]
impl PageProvider for DynamoPageProvider {
    async fn fetch_page(
        &self,
        exclusive_start: Option<&str>,
    ) -> AppResult<(Vec<String>, Option<String>)> {
        let mut req = self.client.list_tables().limit(100);
        if let Some(token) = exclusive_start {
            req = req.exclusive_start_table_name(token);
        }
        let resp = req.send().await.map_err(|e| {
            use aws_sdk_dynamodb::error::ProvideErrorMetadata;
            let code = e.meta().code().unwrap_or("Unknown").to_string();
            let message = e
                .meta()
                .message()
                .map(String::from)
                .unwrap_or_else(|| format!("{e:?}"));
            AppError::aws(code, message, false)
        })?;
        let names = resp.table_names().to_vec();
        let next = resp.last_evaluated_table_name().map(String::from);
        Ok((names, next))
    }
}

// ---------------------------------------------------------------------------
// Core pager logic
// ---------------------------------------------------------------------------

/// Page through all ListTables responses, stopping at `cap`.
///
/// - `pagination_token` is passed as `ExclusiveStartTableName` for the first request.
/// - Concatenates names across pages until `cap` is reached or AWS reports no more.
/// - If `cap` is reached while AWS still has more, `truncated = true` and
///   `next_token` is set to the last seen `LastEvaluatedTableName`.
pub async fn run_pager(
    provider: &dyn PageProvider,
    pagination_token: Option<&str>,
    cap: u32,
) -> AppResult<ListTablesResult> {
    let cap = cap as usize;
    let mut tables: Vec<String> = Vec::new();
    let mut cursor: Option<String> = pagination_token.map(String::from);
    let mut is_first = true;

    loop {
        let exclusive_start: Option<&str> = if is_first {
            // first call: use the caller-supplied pagination_token (may be None)
            pagination_token
        } else {
            // subsequent calls: use the cursor from the previous page
            cursor.as_deref()
        };
        is_first = false;

        let (page_names, last_evaluated) = provider.fetch_page(exclusive_start).await?;

        let remaining = cap.saturating_sub(tables.len());
        if page_names.len() >= remaining {
            // This page fills (or over-fills) our remaining headroom.
            tables.extend(page_names.into_iter().take(remaining));
            if let Some(token) = last_evaluated {
                // AWS still has more — we're truncating.
                return Ok(ListTablesResult {
                    tables,
                    next_token: Some(token),
                    truncated: true,
                });
            } else {
                // Exactly at cap with no more pages.
                return Ok(ListTablesResult {
                    tables,
                    next_token: None,
                    truncated: false,
                });
            }
        }

        // Page fits entirely within headroom.
        tables.extend(page_names);
        cursor = last_evaluated;

        if cursor.is_none() {
            // AWS has no more pages; we're done.
            return Ok(ListTablesResult {
                tables,
                next_token: None,
                truncated: false,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Unit tests — driven by a mock PageProvider
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A mock PageProvider backed by a predefined sequence of pages.
    /// Each element is `(names, last_evaluated_table_name)`.
    struct MockPageProvider {
        pages: Arc<Mutex<Vec<(Vec<String>, Option<String>)>>>,
        /// Records the exclusive_start values passed to each call.
        calls: Arc<Mutex<Vec<Option<String>>>>,
    }

    impl MockPageProvider {
        fn new(pages: Vec<(Vec<String>, Option<String>)>) -> Self {
            Self {
                pages: Arc::new(Mutex::new(pages)),
                calls: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn calls_made(&self) -> Vec<Option<String>> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait::async_trait]
    impl PageProvider for MockPageProvider {
        async fn fetch_page(
            &self,
            exclusive_start: Option<&str>,
        ) -> AppResult<(Vec<String>, Option<String>)> {
            self.calls
                .lock()
                .unwrap()
                .push(exclusive_start.map(String::from));
            let mut guard = self.pages.lock().unwrap();
            if guard.is_empty() {
                return Err(AppError::aws("TestError", "no more pages in mock", false));
            }
            Ok(guard.remove(0))
        }
    }

    // Helper to build a list of table name strings.
    fn names(prefix: &str, count: usize) -> Vec<String> {
        (0..count).map(|i| format!("{prefix}-{i:03}")).collect()
    }

    // -----------------------------------------------------------------------
    // Test 1: Single page under cap returns all names, no truncation.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn single_page_under_cap() {
        let page_names = names("tbl", 42);
        let provider = MockPageProvider::new(vec![(page_names.clone(), None)]);

        let result = run_pager(&provider, None, 1000).await.unwrap();

        assert_eq!(result.tables, page_names);
        assert!(!result.truncated);
        assert!(result.next_token.is_none());
        assert_eq!(provider.calls_made(), vec![None]);
    }

    // -----------------------------------------------------------------------
    // Test 2: Multi-page (100 + 100 + 50) under cap → 250 names, no truncation.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn multi_page_under_cap() {
        let p1 = names("tbl", 100);
        let p2 = names("p2", 100);
        let p3 = names("p3", 50);

        let provider = MockPageProvider::new(vec![
            (p1.clone(), Some("tbl-099".into())),
            (p2.clone(), Some("p2-099".into())),
            (p3.clone(), None),
        ]);

        let result = run_pager(&provider, None, 1000).await.unwrap();

        let mut expected = p1.clone();
        expected.extend(p2.clone());
        expected.extend(p3.clone());

        assert_eq!(result.tables, expected);
        assert!(!result.truncated);
        assert!(result.next_token.is_none());
        // Three pages fetched.
        assert_eq!(provider.calls_made().len(), 3);
    }

    // -----------------------------------------------------------------------
    // Test 3: Cap reached with AWS still having more → truncated=true, next_token set.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn cap_reached_truncated() {
        // 10 pages of 100 names each, cap=1000 → we take the first 1000 and stop.
        // The 10th page returns a last_evaluated_table_name, indicating more.
        let pages: Vec<(Vec<String>, Option<String>)> = (0..10)
            .map(|i| {
                let ns = names(&format!("page{i}"), 100);
                let last_name = ns.last().cloned().map(|n| n);
                let next = if i < 9 {
                    // pages 0-8 have a continuation token
                    Some(format!("page{}-token", i))
                } else {
                    // page 9 also has a token (AWS still has page 10)
                    Some("page9-token".into())
                };
                (ns, next)
            })
            .collect();

        let provider = MockPageProvider::new(pages);
        let result = run_pager(&provider, None, 1000).await.unwrap();

        assert_eq!(result.tables.len(), 1000);
        assert!(result.truncated);
        assert!(result.next_token.is_some());
    }

    // -----------------------------------------------------------------------
    // Test 4: Resume from pagination_token passes it as first ExclusiveStartTableName.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn resume_from_pagination_token() {
        let provider = MockPageProvider::new(vec![(names("tbl", 10), None)]);

        let result = run_pager(&provider, Some("tbl-999"), 1000).await.unwrap();

        assert_eq!(result.tables.len(), 10);
        let calls = provider.calls_made();
        assert_eq!(calls[0], Some("tbl-999".into()));
    }

    // -----------------------------------------------------------------------
    // Test 5: Per-call cap of 50 with 100 available → 50 names, truncated.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn per_call_cap_limits_results() {
        // One page of 100 names with a continuation token.
        let provider = MockPageProvider::new(vec![(names("tbl", 100), Some("tok-100".into()))]);

        let result = run_pager(&provider, None, 50).await.unwrap();

        assert_eq!(result.tables.len(), 50);
        assert!(result.truncated);
        assert_eq!(result.next_token.as_deref(), Some("tok-100"));
    }

    // -----------------------------------------------------------------------
    // Test 6: Exactly cap-many names with no continuation → not truncated.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn exactly_cap_no_more_not_truncated() {
        let provider = MockPageProvider::new(vec![(names("tbl", 10), None)]);
        let result = run_pager(&provider, None, 10).await.unwrap();
        assert_eq!(result.tables.len(), 10);
        assert!(!result.truncated);
        assert!(result.next_token.is_none());
    }
}
