use std::collections::HashMap;
use std::sync::Mutex as StdMutex;

use deadpool_postgres::{Hook, HookError, Manager, ManagerConfig, Pool, RecyclingMethod};
use serde::Serialize;
use tokio::sync::RwLock;
use tokio_postgres::Config as PgConfig;
use tokio_postgres::NoTls;
use tokio_postgres_rustls::MakeRustlsConnect;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::postgres::params::{PostgresParams, SslMode};
use crate::modules::postgres::tls::{apply_tls_to_pg_config, client_config_for};
use crate::platform::{connections, secrets};

/// Maximum simultaneous connections per Postgres pool.
const POOL_MAX_SIZE: usize = 4;

/// Active pool entry. The `pool` field is intentionally pub(super) — only the
/// helpers in this module may obtain a client and run queries, which is how we
/// enforce the read-only contract module-wide.
pub(crate) struct ActivePool {
    pub(super) pool: Pool,
    pub server_version: String,
    pub read_only: bool,
    pub connected_at_unix_ms: i64,
    /// Stored so that the schema browser can rebuild a TLS connector for the
    /// `pg_cancel_backend`-style cancellation path without re-reading params
    /// from SQLite. Cheap copy (one-byte enum) per active connection.
    pub(super) sslmode: SslMode,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivePoolSummary {
    pub id: Uuid,
    pub server_version: String,
    pub read_only: bool,
    pub connected_at_unix_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectResult {
    pub server_version: String,
    pub read_only: bool,
}

/// Singleton registry of active pools, stored as Tauri state.
pub struct PgPoolRegistry {
    pools: RwLock<HashMap<Uuid, ActivePool>>,
}

impl PgPoolRegistry {
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

    /// True if a pool is registered for the id.
    pub async fn is_active(&self, id: &Uuid) -> bool {
        self.pools.read().await.contains_key(id)
    }

    /// Build and register a pool, eagerly verifying the handshake.
    /// Idempotent: if a pool already exists for `id`, returns its summary.
    pub async fn connect(
        &self,
        params: PostgresParams,
        secret: Option<String>,
        id: Uuid,
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
        let pg_cfg = build_pg_config(&params, secret.as_deref());
        let pool = build_pool(pg_cfg.clone(), &params)?;

        // Eagerly fetch one connection to fail fast on auth/network/handshake.
        let server_version = {
            let client = pool
                .get()
                .await
                .map_err(|e| AppError::postgres(format!("acquire from pool: {e}")))?;
            let row = client.query_one("SELECT version()", &[]).await?;
            row.get::<_, String>(0)
        };

        let now_ms = now_unix_ms();
        let active = ActivePool {
            pool,
            server_version: server_version.clone(),
            read_only: params.read_only,
            connected_at_unix_ms: now_ms,
            sslmode: params.sslmode,
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
            read_only: params.read_only,
        })
    }

    /// Remove the pool. Idle connections close on drop; in-flight ones complete.
    pub async fn disconnect(&self, id: &Uuid) -> bool {
        self.pools.write().await.remove(id).is_some()
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

    /// Borrow a client from the registered pool. `pub(crate)` so only modules
    /// inside `modules::postgres` can use it (the schema browser shares one
    /// client across multiple introspection queries). External callers must go
    /// through `execute_query` / `execute_mutation`, which preserve the
    /// read-only mutation gate.
    pub(crate) async fn acquire(&self, id: &Uuid) -> AppResult<deadpool_postgres::Object> {
        let guard = self.pools.read().await;
        let entry = guard
            .get(id)
            .ok_or_else(|| AppError::NotFound(format!("no active pool for {id}")))?;
        entry
            .pool
            .get()
            .await
            .map_err(|e| AppError::postgres(format!("acquire from pool: {e}")))
    }

    /// Read the stored `SslMode` for an active pool. Used by the schema
    /// browser's cancellation path: a `pg_cancel_backend`-style cancel opens
    /// a fresh short-lived connection, which needs a TLS connector that
    /// matches the original connection's mode.
    pub(crate) async fn sslmode_for(&self, id: &Uuid) -> AppResult<SslMode> {
        let guard = self.pools.read().await;
        let entry = guard
            .get(id)
            .ok_or_else(|| AppError::NotFound(format!("no active pool for {id}")))?;
        Ok(entry.sslmode)
    }

    /// Run a SELECT-style query against the pool. Always allowed.
    #[allow(dead_code)]
    pub async fn execute_query(
        &self,
        id: &Uuid,
        sql: &str,
        params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
    ) -> AppResult<Vec<tokio_postgres::Row>> {
        let guard = self.pools.read().await;
        let entry = guard
            .get(id)
            .ok_or_else(|| AppError::NotFound(format!("no active pool for {id}")))?;
        let client = entry
            .pool
            .get()
            .await
            .map_err(|e| AppError::postgres(format!("acquire from pool: {e}")))?;
        Ok(client.query(sql, params).await?)
    }

    /// Run a DML/DDL statement. Rejected before reaching the wire if the pool
    /// is read-only.
    #[allow(dead_code)]
    pub async fn execute_mutation(
        &self,
        id: &Uuid,
        sql: &str,
        params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
    ) -> AppResult<u64> {
        let guard = self.pools.read().await;
        let entry = guard
            .get(id)
            .ok_or_else(|| AppError::NotFound(format!("no active pool for {id}")))?;
        if entry.read_only {
            return Err(AppError::Validation("connection is read-only".into()));
        }
        let client = entry
            .pool
            .get()
            .await
            .map_err(|e| AppError::postgres(format!("acquire from pool: {e}")))?;
        Ok(client.execute(sql, params).await?)
    }
}

impl Default for PgPoolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Build a tokio-postgres Config from our typed params + optional password.
pub(super) fn build_pg_config(params: &PostgresParams, password: Option<&str>) -> PgConfig {
    let mut cfg = PgConfig::new();
    cfg.host(&params.host)
        .port(params.port)
        .dbname(&params.database)
        .user(&params.username)
        .application_name(params.effective_application_name());
    if let Some(pw) = password {
        cfg.password(pw);
    }
    apply_tls_to_pg_config(&mut cfg, params.sslmode);
    cfg
}

/// Build the deadpool pool, applying the read-only hook when needed and using
/// either the rustls or NoTls connector based on the sslmode.
fn build_pool(pg_cfg: PgConfig, params: &PostgresParams) -> AppResult<Pool> {
    let mgr_config = ManagerConfig {
        recycling_method: RecyclingMethod::Fast,
    };

    let mgr = match client_config_for(params.sslmode)? {
        Some(rustls_cfg) => {
            let connector = MakeRustlsConnect::new((*rustls_cfg).clone());
            Manager::from_config(pg_cfg, connector, mgr_config)
        }
        None => Manager::from_config(pg_cfg, NoTls, mgr_config),
    };

    let mut builder = Pool::builder(mgr).max_size(POOL_MAX_SIZE);

    if params.read_only {
        builder = builder.post_create(Hook::async_fn(|client, _| {
            Box::pin(async move {
                client
                    .batch_execute(
                        "SET SESSION default_transaction_read_only = on; \
                         SET SESSION transaction_read_only = on;",
                    )
                    .await
                    .map_err(|e| HookError::Message(format!("read-only hook: {e}").into()))?;
                Ok(())
            })
        }));
    }

    builder
        .build()
        .map_err(|e| AppError::Internal(format!("pool builder: {e}")))
}

/// Resolve a connection's params + secret from the registry, returning a tuple
/// suitable for `connect()`. Acquires the DB lock briefly.
pub fn load_connection_input(
    db: &StdMutex<rusqlite::Connection>,
    id: Uuid,
) -> AppResult<(PostgresParams, Option<String>)> {
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
    if kind != "postgres" {
        return Err(AppError::Validation(format!(
            "connection {id} is kind '{kind}', not 'postgres'"
        )));
    }
    let value: serde_json::Value = serde_json::from_str(&params_json)?;
    let params = PostgresParams::from_json(&value)?;
    drop(conn);

    let secret = secrets::get(&id)?;
    Ok((params, secret))
}

/// Helper used by the connections-create flow to validate Postgres params at
/// the registry boundary before persisting.
pub fn validate_postgres_kind(input: &connections::ConnectionInput) -> AppResult<()> {
    if input.kind == "postgres" {
        let p = PostgresParams::from_json(&input.params)?;
        p.validate()?;
    }
    Ok(())
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn list_active_initial_is_empty() {
        let reg = PgPoolRegistry::new();
        assert!(reg.list_active().await.is_empty());
    }

    #[tokio::test]
    async fn disconnect_when_absent_returns_false() {
        let reg = PgPoolRegistry::new();
        assert!(!reg.disconnect(&Uuid::new_v4()).await);
    }

    #[tokio::test]
    async fn disconnect_all_on_empty_registry_returns_zero() {
        let reg = PgPoolRegistry::new();
        assert_eq!(reg.disconnect_all().await, 0);
        assert!(reg.list_active().await.is_empty());
    }

    #[tokio::test]
    async fn execute_mutation_on_unknown_id_returns_not_found() {
        let reg = PgPoolRegistry::new();
        let err = reg
            .execute_mutation(&Uuid::new_v4(), "UPDATE x SET y=1", &[])
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    // Live tests are gated behind a feature flag so CI does not need a server.
    #[cfg(feature = "live-pg-tests")]
    mod live {
        use super::*;
        use crate::modules::postgres::params::SslMode;

        fn live_params() -> (PostgresParams, Option<String>) {
            // Expects PG_TEST_URL=postgres://user:pass@localhost:5432/postgres
            let url = std::env::var("PG_TEST_URL").expect("PG_TEST_URL");
            let parsed = crate::modules::postgres::url::parse_postgres_url(&url).unwrap();
            (parsed.params, parsed.password)
        }

        #[tokio::test]
        async fn live_connect_and_query() {
            let reg = PgPoolRegistry::new();
            let id = Uuid::new_v4();
            let (params, pw) = live_params();
            let res = reg.connect(params, pw, id).await.unwrap();
            assert!(res.server_version.starts_with("PostgreSQL"));
            let rows = reg.execute_query(&id, "SELECT 1::int", &[]).await.unwrap();
            assert_eq!(rows[0].get::<_, i32>(0), 1);
        }

        #[tokio::test]
        async fn live_disconnect_all_drops_every_pool() {
            let reg = PgPoolRegistry::new();
            let (params, pw) = live_params();
            let id1 = Uuid::new_v4();
            let id2 = Uuid::new_v4();
            reg.connect(params.clone(), pw.clone(), id1).await.unwrap();
            reg.connect(params, pw, id2).await.unwrap();
            assert_eq!(reg.list_active().await.len(), 2);

            let dropped = reg.disconnect_all().await;
            assert_eq!(dropped, 2);
            assert!(reg.list_active().await.is_empty());
        }

        #[tokio::test]
        async fn live_read_only_rejects_mutation() {
            let reg = PgPoolRegistry::new();
            let id = Uuid::new_v4();
            let (mut params, pw) = live_params();
            params.read_only = true;
            params.sslmode = SslMode::Disable;
            reg.connect(params, pw, id).await.unwrap();
            let err = reg
                .execute_mutation(&id, "CREATE TEMP TABLE _argus_ro_test (x int)", &[])
                .await
                .unwrap_err();
            match err {
                AppError::Validation(m) => assert!(m.contains("read-only")),
                other => panic!("expected validation, got {other:?}"),
            }
        }
    }
}
