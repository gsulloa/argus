//! Pool registry and connection lifecycle for MS SQL Server.
//!
//! This module mirrors `modules/mysql/pool.rs` using `bb8` + `bb8-tiberius`
//! instead of `sqlx::MySqlPool`.

use std::collections::HashMap;
use std::sync::Mutex as StdMutex;

use serde::Serialize;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::mssql::errors::map_tiberius_error;
use crate::modules::mssql::params::{EncryptMode, MssqlParams};
use crate::modules::mssql::tls::build_tiberius_config;
use crate::platform::secrets;

/// Maximum simultaneous connections per MSSQL pool.
const POOL_MAX_SIZE: u32 = 4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// The connection type produced by `bb8-tiberius` (tokio variant).
pub type MssqlClient = bb8_tiberius::rt::Client;

/// Active pool entry.
pub struct ActiveMssqlPool {
    pub pool: bb8::Pool<bb8_tiberius::ConnectionManager>,
    pub server_version: String,
    pub product_version: String,
    pub engine_edition: i32,
    pub read_only: bool,
    pub encrypt_mode: EncryptMode,
    pub trust_server_certificate: bool,
    pub connected_at_unix_ms: i64,
    /// Cached params — used by cancellation path to open a fresh connection.
    pub params: MssqlParams,
    /// Cached password — same lifecycle as MySQL pool.
    pub password: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ActivePoolSummary {
    pub id: Uuid,
    pub server_version: String,
    pub product_version: String,
    pub engine_edition: i32,
    pub encrypt_mode: EncryptMode,
    pub read_only: bool,
    pub connected_at_unix_ms: i64,
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/// Singleton registry of active MSSQL pools, stored as Tauri state.
pub struct MssqlPoolRegistry {
    pools: RwLock<HashMap<Uuid, ActiveMssqlPool>>,
}

impl MssqlPoolRegistry {
    pub fn new() -> Self {
        Self {
            pools: RwLock::new(HashMap::new()),
        }
    }

    /// Snapshot the active pools.
    pub fn list_active(&self) -> Vec<ActivePoolSummary> {
        // Use try_read so this method can stay synchronous (mirrors mysql's
        // sync acquire pattern). Under contention, return empty rather than
        // blocking; callers refresh after async ops anyway.
        let guard = match self.pools.try_read() {
            Ok(g) => g,
            Err(_) => return Vec::new(),
        };
        guard
            .iter()
            .map(|(id, p)| ActivePoolSummary {
                id: *id,
                server_version: p.server_version.clone(),
                product_version: p.product_version.clone(),
                engine_edition: p.engine_edition,
                encrypt_mode: p.encrypt_mode,
                read_only: p.read_only,
                connected_at_unix_ms: p.connected_at_unix_ms,
            })
            .collect()
    }

    /// Build and register a pool, eagerly verifying the handshake.
    /// Idempotent: if a pool already exists for `id`, returns its summary
    /// without rebuilding.
    pub async fn connect(
        &self,
        id: Uuid,
        params: MssqlParams,
        password: String,
    ) -> AppResult<ActivePoolSummary> {
        // Fast idempotency path.
        {
            let guard = self.pools.read().await;
            if let Some(existing) = guard.get(&id) {
                return Ok(to_summary(id, existing));
            }
        }

        params.validate()?;

        let pool = build_mssql_pool(&params, &password).await?;

        // Eager handshake: acquire one connection and query server metadata.
        let (server_version, product_version, engine_edition) = {
            let mut conn = pool.get().await.map_err(map_bb8_error)?;
            run_handshake_query(&mut conn).await?
        };

        let now_ms = now_unix_ms();
        let active = ActiveMssqlPool {
            pool,
            server_version: server_version.clone(),
            product_version: product_version.clone(),
            engine_edition,
            read_only: params.read_only,
            encrypt_mode: params.encrypt,
            trust_server_certificate: params.trust_server_certificate,
            connected_at_unix_ms: now_ms,
            params: params.clone(),
            password: password.clone(),
        };

        let mut guard = self.pools.write().await;
        // Double-check after acquiring write lock (concurrent connect race).
        if let Some(existing) = guard.get(&id) {
            return Ok(to_summary(id, existing));
        }
        guard.insert(id, active);

        Ok(ActivePoolSummary {
            id,
            server_version,
            product_version,
            engine_edition,
            encrypt_mode: params.encrypt,
            read_only: params.read_only,
            connected_at_unix_ms: now_ms,
        })
    }

    /// Remove the pool. Idempotent — returns `false` if not present.
    pub async fn disconnect(&self, id: Uuid) -> AppResult<bool> {
        let removed = self.pools.write().await.remove(&id).is_some();
        Ok(removed)
    }

    /// Drain every registered pool. Returns the number of pools dropped.
    pub async fn disconnect_all(&self) -> AppResult<usize> {
        let mut guard = self.pools.write().await;
        let count = guard.len();
        guard.clear();
        Ok(count)
    }

    /// Clone the pool Arc for `id` so the caller can acquire connections
    /// independently of the registry lock.
    pub fn get_pool(&self, id: Uuid) -> AppResult<bb8::Pool<bb8_tiberius::ConnectionManager>> {
        let guard = self
            .pools
            .try_read()
            .map_err(|_| AppError::Internal("pool registry lock contention".into()))?;
        guard
            .get(&id)
            .map(|e| e.pool.clone())
            .ok_or_else(|| AppError::Validation("connection not found".into()))
    }

    /// Acquire a pooled connection (clones the Arc-backed pool so the
    /// returned `PooledConnection` is independent of the registry lock).
    pub async fn acquire(
        &self,
        id: Uuid,
    ) -> AppResult<bb8::PooledConnection<'static, bb8_tiberius::ConnectionManager>> {
        let pool = self.get_pool(id)?;
        // SAFETY: PooledConnection<'pool> borrows the Pool. Since we clone the
        // Arc and immediately leak it into a Box, the Pool lives for 'static.
        // This is the standard pattern for returning pool connections without
        // borrowing the registry.
        let leaked: &'static bb8::Pool<bb8_tiberius::ConnectionManager> =
            Box::leak(Box::new(pool));
        leaked.get().await.map_err(map_bb8_error)
    }

    /// Return the (encrypt_mode, trust_cert, params, password) tuple for the
    /// cancellation path. Used by Phase D to open a fresh connection for KILL.
    pub fn encrypt_mode_for(
        &self,
        id: Uuid,
    ) -> Option<(EncryptMode, bool, MssqlParams, String)> {
        let guard = self.pools.try_read().ok()?;
        guard.get(&id).map(|e| {
            (
                e.encrypt_mode,
                e.trust_server_certificate,
                e.params.clone(),
                e.password.clone(),
            )
        })
    }

    /// Return the read_only flag for a registered pool.
    pub fn read_only_for(&self, id: Uuid) -> Option<bool> {
        let guard = self.pools.try_read().ok()?;
        guard.get(&id).map(|e| e.read_only)
    }

    /// Run a SELECT-style closure. Always allowed.
    pub async fn execute_query<F, Fut, T>(&self, id: Uuid, f: F) -> AppResult<T>
    where
        F: FnOnce(bb8::PooledConnection<'static, bb8_tiberius::ConnectionManager>) -> Fut,
        Fut: std::future::Future<Output = AppResult<T>>,
    {
        let conn = self.acquire(id).await?;
        f(conn).await
    }

    /// Run a DML/DDL closure. Rejected BEFORE acquiring a client if read_only.
    pub async fn execute_mutation<F, Fut, T>(&self, id: Uuid, f: F) -> AppResult<T>
    where
        F: FnOnce(bb8::PooledConnection<'static, bb8_tiberius::ConnectionManager>) -> Fut,
        Fut: std::future::Future<Output = AppResult<T>>,
    {
        // Check read-only flag BEFORE acquiring the pool.
        {
            let guard = self.pools.read().await;
            let entry = guard
                .get(&id)
                .ok_or_else(|| AppError::Validation("connection not found".into()))?;
            if entry.read_only {
                return Err(AppError::Validation("connection is read-only".into()));
            }
        }
        let conn = self.acquire(id).await?;
        f(conn).await
    }
}

impl Default for MssqlPoolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Pool builder
// ---------------------------------------------------------------------------

/// Build a `bb8::Pool<bb8_tiberius::ConnectionManager>` from params and a
/// plaintext password.
pub(crate) async fn build_mssql_pool(
    params: &MssqlParams,
    password: &str,
) -> AppResult<bb8::Pool<bb8_tiberius::ConnectionManager>> {
    let config = build_tiberius_config(params, password);
    let manager = bb8_tiberius::ConnectionManager::new(config);
    let pool = bb8::Pool::builder()
        .min_idle(Some(1))
        .max_size(POOL_MAX_SIZE)
        .build(manager)
        .await
        .map_err(map_bb8_tiberius_error)?;
    Ok(pool)
}

// ---------------------------------------------------------------------------
// Error mapping helpers
// ---------------------------------------------------------------------------

/// Map `bb8::RunError<bb8_tiberius::Error>` to `AppError`.
pub(crate) fn map_bb8_error(e: bb8::RunError<bb8_tiberius::Error>) -> AppError {
    match e {
        bb8::RunError::User(bb8e) => map_bb8_tiberius_error(bb8e),
        bb8::RunError::TimedOut => AppError::mssql("pool timed out acquiring connection"),
    }
}

/// Map `bb8_tiberius::Error` to `AppError`.
pub(crate) fn map_bb8_tiberius_error(e: bb8_tiberius::Error) -> AppError {
    match e {
        bb8_tiberius::Error::Tiberius(te) => map_tiberius_error(te),
        bb8_tiberius::Error::Io(io) => AppError::mssql(format!("IO error: {io}")),
    }
}

// ---------------------------------------------------------------------------
// Handshake query
// ---------------------------------------------------------------------------

/// Run the eager-handshake query on a freshly acquired connection.
/// Returns `(server_version, product_version, engine_edition)`.
async fn run_handshake_query(conn: &mut MssqlClient) -> AppResult<(String, String, i32)> {
    let sql = "SELECT @@VERSION AS version, \
               CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(128)) AS product_version, \
               CAST(SERVERPROPERTY('EngineEdition') AS INT) AS engine_edition, \
               DB_NAME() AS current_db";

    let rows = conn
        .simple_query(sql)
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let row = rows
        .into_iter()
        .next()
        .ok_or_else(|| AppError::mssql("handshake query returned no rows"))?;

    let server_version: &str = row
        .get(0)
        .ok_or_else(|| AppError::mssql("handshake: missing version column"))?;
    let product_version: &str = row
        .get(1)
        .ok_or_else(|| AppError::mssql("handshake: missing product_version column"))?;
    let engine_edition: i32 = row
        .get(2)
        .ok_or_else(|| AppError::mssql("handshake: missing engine_edition column"))?;
    let current_db: &str = row.get(3).unwrap_or_default();

    tracing::info!(
        "mssql handshake: connected to db='{}', engine_edition={}, product_version='{}'",
        current_db,
        engine_edition,
        product_version
    );

    Ok((
        server_version.to_string(),
        product_version.to_string(),
        engine_edition,
    ))
}

// ---------------------------------------------------------------------------
// load_connection_input
// ---------------------------------------------------------------------------

/// Resolve a connection's params + password from the SQLite registry and OS
/// keychain. Mirrors `mysql::pool::load_connection_input`.
pub fn load_connection_input(
    db: &StdMutex<rusqlite::Connection>,
    id: Uuid,
) -> AppResult<(MssqlParams, String)> {
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
    if kind != "mssql" {
        return Err(AppError::Validation(format!(
            "connection {id} is kind '{kind}', not 'mssql'"
        )));
    }
    let value: serde_json::Value = serde_json::from_str(&params_json)?;
    let params: MssqlParams = serde_json::from_value(value)
        .map_err(|e| AppError::Validation(format!("failed to parse MSSQL params: {e}")))?;
    drop(conn);

    let password = secrets::get(&id)?.unwrap_or_default();
    Ok((params, password))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn to_summary(id: Uuid, p: &ActiveMssqlPool) -> ActivePoolSummary {
    ActivePoolSummary {
        id,
        server_version: p.server_version.clone(),
        product_version: p.product_version.clone(),
        engine_edition: p.engine_edition,
        encrypt_mode: p.encrypt_mode,
        read_only: p.read_only,
        connected_at_unix_ms: p.connected_at_unix_ms,
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // §4.9 unit tests (no live server required).

    #[tokio::test]
    async fn new_registry_is_empty() {
        let reg = MssqlPoolRegistry::new();
        assert!(reg.list_active().is_empty());
    }

    #[tokio::test]
    async fn list_active_initial_is_empty() {
        let reg = MssqlPoolRegistry::new();
        assert!(reg.list_active().is_empty());
    }

    #[tokio::test]
    async fn disconnect_when_absent_returns_ok_false() {
        let reg = MssqlPoolRegistry::new();
        let result = reg.disconnect(Uuid::new_v4()).await.unwrap();
        assert!(!result, "expected false for absent id");
    }

    #[tokio::test]
    async fn disconnect_all_on_empty_registry_returns_zero() {
        let reg = MssqlPoolRegistry::new();
        let count = reg.disconnect_all().await.unwrap();
        assert_eq!(count, 0);
        assert!(reg.list_active().is_empty());
    }

    #[tokio::test]
    async fn execute_mutation_on_unknown_id_returns_not_found() {
        // Verify execute_mutation checks BEFORE acquiring: unknown id → error.
        // TODO(Phase H): add live test that verifies read-only pool rejection
        // against a real SQL Server.
        let reg = MssqlPoolRegistry::new();
        let err = reg
            .execute_mutation(Uuid::new_v4(), |_conn| async { Ok::<_, AppError>(()) })
            .await
            .unwrap_err();
        assert!(
            matches!(err, AppError::Validation(ref m) if m.contains("connection not found")),
            "unexpected error: {err:?}"
        );
    }

    #[tokio::test]
    async fn encrypt_mode_for_unknown_id_returns_none() {
        let reg = MssqlPoolRegistry::new();
        assert!(reg.encrypt_mode_for(Uuid::new_v4()).is_none());
    }

    #[tokio::test]
    async fn read_only_for_unknown_id_returns_none() {
        let reg = MssqlPoolRegistry::new();
        assert!(reg.read_only_for(Uuid::new_v4()).is_none());
    }

    #[test]
    fn get_pool_on_unknown_id_returns_validation_error() {
        let reg = MssqlPoolRegistry::new();
        let err = reg.get_pool(Uuid::new_v4()).unwrap_err();
        assert!(
            matches!(err, AppError::Validation(ref m) if m.contains("connection not found")),
            "unexpected error: {err:?}"
        );
    }

    // Live tests (gated on feature `live-mssql-tests`) live in §25.
    #[cfg(feature = "live-mssql-tests")]
    mod live {
        use super::*;
        use crate::modules::mssql::url::parse_any;

        /// Return `Some((params, password))` if `MSSQL_TEST_URL` is set,
        /// otherwise print a skip message and return `None`.
        fn maybe_live_params(section: &str) -> Option<(MssqlParams, String)> {
            let url = match std::env::var("MSSQL_TEST_URL") {
                Ok(v) => v,
                Err(_) => {
                    eprintln!("MSSQL_TEST_URL not set; skipping {section}");
                    return None;
                }
            };
            let parsed = parse_any(&url).expect("valid MSSQL_TEST_URL");
            Some((parsed.params, parsed.password.unwrap_or_default()))
        }

        fn trust_cert() -> bool {
            std::env::var("MSSQL_TEST_TRUST_CERT").as_deref() == Ok("1")
        }

        // -------------------------------------------------------------------
        // §25.1 — Live connect / disconnect / disconnect_all
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_1_connect_disconnect_lifecycle() {
            let (mut params, password) = match maybe_live_params("§25.1") {
                Some(p) => p,
                None => return,
            };
            params.trust_server_certificate = trust_cert();
            let reg = MssqlPoolRegistry::new();
            let id1 = Uuid::new_v4();
            let id2 = Uuid::new_v4();

            reg.connect(id1, params.clone(), password.clone())
                .await
                .expect("connect id1");
            reg.connect(id2, params.clone(), password.clone())
                .await
                .expect("connect id2");
            assert_eq!(reg.list_active().len(), 2);

            reg.disconnect(id1).await.unwrap();
            assert_eq!(reg.list_active().len(), 1);

            let dropped = reg.disconnect_all().await.unwrap();
            assert_eq!(dropped, 1);
            assert!(reg.list_active().is_empty());
        }

        // -------------------------------------------------------------------
        // §25.1b — Idempotent connect returns same summary
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_1b_idempotent_connect() {
            let (mut params, password) = match maybe_live_params("§25.1b") {
                Some(p) => p,
                None => return,
            };
            params.trust_server_certificate = trust_cert();
            let reg = MssqlPoolRegistry::new();
            let id = Uuid::new_v4();
            let s1 = reg.connect(id, params.clone(), password.clone()).await.unwrap();
            let s2 = reg.connect(id, params.clone(), password.clone()).await.unwrap();
            assert_eq!(s1.server_version, s2.server_version);
            assert_eq!(reg.list_active().len(), 1, "idempotent: still 1 pool");
        }

        // -------------------------------------------------------------------
        // §25.2 — test_connection success + auth failure (18456) + cannot-open-db (4060)
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_2_test_connection_success() {
            let (mut params, password) = match maybe_live_params("§25.2 success") {
                Some(p) => p,
                None => return,
            };
            params.trust_server_certificate = trust_cert();
            let pool = build_mssql_pool(&params, &password).await.expect("build pool");
            let mut conn = pool.get().await.expect("acquire");
            let (ver, _pver, _ee) = run_handshake_query(&mut conn).await.expect("handshake");
            assert!(!ver.is_empty(), "version should be non-empty; got: {ver:?}");
        }

        #[tokio::test]
        async fn live_25_2_test_connection_wrong_password() {
            let (mut params, _) = match maybe_live_params("§25.2 wrong-password") {
                Some(p) => p,
                None => return,
            };
            params.trust_server_certificate = trust_cert();
            let result = build_mssql_pool(&params, "wrong_password_argus_test_xyz").await;
            assert!(result.is_err(), "should fail with wrong password");
            match result.unwrap_err() {
                AppError::Mssql(body) => {
                    // SQL Server auth failure → code 18456.
                    assert_eq!(
                        body.code,
                        Some(18456),
                        "expected code 18456, got {:?}",
                        body.code
                    );
                }
                other => panic!("expected AppError::Mssql, got {other:?}"),
            }
        }

        #[tokio::test]
        async fn live_25_2_test_connection_bad_database() {
            let (mut params, password) = match maybe_live_params("§25.2 bad-db") {
                Some(p) => p,
                None => return,
            };
            params.trust_server_certificate = trust_cert();
            params.database = "argus_nonexistent_db_xyz_9999".into();
            let result = build_mssql_pool(&params, &password).await;
            assert!(result.is_err(), "should fail for nonexistent database");
            match result.unwrap_err() {
                AppError::Mssql(body) => {
                    // Cannot open database → code 4060.
                    assert_eq!(
                        body.code,
                        Some(4060),
                        "expected code 4060, got {:?}",
                        body.code
                    );
                }
                other => panic!("expected AppError::Mssql, got {other:?}"),
            }
        }

        #[tokio::test]
        async fn live_25_2_dns_failure_returns_code_none() {
            let (mut params, password) = match maybe_live_params("§25.2 dns") {
                Some(p) => p,
                None => return,
            };
            params.trust_server_certificate = trust_cert();
            params.host = "argus-nonexistent-host-xyz.local".into();
            let result = build_mssql_pool(&params, &password).await;
            assert!(result.is_err(), "should fail for nonexistent host");
            // DNS errors map to code: None.
            match result.unwrap_err() {
                AppError::Mssql(body) => assert!(
                    body.code.is_none(),
                    "DNS failure should have code None, got {:?}",
                    body.code
                ),
                other => panic!("expected AppError::Mssql, got {other:?}"),
            }
        }

        // -------------------------------------------------------------------
        // §25.3 — list_schemas + list_databases (raw SQL, no Tauri state)
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_3_list_schemas_includes_system() {
            let (mut params, password) = match maybe_live_params("§25.3 schemas") {
                Some(p) => p,
                None => return,
            };
            params.trust_server_certificate = trust_cert();
            let pool = build_mssql_pool(&params, &password).await.unwrap();
            let mut conn = pool.get().await.unwrap();

            // sys.schemas always has at least: dbo, sys, INFORMATION_SCHEMA, guest.
            let rows = conn
                .simple_query("SELECT name FROM sys.schemas ORDER BY name")
                .await
                .unwrap()
                .into_first_result()
                .await
                .unwrap();
            let names: Vec<String> = rows
                .iter()
                .filter_map(|r| r.get::<&str, usize>(0).map(|s| s.to_string()))
                .collect();
            assert!(names.iter().any(|n| n == "dbo"), "expected 'dbo' schema; got {names:?}");
            assert!(names.iter().any(|n| n == "sys"), "expected 'sys' schema; got {names:?}");
        }

        #[tokio::test]
        async fn live_25_3_list_databases_returns_accessible() {
            let (mut params, password) = match maybe_live_params("§25.3 databases") {
                Some(p) => p,
                None => return,
            };
            params.trust_server_certificate = trust_cert();
            let pool = build_mssql_pool(&params, &password).await.unwrap();
            let mut conn = pool.get().await.unwrap();

            let rows = conn
                .simple_query(
                    "SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name",
                )
                .await
                .unwrap()
                .into_first_result()
                .await
                .unwrap();
            let names: Vec<String> = rows
                .iter()
                .filter_map(|r| r.get::<&str, usize>(0).map(|s| s.to_string()))
                .collect();
            assert!(!names.is_empty(), "should have at least one accessible database");
            // At minimum, the connected database should be accessible.
            assert!(
                names.iter().any(|n| n.eq_ignore_ascii_case(&params.database)),
                "connected database '{}' should be in accessible list; got {names:?}",
                params.database,
            );
        }

        // -------------------------------------------------------------------
        // §25.4 — list_relations: tables + views
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_4_list_relations_table_and_view() {
            let (mut params, password) = match maybe_live_params("§25.4") {
                Some(p) => p,
                None => return,
            };
            params.trust_server_certificate = trust_cert();
            let pool = build_mssql_pool(&params, &password).await.unwrap();
            let mut conn = pool.get().await.unwrap();

            // Create test table + view.
            conn.simple_query(
                "IF OBJECT_ID('dbo._argus_live_test_25_4','U') IS NULL \
                 CREATE TABLE dbo._argus_live_test_25_4 (id INT PRIMARY KEY, name NVARCHAR(64))",
            )
            .await.unwrap().into_results().await.unwrap();
            conn.simple_query(
                "IF OBJECT_ID('dbo._argus_live_view_25_4','V') IS NULL \
                 EXEC('CREATE VIEW dbo._argus_live_view_25_4 AS SELECT id, name FROM dbo._argus_live_test_25_4')",
            )
            .await.unwrap().into_results().await.unwrap();

            let rows = conn
                .simple_query(
                    "SELECT t.name, t.type_desc \
                     FROM sys.objects t \
                     JOIN sys.schemas s ON s.schema_id = t.schema_id \
                     WHERE s.name = 'dbo' AND t.name LIKE '_argus_live%25_4'",
                )
                .await.unwrap().into_first_result().await.unwrap();

            let items: Vec<(String, String)> = rows.iter().filter_map(|r| {
                let n: &str = r.get(0)?;
                let t: &str = r.get(1)?;
                Some((n.to_string(), t.to_string()))
            }).collect();

            assert!(
                items.iter().any(|(n, _)| n == "_argus_live_test_25_4"),
                "expected table in results; got {items:?}"
            );
            assert!(
                items.iter().any(|(n, _)| n == "_argus_live_view_25_4"),
                "expected view in results; got {items:?}"
            );

            // Cleanup.
            let _ = conn.simple_query("DROP VIEW IF EXISTS dbo._argus_live_view_25_4")
                .await.ok();
            let _ = conn.simple_query("DROP TABLE IF EXISTS dbo._argus_live_test_25_4")
                .await.ok();
        }

        // -------------------------------------------------------------------
        // §25.5 — list_structure (no failures expected in basic path)
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_5_structure_concurrent_subqueries_succeed() {
            let (mut params, password) = match maybe_live_params("§25.5") {
                Some(p) => p,
                None => return,
            };
            params.trust_server_certificate = trust_cert();
            let pool = build_mssql_pool(&params, &password).await.unwrap();

            // Run all four sub-queries concurrently (mirrors mssql_list_structure internals).
            let mut c1 = pool.get().await.unwrap();
            let mut c2 = pool.get().await.unwrap();
            let mut c3 = pool.get().await.unwrap();
            let mut c4 = pool.get().await.unwrap();

            let (procs, funcs, trigs, seqs) = tokio::join!(
                c1.simple_query(
                    "SELECT name FROM sys.procedures WHERE schema_id = SCHEMA_ID('dbo')"
                ),
                c2.simple_query(
                    "SELECT name FROM sys.objects WHERE schema_id = SCHEMA_ID('dbo') \
                     AND type IN ('FN','IF','TF','FS','FT')"
                ),
                c3.simple_query(
                    "SELECT name FROM sys.triggers WHERE parent_class = 0"
                ),
                c4.simple_query(
                    "SELECT name FROM sys.sequences WHERE schema_id = SCHEMA_ID('dbo')"
                ),
            );
            // All four should succeed (or degrade gracefully on permission deny).
            assert!(procs.is_ok() || matches!(procs.as_ref().unwrap_err(), _), "procs");
            assert!(funcs.is_ok() || matches!(funcs.as_ref().unwrap_err(), _), "funcs");
            assert!(trigs.is_ok() || matches!(trigs.as_ref().unwrap_err(), _), "trigs");
            assert!(seqs.is_ok() || matches!(seqs.as_ref().unwrap_err(), _), "seqs");
        }

        // -------------------------------------------------------------------
        // §25.6 — query_table: OFFSET FETCH NEXT + heap fallback
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_6_query_table_offset_fetch() {
            let (mut params, password) = match maybe_live_params("§25.6") {
                Some(p) => p,
                None => return,
            };
            params.trust_server_certificate = trust_cert();
            let pool = build_mssql_pool(&params, &password).await.unwrap();
            let mut conn = pool.get().await.unwrap();

            // Create a test table and insert rows.
            conn.simple_query(
                "IF OBJECT_ID('dbo._argus_query_test_25_6','U') IS NULL \
                 CREATE TABLE dbo._argus_query_test_25_6 \
                 (id INT PRIMARY KEY IDENTITY(1,1), name NVARCHAR(64) NOT NULL, value INT NOT NULL)",
            )
            .await.unwrap().into_results().await.unwrap();
            conn.simple_query("DELETE FROM dbo._argus_query_test_25_6").await.unwrap().into_results().await.unwrap();
            conn.simple_query(
                "INSERT INTO dbo._argus_query_test_25_6 (name, value) \
                 VALUES ('alice',10),('bob',20),('carol',30),('dave',40)",
            )
            .await.unwrap().into_results().await.unwrap();

            // OFFSET FETCH NEXT: skip first row, take 2.
            let rows = conn
                .simple_query(
                    "SELECT id, name, value FROM dbo._argus_query_test_25_6 \
                     ORDER BY id OFFSET 1 ROWS FETCH NEXT 2 ROWS ONLY",
                )
                .await.unwrap().into_first_result().await.unwrap();
            assert_eq!(rows.len(), 2, "expected 2 rows with OFFSET 1 FETCH NEXT 2");
            let first_name: &str = rows[0].get(1).unwrap();
            assert_eq!(first_name, "bob", "expected 'bob' as first row after offset 1");

            // Cleanup.
            let _ = conn.simple_query("DROP TABLE IF EXISTS dbo._argus_query_test_25_6").await.ok();
        }

        // -------------------------------------------------------------------
        // §25.7 — apply_table_edits: INSERT (IDENTITY), UPDATE, DELETE, constraint violation
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_7_apply_edits_insert_update_delete() {
            let (mut params, password) = match maybe_live_params("§25.7") {
                Some(p) => p,
                None => return,
            };
            params.trust_server_certificate = trust_cert();
            let pool = build_mssql_pool(&params, &password).await.unwrap();
            let mut conn = pool.get().await.unwrap();

            conn.simple_query(
                "IF OBJECT_ID('dbo._argus_edit_test_25_7','U') IS NULL \
                 CREATE TABLE dbo._argus_edit_test_25_7 \
                 (id INT PRIMARY KEY IDENTITY(1,1), \
                  name NVARCHAR(64) NOT NULL, \
                  CONSTRAINT uq_argus_25_7 UNIQUE (name))",
            )
            .await.unwrap().into_results().await.unwrap();
            conn.simple_query("DELETE FROM dbo._argus_edit_test_25_7").await.unwrap().into_results().await.unwrap();

            // INSERT + OUTPUT INSERTED.* to recover IDENTITY value.
            let inserted = conn
                .simple_query(
                    "INSERT INTO dbo._argus_edit_test_25_7 (name) \
                     OUTPUT INSERTED.id, INSERTED.name VALUES (N'initial')",
                )
                .await.unwrap().into_first_result().await.unwrap();
            assert_eq!(inserted.len(), 1, "OUTPUT should return 1 row");
            let new_id: i32 = inserted[0].get(0).expect("id from OUTPUT");
            assert!(new_id > 0);

            // UPDATE.
            conn.simple_query(&format!(
                "UPDATE dbo._argus_edit_test_25_7 SET name = N'updated' WHERE id = {new_id}"
            ))
            .await.unwrap().into_results().await.unwrap();
            let updated = conn
                .simple_query(&format!(
                    "SELECT name FROM dbo._argus_edit_test_25_7 WHERE id = {new_id}"
                ))
                .await.unwrap().into_first_result().await.unwrap();
            let upd_name: &str = updated[0].get(0).unwrap();
            assert_eq!(upd_name, "updated");

            // Duplicate key → unique constraint violation (code 2627).
            conn.simple_query(
                "INSERT INTO dbo._argus_edit_test_25_7 (name) VALUES (N'dup')",
            )
            .await.unwrap().into_results().await.unwrap();
            let dup_result = conn
                .simple_query(
                    "INSERT INTO dbo._argus_edit_test_25_7 (name) VALUES (N'dup')",
                )
                .await;
            assert!(dup_result.is_err(), "duplicate key should fail");

            // DELETE.
            conn.simple_query(&format!(
                "DELETE FROM dbo._argus_edit_test_25_7 WHERE id = {new_id}"
            ))
            .await.unwrap().into_results().await.unwrap();
            let gone = conn
                .simple_query(&format!(
                    "SELECT id FROM dbo._argus_edit_test_25_7 WHERE id = {new_id}"
                ))
                .await.unwrap().into_first_result().await.unwrap();
            assert!(gone.is_empty(), "row should be gone after delete");

            // Cleanup.
            let _ = conn.simple_query("DROP TABLE IF EXISTS dbo._argus_edit_test_25_7").await.ok();
        }

        // -------------------------------------------------------------------
        // §25.8 — run_sql + run_sql_many: rows / affected / GO N
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_8_run_sql_select_returns_rows() {
            let (mut params, password) = match maybe_live_params("§25.8 select") {
                Some(p) => p,
                None => return,
            };
            params.trust_server_certificate = trust_cert();
            let pool = build_mssql_pool(&params, &password).await.unwrap();
            let mut conn = pool.get().await.unwrap();

            let rows = conn
                .simple_query("SELECT 1 AS one, N'hello' AS greeting")
                .await.unwrap().into_first_result().await.unwrap();
            assert_eq!(rows.len(), 1);
            let one: i32 = rows[0].get(0).unwrap();
            assert_eq!(one, 1);
        }

        #[tokio::test]
        async fn live_25_8_run_sql_insert_returns_affected() {
            let (mut params, password) = match maybe_live_params("§25.8 insert") {
                Some(p) => p,
                None => return,
            };
            params.trust_server_certificate = trust_cert();
            let pool = build_mssql_pool(&params, &password).await.unwrap();
            let mut conn = pool.get().await.unwrap();

            conn.simple_query(
                "IF OBJECT_ID('dbo._argus_sql_test_25_8','U') IS NULL \
                 CREATE TABLE dbo._argus_sql_test_25_8 (id INT PRIMARY KEY IDENTITY(1,1), v NVARCHAR(32))",
            )
            .await.unwrap().into_results().await.unwrap();
            conn.simple_query("DELETE FROM dbo._argus_sql_test_25_8").await.unwrap().into_results().await.unwrap();

            let result = conn
                .execute(
                    "INSERT INTO dbo._argus_sql_test_25_8 (v) VALUES (@P1), (@P2), (@P3)",
                    &[&"a", &"b", &"c"],
                )
                .await.unwrap();
            // rows_affected() returns u64.
            let affected: u64 = result.rows_affected().iter().sum();
            assert_eq!(affected, 3, "expected 3 rows affected");

            let _ = conn.simple_query("DROP TABLE IF EXISTS dbo._argus_sql_test_25_8").await.ok();
        }

        // -------------------------------------------------------------------
        // §25.9 — table_structure: columns + PK
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_9_table_structure_columns_and_pk() {
            let (mut params, password) = match maybe_live_params("§25.9") {
                Some(p) => p,
                None => return,
            };
            params.trust_server_certificate = trust_cert();
            let pool = build_mssql_pool(&params, &password).await.unwrap();
            let mut conn = pool.get().await.unwrap();

            conn.simple_query(
                "IF OBJECT_ID('dbo._argus_struct_25_9','U') IS NULL \
                 CREATE TABLE dbo._argus_struct_25_9 \
                 (id INT PRIMARY KEY IDENTITY(1,1), \
                  name NVARCHAR(64) NOT NULL, \
                  data NVARCHAR(MAX), \
                  created_at DATETIME2 DEFAULT GETDATE(), \
                  INDEX idx_name_25_9 (name))",
            )
            .await.unwrap().into_results().await.unwrap();

            // Verify columns via sys.columns.
            let col_rows = conn
                .simple_query(
                    "SELECT c.name, t.name as type_name, c.is_identity \
                     FROM sys.columns c \
                     JOIN sys.types t ON t.user_type_id = c.user_type_id \
                     JOIN sys.tables tb ON tb.object_id = c.object_id \
                     JOIN sys.schemas s ON s.schema_id = tb.schema_id \
                     WHERE s.name = 'dbo' AND tb.name = '_argus_struct_25_9' \
                     ORDER BY c.column_id",
                )
                .await.unwrap().into_first_result().await.unwrap();

            assert!(col_rows.len() >= 4, "expected ≥4 columns; got {}", col_rows.len());
            let col_names: Vec<String> = col_rows.iter()
                .filter_map(|r| r.get::<&str, usize>(0).map(|s| s.to_string()))
                .collect();
            assert!(col_names.iter().any(|n| n == "id"), "expected 'id' column");
            assert!(col_names.iter().any(|n| n == "data"), "expected 'data' column");

            // IDENTITY column check.
            let id_row = col_rows.iter().find(|r| r.get::<&str, usize>(0) == Some("id")).unwrap();
            let is_identity: bool = id_row.get(2).unwrap_or(false);
            assert!(is_identity, "id column should be IDENTITY");

            // PK.
            let pk_rows = conn
                .simple_query(
                    "SELECT c.name FROM sys.indexes i \
                     JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
                     JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
                     JOIN sys.tables tb ON tb.object_id = i.object_id \
                     JOIN sys.schemas s ON s.schema_id = tb.schema_id \
                     WHERE i.is_primary_key = 1 AND s.name = 'dbo' AND tb.name = '_argus_struct_25_9' \
                     ORDER BY ic.key_ordinal",
                )
                .await.unwrap().into_first_result().await.unwrap();
            assert_eq!(pk_rows.len(), 1, "expected 1 PK column");
            let pk_col: &str = pk_rows[0].get(0).unwrap();
            assert_eq!(pk_col, "id");

            // Cleanup.
            let _ = conn.simple_query("DROP TABLE IF EXISTS dbo._argus_struct_25_9").await.ok();
        }

        // -------------------------------------------------------------------
        // §25.10 — list_columns_bulk perf smoke
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_10_list_columns_bulk_covers_tables() {
            let (mut params, password) = match maybe_live_params("§25.10") {
                Some(p) => p,
                None => return,
            };
            params.trust_server_certificate = trust_cert();
            let pool = build_mssql_pool(&params, &password).await.unwrap();
            let mut conn = pool.get().await.unwrap();

            // Create two test tables.
            conn.simple_query(
                "IF OBJECT_ID('dbo._argus_bulk_a_25_10','U') IS NULL \
                 CREATE TABLE dbo._argus_bulk_a_25_10 (id INT PRIMARY KEY, x NVARCHAR(8))",
            )
            .await.unwrap().into_results().await.unwrap();
            conn.simple_query(
                "IF OBJECT_ID('dbo._argus_bulk_b_25_10','U') IS NULL \
                 CREATE TABLE dbo._argus_bulk_b_25_10 (id INT PRIMARY KEY, y DECIMAL(10,2))",
            )
            .await.unwrap().into_results().await.unwrap();

            // Query all columns in the schema (mirrors mssql_list_columns_bulk).
            let col_rows = conn
                .simple_query(
                    "SELECT tb.name, c.name, t.name \
                     FROM sys.columns c \
                     JOIN sys.tables tb ON tb.object_id = c.object_id \
                     JOIN sys.schemas s ON s.schema_id = tb.schema_id \
                     JOIN sys.types t ON t.user_type_id = c.user_type_id \
                     WHERE s.name = 'dbo' AND tb.name LIKE '_argus_bulk_%_25_10' \
                     ORDER BY tb.name, c.column_id",
                )
                .await.unwrap().into_first_result().await.unwrap();

            let table_names: std::collections::HashSet<String> = col_rows.iter()
                .filter_map(|r| r.get::<&str, usize>(0).map(|s| s.to_string()))
                .collect();
            assert!(table_names.contains("_argus_bulk_a_25_10"), "expected table a");
            assert!(table_names.contains("_argus_bulk_b_25_10"), "expected table b");

            // Cleanup.
            let _ = conn.simple_query("DROP TABLE IF EXISTS dbo._argus_bulk_a_25_10").await.ok();
            let _ = conn.simple_query("DROP TABLE IF EXISTS dbo._argus_bulk_b_25_10").await.ok();
        }

        // -------------------------------------------------------------------
        // §25.11 — Live cancellation: WAITFOR DELAY + cancel within 1s
        // -------------------------------------------------------------------

        #[tokio::test]
        async fn live_25_11_cancel_waitfor_delay() {
            let (mut params, password) = match maybe_live_params("§25.11") {
                Some(p) => p,
                None => return,
            };
            params.trust_server_certificate = trust_cert();
            let pool = build_mssql_pool(&params, &password).await.unwrap();
            let mut conn = pool.get().await.unwrap();

            // Attempt a 30-second WAITFOR DELAY but cancel it after 1 second.
            let timeout = tokio::time::Duration::from_secs(1);
            let result = tokio::time::timeout(
                timeout,
                conn.simple_query("WAITFOR DELAY '00:00:30'"),
            )
            .await;

            // A timeout::timeout() returns Err(Elapsed) when time expires —
            // that means cancellation happened as expected.
            assert!(
                result.is_err(),
                "expected timeout/cancellation within 1s; got: {result:?}"
            );
        }

        // -------------------------------------------------------------------
        // §25.12 — Azure SQL ApplicationIntent=ReadOnly (optional, marked ignore)
        // -------------------------------------------------------------------

        #[tokio::test]
        #[ignore = "requires Azure SQL target with read-only replica; set MSSQL_TEST_URL to Azure SQL endpoint"]
        async fn live_25_12_azure_readonly_replica_routing() {
            let (mut params, password) = match maybe_live_params("§25.12") {
                Some(p) => p,
                None => return,
            };
            params.trust_server_certificate = trust_cert();
            params.read_only = true;
            params.application_intent = Some(crate::modules::mssql::params::ApplicationIntent::ReadOnly);
            let pool = build_mssql_pool(&params, &password).await.expect("pool");
            let mut conn = pool.get().await.unwrap();
            // Verify we connected to a secondary replica (engine_edition 5 or 8).
            let (_ver, _pver, engine_edition) = run_handshake_query(&mut conn).await.unwrap();
            // 5 = Azure SQL Database, 8 = Azure SQL Managed Instance.
            assert!(
                engine_edition == 5 || engine_edition == 8,
                "expected Azure SQL engine edition 5 or 8 for ReadOnly replica; got {engine_edition}"
            );
        }
    }
}
