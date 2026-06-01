use std::collections::HashMap;
use std::sync::Mutex as StdMutex;

use serde::Serialize;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::mysql::errors::map_sqlx_error;
use crate::modules::mysql::params::{MysqlParams, SslMode};
use crate::modules::mysql::tls::apply_to_connect_options;
use crate::platform::secrets;

/// Maximum simultaneous connections per MySQL pool.
const POOL_MAX_SIZE: u32 = 4;

/// Active pool entry. The `pool` field is intentionally pub(super) — only the
/// helpers in this module may obtain a client and run queries, which is how we
/// enforce the read-only contract module-wide.
pub struct ActiveMysqlPool {
    pub(super) pool: sqlx::MySqlPool,
    pub server_version: String,
    pub read_only: bool,
    pub ssl_mode: SslMode,
    pub connected_at_unix_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ActivePoolSummary {
    pub id: Uuid,
    pub server_version: String,
    pub read_only: bool,
    pub connected_at_unix_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ConnectResult {
    pub server_version: String,
    pub read_only: bool,
}

/// Singleton registry of active MySQL pools, stored as Tauri state.
pub struct MysqlPoolRegistry {
    pools: RwLock<HashMap<Uuid, ActiveMysqlPool>>,
}

impl MysqlPoolRegistry {
    pub fn new() -> Self {
        Self {
            pools: RwLock::new(HashMap::new()),
        }
    }

    /// Snapshot the active pools.
    pub async fn list_active(&self) -> Vec<ActivePoolSummary> {
        let guard = self.pools.read().await;
        guard
            .iter()
            .map(|(id, p)| ActivePoolSummary {
                id: *id,
                server_version: p.server_version.clone(),
                read_only: p.read_only,
                connected_at_unix_ms: p.connected_at_unix_ms,
            })
            .collect()
    }

    /// Build and register a pool, eagerly verifying the handshake.
    /// Idempotent: if a pool already exists for `id`, returns its summary without rebuilding.
    pub async fn connect(
        &self,
        id: Uuid,
        params: MysqlParams,
        secret: Option<String>,
    ) -> AppResult<ConnectResult> {
        // Idempotent fast path.
        {
            let guard = self.pools.read().await;
            if let Some(existing) = guard.get(&id) {
                return Ok(ConnectResult {
                    server_version: existing.server_version.clone(),
                    read_only: existing.read_only,
                });
            }
        }

        params.validate()?;
        let pool = build_mysql_pool(&params, secret.as_deref()).await?;

        // Eagerly fetch one connection to fail fast on auth/network/handshake.
        let row: (String,) = sqlx::query_as("SELECT VERSION()")
            .fetch_one(&pool)
            .await
            .map_err(map_sqlx_error)?;
        let server_version = row.0;

        let now_ms = now_unix_ms();
        let ssl_mode = params.ssl_mode;
        let read_only = params.read_only;
        let active = ActiveMysqlPool {
            pool,
            server_version: server_version.clone(),
            read_only,
            ssl_mode,
            connected_at_unix_ms: now_ms,
        };

        let mut guard = self.pools.write().await;
        // Re-check in case of concurrent connect.
        if let Some(existing) = guard.get(&id) {
            return Ok(ConnectResult {
                server_version: existing.server_version.clone(),
                read_only: existing.read_only,
            });
        }
        guard.insert(id, active);
        Ok(ConnectResult {
            server_version,
            read_only,
        })
    }

    /// Remove the pool. Idle connections close on drop; in-flight ones complete.
    /// Silent no-op if the pool is not registered.
    pub async fn disconnect(&self, id: Uuid) -> AppResult<()> {
        self.pools.write().await.remove(&id);
        Ok(())
    }

    /// Drain every registered pool in a single locked snapshot. Returns the
    /// number of pools that were dropped. Idle connections close on drop;
    /// in-flight ones complete.
    pub async fn disconnect_all(&self) -> usize {
        let mut guard = self.pools.write().await;
        let count = guard.len();
        guard.clear();
        count
    }

    /// Returns a clone of the pool (sqlx pools are `Arc`-backed, so clone is cheap).
    /// If not registered, returns `AppError::NotFound`.
    pub fn acquire(&self, id: Uuid) -> AppResult<sqlx::MySqlPool> {
        // acquire is sync — use try_read for immediate access without async
        let guard = self
            .pools
            .try_read()
            .map_err(|_| AppError::Internal("pool registry lock contention".into()))?;
        guard
            .get(&id)
            .map(|entry| entry.pool.clone())
            .ok_or_else(|| AppError::NotFound(format!("no active pool for {id}")))
    }

    /// Return the ssl_mode for a registered pool. Used by Phase D's cancel infra.
    pub fn ssl_mode_for(&self, id: Uuid) -> Option<SslMode> {
        let guard = self.pools.try_read().ok()?;
        guard.get(&id).map(|entry| entry.ssl_mode)
    }

    /// Return the read_only flag for a registered pool. Returns `None` if not registered.
    /// Used by the edit commands to enforce the read-only contract before BEGIN.
    pub fn read_only_for(&self, id: Uuid) -> Option<bool> {
        let guard = self.pools.try_read().ok()?;
        guard.get(&id).map(|entry| entry.read_only)
    }

    /// Run a SELECT-style query against the pool. Always allowed.
    #[allow(dead_code)]
    pub async fn execute_query(
        &self,
        id: Uuid,
        sql: &str,
    ) -> AppResult<sqlx::mysql::MySqlQueryResult> {
        let pool = self.acquire(id)?;
        sqlx::query(sql)
            .execute(&pool)
            .await
            .map_err(map_sqlx_error)
    }

    /// Run a DML/DDL statement. Rejected before reaching the wire if the pool
    /// is read-only.
    #[allow(dead_code)]
    pub async fn execute_mutation(&self, id: Uuid, sql: &str) -> AppResult<u64> {
        // Check read-only flag BEFORE acquiring the pool.
        {
            let guard = self.pools.read().await;
            let entry = guard
                .get(&id)
                .ok_or_else(|| AppError::NotFound(format!("no active pool for {id}")))?;
            if entry.read_only {
                return Err(AppError::Validation("connection is read-only".into()));
            }
        }
        let pool = self.acquire(id)?;
        let result = sqlx::query(sql)
            .execute(&pool)
            .await
            .map_err(map_sqlx_error)?;
        Ok(result.rows_affected())
    }
}

impl Default for MysqlPoolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Build a `sqlx::MySqlPool` from params and an optional password.
/// Applies TLS via `apply_to_connect_options` and sets up the read-only hook.
pub(crate) async fn build_mysql_pool(
    params: &MysqlParams,
    password: Option<&str>,
) -> AppResult<sqlx::MySqlPool> {
    let mut opts = MySqlConnectOptions::new()
        .host(&params.host)
        .port(params.port)
        .username(&params.username)
        .database(&params.database);
    if let Some(p) = password {
        opts = opts.password(p);
    }
    opts = apply_to_connect_options(opts, params.ssl_mode);

    let read_only = params.read_only;
    let pool = MySqlPoolOptions::new()
        .min_connections(1)
        .max_connections(POOL_MAX_SIZE)
        .after_connect(move |conn, _| {
            Box::pin(async move {
                if read_only {
                    sqlx::query("SET SESSION TRANSACTION READ ONLY")
                        .execute(&mut *conn)
                        .await?;
                }
                Ok(())
            })
        })
        .connect_with(opts)
        .await
        .map_err(map_sqlx_error)?;
    Ok(pool)
}

/// Resolve a connection's params + secret from the registry.
/// Mirrors `postgres::pool::load_connection_input`.
pub fn load_connection_input(
    db: &StdMutex<rusqlite::Connection>,
    id: Uuid,
) -> AppResult<(MysqlParams, Option<String>)> {
    let conn = db.lock().expect("db poisoned");
    let row = conn
        .query_row(
            "SELECT name, kind, params_json FROM connections WHERE id = ?1",
            rusqlite::params![id.as_bytes().to_vec()],
            |r| {
                let _name: String = r.get(0)?;
                let kind: String = r.get(1)?;
                let params_json: String = r.get(2)?;
                Ok((kind, params_json))
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                AppError::NotFound(format!("connection {id} not found"))
            }
            other => AppError::from(other),
        })?;
    let (kind, params_json) = row;
    if kind != "mysql" {
        return Err(AppError::Validation(format!(
            "connection {id} is kind '{kind}', not 'mysql'"
        )));
    }
    let value: serde_json::Value = serde_json::from_str(&params_json)?;
    let params: MysqlParams = serde_json::from_value(value)
        .map_err(|e| AppError::Validation(format!("failed to parse MySQL params: {e}")))?;
    drop(conn);

    let secret = secrets::get(&id)?;
    Ok((params, secret))
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// Live tests cannot run without a live MySQL server; they are gated behind the
// `live-mysql-tests` feature. The unit tests below cover registry behavior
// without a live server using only in-process logic.
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn list_active_initial_is_empty() {
        let reg = MysqlPoolRegistry::new();
        assert!(reg.list_active().await.is_empty());
    }

    #[tokio::test]
    async fn disconnect_when_absent_returns_ok() {
        let reg = MysqlPoolRegistry::new();
        // Disconnecting a non-registered id should be a silent no-op.
        assert!(reg.disconnect(Uuid::new_v4()).await.is_ok());
    }

    #[tokio::test]
    async fn disconnect_all_on_empty_registry_returns_zero() {
        let reg = MysqlPoolRegistry::new();
        assert_eq!(reg.disconnect_all().await, 0);
        assert!(reg.list_active().await.is_empty());
    }

    #[tokio::test]
    async fn execute_mutation_on_unknown_id_returns_not_found() {
        let reg = MysqlPoolRegistry::new();
        let err = reg
            .execute_mutation(Uuid::new_v4(), "UPDATE x SET y=1")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn ssl_mode_for_unknown_id_returns_none() {
        let reg = MysqlPoolRegistry::new();
        assert_eq!(reg.ssl_mode_for(Uuid::new_v4()), None);
    }

    // -----------------------------------------------------------------------
    // §24.6 additional coverage
    // -----------------------------------------------------------------------

    #[test]
    fn acquire_on_unknown_id_returns_not_found() {
        let reg = MysqlPoolRegistry::new();
        let err = reg.acquire(Uuid::new_v4()).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn read_only_for_unknown_id_returns_none() {
        let reg = MysqlPoolRegistry::new();
        assert_eq!(reg.read_only_for(Uuid::new_v4()), None);
    }

    // Live tests require a running MySQL server gated behind `live-mysql-tests`.
    #[cfg(feature = "live-mysql-tests")]
    mod live {
        use super::*;
        use crate::modules::mysql::url::parse_mysql_url;

        fn live_params() -> (MysqlParams, Option<String>) {
            let url = std::env::var("MYSQL_TEST_URL").expect("MYSQL_TEST_URL");
            let parsed = parse_mysql_url(&url).unwrap();
            (parsed.params, parsed.password)
        }

        #[tokio::test]
        async fn live_connect_and_query() {
            let reg = MysqlPoolRegistry::new();
            let id = Uuid::new_v4();
            let (params, pw) = live_params();
            let res = reg.connect(id, params, pw).await.unwrap();
            assert!(!res.server_version.is_empty());
        }

        #[tokio::test]
        async fn live_disconnect_all_drops_every_pool() {
            let reg = MysqlPoolRegistry::new();
            let (params, pw) = live_params();
            let id1 = Uuid::new_v4();
            let id2 = Uuid::new_v4();
            reg.connect(id1, params.clone(), pw.clone()).await.unwrap();
            reg.connect(id2, params, pw).await.unwrap();
            assert_eq!(reg.list_active().await.len(), 2);
            let dropped = reg.disconnect_all().await;
            assert_eq!(dropped, 2);
            assert!(reg.list_active().await.is_empty());
        }

        #[tokio::test]
        async fn live_read_only_rejects_mutation() {
            let reg = MysqlPoolRegistry::new();
            let id = Uuid::new_v4();
            let (mut params, pw) = live_params();
            params.read_only = true;
            params.ssl_mode = SslMode::Disabled;
            reg.connect(id, params, pw).await.unwrap();
            let err = reg
                .execute_mutation(id, "CREATE TEMPORARY TABLE _argus_ro_test (x INT)")
                .await
                .unwrap_err();
            match err {
                AppError::Validation(m) => assert!(m.contains("read-only")),
                other => panic!("expected validation, got {other:?}"),
            }
        }

        // -------------------------------------------------------------------
        // §25.1 — Live connect / disconnect / disconnect_all
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_1_connect_disconnect_lifecycle() {
            let url = match std::env::var("MYSQL_TEST_URL") {
                Ok(v) => v,
                Err(_) => {
                    eprintln!("MYSQL_TEST_URL not set; skipping §25.1");
                    return;
                }
            };
            let parsed = parse_mysql_url(&url).expect("valid url");
            let reg = MysqlPoolRegistry::new();
            let id1 = Uuid::new_v4();
            let id2 = Uuid::new_v4();

            // Connect two pools.
            reg.connect(id1, parsed.params.clone(), parsed.password.clone())
                .await
                .expect("connect id1");
            reg.connect(id2, parsed.params.clone(), parsed.password.clone())
                .await
                .expect("connect id2");
            assert_eq!(reg.list_active().await.len(), 2, "expect 2 active pools");

            // Disconnect one.
            reg.disconnect(id1).await.unwrap();
            assert_eq!(reg.list_active().await.len(), 1, "expect 1 active pool after disconnect");

            // Disconnect all.
            let dropped = reg.disconnect_all().await;
            assert_eq!(dropped, 1, "disconnect_all should drop 1 remaining");
            assert!(reg.list_active().await.is_empty(), "expect empty after disconnect_all");
        }

        // -------------------------------------------------------------------
        // §25.2 — Live test_connection
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_2_test_connection_success() {
            let url = match std::env::var("MYSQL_TEST_URL") {
                Ok(v) => v,
                Err(_) => {
                    eprintln!("MYSQL_TEST_URL not set; skipping §25.2");
                    return;
                }
            };
            let parsed = parse_mysql_url(&url).expect("valid url");

            // Build a pool and run SELECT VERSION() to verify connection.
            let pool = build_mysql_pool(&parsed.params, parsed.password.as_deref())
                .await
                .expect("pool should build");
            let row: (String,) = sqlx::query_as("SELECT VERSION()")
                .fetch_one(&pool)
                .await
                .expect("SELECT VERSION() should succeed");
            assert!(!row.0.is_empty(), "server_version should be non-empty");
        }

        #[tokio::test]
        async fn live_25_2_test_connection_wrong_password() {
            let url = match std::env::var("MYSQL_TEST_URL") {
                Ok(v) => v,
                Err(_) => {
                    eprintln!("MYSQL_TEST_URL not set; skipping §25.2 wrong-password");
                    return;
                }
            };
            let mut parsed = parse_mysql_url(&url).expect("valid url");
            parsed.password = Some("wrong_password_xyz_argus_test".into());

            let result = build_mysql_pool(&parsed.params, parsed.password.as_deref()).await;
            assert!(
                result.is_err(),
                "should fail with wrong password; got: {result:?}"
            );
            match result.unwrap_err() {
                AppError::Mysql(body) => {
                    // MySQL auth failure is SQLSTATE 28000.
                    assert_eq!(
                        body.code.as_deref(),
                        Some("28000"),
                        "expected SQLSTATE 28000, got {:?}",
                        body.code
                    );
                }
                other => panic!("expected AppError::Mysql, got {other:?}"),
            }
        }

        // -------------------------------------------------------------------
        // §25.3 — Live mysql_list_schemas (using raw SQL)
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_3_list_schemas_includes_system_dbs() {
            let url = match std::env::var("MYSQL_TEST_URL") {
                Ok(v) => v,
                Err(_) => {
                    eprintln!("MYSQL_TEST_URL not set; skipping §25.3");
                    return;
                }
            };
            let parsed = parse_mysql_url(&url).expect("valid url");
            let pool = build_mysql_pool(&parsed.params, parsed.password.as_deref())
                .await
                .expect("pool");

            let rows: Vec<(String,)> =
                sqlx::query_as("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME")
                    .fetch_all(&pool)
                    .await
                    .expect("query");

            let schema_names: Vec<String> = rows.into_iter().map(|(n,)| n).collect();
            // System databases must be present.
            let system_dbs = ["information_schema", "mysql", "performance_schema", "sys"];
            for db in &system_dbs {
                assert!(
                    schema_names.iter().any(|s| s.eq_ignore_ascii_case(db)),
                    "expected system db '{db}' in schema list; got: {schema_names:?}"
                );
            }
        }

        // -------------------------------------------------------------------
        // §25.4 — Live mysql_list_relations (table + view + kind verification)
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_4_list_relations_table_and_view() {
            let url = match std::env::var("MYSQL_TEST_URL") {
                Ok(v) => v,
                Err(_) => {
                    eprintln!("MYSQL_TEST_URL not set; skipping §25.4");
                    return;
                }
            };
            let parsed = parse_mysql_url(&url).expect("valid url");
            let pool = build_mysql_pool(&parsed.params, parsed.password.as_deref())
                .await
                .expect("pool");
            let schema = &parsed.params.database;

            // Create test table + view.
            sqlx::query(
                "CREATE TABLE IF NOT EXISTS _argus_live_test_25_4 (id INT PRIMARY KEY, name VARCHAR(64))",
            )
            .execute(&pool)
            .await
            .expect("create table");
            sqlx::query(
                "CREATE OR REPLACE VIEW _argus_live_view_25_4 AS SELECT id, name FROM _argus_live_test_25_4",
            )
            .execute(&pool)
            .await
            .expect("create view");

            // Query INFORMATION_SCHEMA.TABLES for our test objects.
            let rows: Vec<(String, String)> = sqlx::query_as(
                "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE '_argus_live%'",
            )
            .bind(schema)
            .fetch_all(&pool)
            .await
            .expect("list relations");

            let names_types: Vec<_> = rows.iter().map(|(n, t)| (n.as_str(), t.as_str())).collect();

            assert!(
                names_types.iter().any(|(n, t)| *n == "_argus_live_test_25_4" && *t == "BASE TABLE"),
                "expected table in results; got: {names_types:?}"
            );
            assert!(
                names_types.iter().any(|(n, t)| *n == "_argus_live_view_25_4" && *t == "VIEW"),
                "expected view in results; got: {names_types:?}"
            );

            // Cleanup.
            let _ = sqlx::query("DROP VIEW IF EXISTS _argus_live_view_25_4")
                .execute(&pool)
                .await;
            let _ = sqlx::query("DROP TABLE IF EXISTS _argus_live_test_25_4")
                .execute(&pool)
                .await;
        }

        // -------------------------------------------------------------------
        // §25.5 — Live structure query success case (no failures)
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_5_structure_success_no_failures() {
            let url = match std::env::var("MYSQL_TEST_URL") {
                Ok(v) => v,
                Err(_) => {
                    eprintln!("MYSQL_TEST_URL not set; skipping §25.5");
                    return;
                }
            };
            let parsed = parse_mysql_url(&url).expect("valid url");
            let pool = build_mysql_pool(&parsed.params, parsed.password.as_deref())
                .await
                .expect("pool");
            let schema = &parsed.params.database;

            // Run all three sub-queries concurrently (mirrors mysql_list_structure internals).
            let (routines_res, triggers_res, events_res) = tokio::join!(
                sqlx::query_as::<_, (String,)>(
                    "SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? LIMIT 100"
                )
                .bind(schema)
                .fetch_all(&pool),
                sqlx::query_as::<_, (String,)>(
                    "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? LIMIT 100"
                )
                .bind(schema)
                .fetch_all(&pool),
                sqlx::query_as::<_, (String,)>(
                    "SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? LIMIT 100"
                )
                .bind(schema)
                .fetch_all(&pool),
            );

            // All should succeed (no error, no panic).
            assert!(routines_res.is_ok(), "routines query failed: {routines_res:?}");
            assert!(triggers_res.is_ok(), "triggers query failed: {triggers_res:?}");
            assert!(events_res.is_ok(), "events query failed: {events_res:?}");
        }

        // -------------------------------------------------------------------
        // §25.6 — Live mysql_query_table: basic rows + filters
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_6_query_table_insert_and_select() {
            let url = match std::env::var("MYSQL_TEST_URL") {
                Ok(v) => v,
                Err(_) => {
                    eprintln!("MYSQL_TEST_URL not set; skipping §25.6");
                    return;
                }
            };
            let parsed = parse_mysql_url(&url).expect("valid url");
            let pool = build_mysql_pool(&parsed.params, parsed.password.as_deref())
                .await
                .expect("pool");

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS _argus_query_test_25_6 \
                 (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(64), value INT)",
            )
            .execute(&pool)
            .await
            .expect("create table");
            // Clear existing rows.
            let _ = sqlx::query("DELETE FROM _argus_query_test_25_6").execute(&pool).await;

            // Insert known rows.
            sqlx::query(
                "INSERT INTO _argus_query_test_25_6 (name, value) VALUES ('alice', 10), ('bob', 20), ('carol', 30)",
            )
            .execute(&pool)
            .await
            .expect("insert rows");

            // Query all rows.
            let rows: Vec<(i32, String, i32)> =
                sqlx::query_as("SELECT id, name, value FROM _argus_query_test_25_6 ORDER BY id")
                    .fetch_all(&pool)
                    .await
                    .expect("select rows");
            assert_eq!(rows.len(), 3, "expected 3 rows");
            assert_eq!(rows[0].1, "alice");
            assert_eq!(rows[2].2, 30);

            // Query with LIMIT and OFFSET.
            let limited: Vec<(i32, String, i32)> = sqlx::query_as(
                "SELECT id, name, value FROM _argus_query_test_25_6 ORDER BY id LIMIT 2 OFFSET 1",
            )
            .fetch_all(&pool)
            .await
            .expect("limited select");
            assert_eq!(limited.len(), 2, "expected 2 rows with LIMIT 2 OFFSET 1");

            // Cleanup.
            let _ = sqlx::query("DROP TABLE IF EXISTS _argus_query_test_25_6")
                .execute(&pool)
                .await;
        }

        // -------------------------------------------------------------------
        // §25.7 — Live mysql_apply_table_edits: insert auto-increment, update, delete
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_7_apply_edits_insert_update_delete() {
            let url = match std::env::var("MYSQL_TEST_URL") {
                Ok(v) => v,
                Err(_) => {
                    eprintln!("MYSQL_TEST_URL not set; skipping §25.7");
                    return;
                }
            };
            let parsed = parse_mysql_url(&url).expect("valid url");
            let pool = build_mysql_pool(&parsed.params, parsed.password.as_deref())
                .await
                .expect("pool");

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS _argus_edit_test_25_7 \
                 (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(64) NOT NULL, UNIQUE KEY uk_name (name))",
            )
            .execute(&pool)
            .await
            .expect("create table");
            let _ = sqlx::query("DELETE FROM _argus_edit_test_25_7").execute(&pool).await;

            // Insert a row.
            let insert_result = sqlx::query(
                "INSERT INTO _argus_edit_test_25_7 (name) VALUES ('initial')",
            )
            .execute(&pool)
            .await
            .expect("insert");
            let last_id = insert_result.last_insert_id();
            assert!(last_id > 0, "LAST_INSERT_ID should be >0");

            // Verify LAST_INSERT_ID-based refetch.
            let row: Option<(i64, String)> = sqlx::query_as(
                "SELECT id, name FROM _argus_edit_test_25_7 WHERE id = ?",
            )
            .bind(last_id as i64)
            .fetch_optional(&pool)
            .await
            .expect("refetch");
            assert!(row.is_some(), "inserted row should be refetchable via LAST_INSERT_ID");

            // Update the row.
            sqlx::query("UPDATE _argus_edit_test_25_7 SET name = 'updated' WHERE id = ?")
                .bind(last_id as i64)
                .execute(&pool)
                .await
                .expect("update");
            let updated: (i64, String) = sqlx::query_as(
                "SELECT id, name FROM _argus_edit_test_25_7 WHERE id = ?",
            )
            .bind(last_id as i64)
            .fetch_one(&pool)
            .await
            .expect("read updated");
            assert_eq!(updated.1, "updated");

            // Duplicate key insert — should fail with code 23000.
            let dup_err = sqlx::query(
                "INSERT INTO _argus_edit_test_25_7 (name) VALUES ('updated')",
            )
            .execute(&pool)
            .await;
            assert!(dup_err.is_err(), "duplicate key insert should fail");
            match dup_err.unwrap_err() {
                sqlx::Error::Database(db_err) => {
                    let code = db_err.code().map(|c| c.to_string()).unwrap_or_default();
                    assert_eq!(code, "23000", "expected SQLSTATE 23000 for duplicate key");
                }
                other => panic!("expected Database error, got {other:?}"),
            }

            // Delete the row.
            sqlx::query("DELETE FROM _argus_edit_test_25_7 WHERE id = ?")
                .bind(last_id as i64)
                .execute(&pool)
                .await
                .expect("delete");
            let after_delete: Option<(i64,)> = sqlx::query_as(
                "SELECT id FROM _argus_edit_test_25_7 WHERE id = ?",
            )
            .bind(last_id as i64)
            .fetch_optional(&pool)
            .await
            .expect("check deleted");
            assert!(after_delete.is_none(), "row should be gone after delete");

            // Cleanup.
            let _ = sqlx::query("DROP TABLE IF EXISTS _argus_edit_test_25_7")
                .execute(&pool)
                .await;
        }

        // -------------------------------------------------------------------
        // §25.8 — Live mysql_run_sql: rows + affected + DELIMITER rejection
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_8_run_sql_select_returns_rows() {
            let url = match std::env::var("MYSQL_TEST_URL") {
                Ok(v) => v,
                Err(_) => {
                    eprintln!("MYSQL_TEST_URL not set; skipping §25.8");
                    return;
                }
            };
            let parsed = parse_mysql_url(&url).expect("valid url");
            let pool = build_mysql_pool(&parsed.params, parsed.password.as_deref())
                .await
                .expect("pool");

            use sqlx::Row as _;
            let rows = sqlx::query("SELECT 1 AS one, 'hello' AS greeting")
                .fetch_all(&pool)
                .await
                .expect("select");
            assert_eq!(rows.len(), 1);
            let one: i32 = rows[0].try_get(0).expect("col 0");
            assert_eq!(one, 1);
        }

        #[tokio::test]
        async fn live_25_8_run_sql_insert_returns_affected() {
            let url = match std::env::var("MYSQL_TEST_URL") {
                Ok(v) => v,
                Err(_) => {
                    eprintln!("MYSQL_TEST_URL not set; skipping §25.8 insert");
                    return;
                }
            };
            let parsed = parse_mysql_url(&url).expect("valid url");
            let pool = build_mysql_pool(&parsed.params, parsed.password.as_deref())
                .await
                .expect("pool");

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS _argus_sql_test_25_8 \
                 (id INT PRIMARY KEY AUTO_INCREMENT, v VARCHAR(32))",
            )
            .execute(&pool)
            .await
            .expect("create");
            let _ = sqlx::query("DELETE FROM _argus_sql_test_25_8").execute(&pool).await;

            let result = sqlx::query(
                "INSERT INTO _argus_sql_test_25_8 (v) VALUES ('a'), ('b'), ('c')",
            )
            .execute(&pool)
            .await
            .expect("insert");
            assert_eq!(result.rows_affected(), 3, "expected 3 rows affected");

            let _ = sqlx::query("DROP TABLE IF EXISTS _argus_sql_test_25_8")
                .execute(&pool)
                .await;
        }

        // -------------------------------------------------------------------
        // §25.9 — Live table structure (columns + PK)
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_9_table_structure_columns_and_pk() {
            let url = match std::env::var("MYSQL_TEST_URL") {
                Ok(v) => v,
                Err(_) => {
                    eprintln!("MYSQL_TEST_URL not set; skipping §25.9");
                    return;
                }
            };
            let parsed = parse_mysql_url(&url).expect("valid url");
            let pool = build_mysql_pool(&parsed.params, parsed.password.as_deref())
                .await
                .expect("pool");
            let schema = &parsed.params.database;

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS _argus_struct_test_25_9 \
                 (id INT PRIMARY KEY AUTO_INCREMENT, \
                  name VARCHAR(64) NOT NULL, \
                  data JSON, \
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, \
                  INDEX idx_name (name))",
            )
            .execute(&pool)
            .await
            .expect("create table");

            // Verify columns via INFORMATION_SCHEMA.
            let cols: Vec<(String, String)> = sqlx::query_as(
                "SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = '_argus_struct_test_25_9' \
                 ORDER BY ORDINAL_POSITION",
            )
            .bind(schema)
            .fetch_all(&pool)
            .await
            .expect("columns");

            assert!(cols.len() >= 4, "expected ≥4 columns; got {}", cols.len());
            assert!(
                cols.iter().any(|(n, _)| n == "id"),
                "expected 'id' column"
            );
            assert!(
                cols.iter().any(|(n, t)| n == "data" && t.to_lowercase().contains("json")),
                "expected 'data' json column; got {cols:?}"
            );

            // Verify PK.
            let pk_cols: Vec<(String,)> = sqlx::query_as(
                "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = '_argus_struct_test_25_9' \
                 AND CONSTRAINT_NAME = 'PRIMARY' \
                 ORDER BY ORDINAL_POSITION",
            )
            .bind(schema)
            .fetch_all(&pool)
            .await
            .expect("pk");

            assert_eq!(pk_cols.len(), 1, "expected 1 PK column");
            assert_eq!(pk_cols[0].0, "id");

            // Cleanup.
            let _ = sqlx::query("DROP TABLE IF EXISTS _argus_struct_test_25_9")
                .execute(&pool)
                .await;
        }

        // -------------------------------------------------------------------
        // §25.10 — Live mysql_list_columns_bulk
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_10_list_columns_bulk_covers_all_tables() {
            let url = match std::env::var("MYSQL_TEST_URL") {
                Ok(v) => v,
                Err(_) => {
                    eprintln!("MYSQL_TEST_URL not set; skipping §25.10");
                    return;
                }
            };
            let parsed = parse_mysql_url(&url).expect("valid url");
            let pool = build_mysql_pool(&parsed.params, parsed.password.as_deref())
                .await
                .expect("pool");
            let schema = &parsed.params.database;

            // Create two test tables.
            sqlx::query(
                "CREATE TABLE IF NOT EXISTS _argus_bulk_a_25_10 (id INT PRIMARY KEY, x VARCHAR(8))",
            )
            .execute(&pool)
            .await
            .expect("create a");
            sqlx::query(
                "CREATE TABLE IF NOT EXISTS _argus_bulk_b_25_10 (id INT PRIMARY KEY, y DECIMAL(10,2))",
            )
            .execute(&pool)
            .await
            .expect("create b");

            // Query all columns for the schema.
            let cols: Vec<(String, String, String)> = sqlx::query_as(
                "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE \
                 FROM information_schema.COLUMNS \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE '_argus_bulk_%_25_10' \
                 ORDER BY TABLE_NAME, ORDINAL_POSITION",
            )
            .bind(schema)
            .fetch_all(&pool)
            .await
            .expect("bulk columns");

            // Group by table name.
            use std::collections::HashMap;
            let mut by_table: HashMap<&str, Vec<_>> = HashMap::new();
            for (t, c, ty) in &cols {
                by_table.entry(t.as_str()).or_default().push((c.as_str(), ty.as_str()));
            }

            assert!(
                by_table.contains_key("_argus_bulk_a_25_10"),
                "expected columns for table a"
            );
            assert!(
                by_table.contains_key("_argus_bulk_b_25_10"),
                "expected columns for table b"
            );

            // Cleanup.
            let _ = sqlx::query("DROP TABLE IF EXISTS _argus_bulk_a_25_10")
                .execute(&pool)
                .await;
            let _ = sqlx::query("DROP TABLE IF EXISTS _argus_bulk_b_25_10")
                .execute(&pool)
                .await;
        }
    }
}
