//! Query cancellation infrastructure for MS SQL Server.
//!
//! Strategy: "drop-on-timeout + KILL <spid> fallback".
//!
//! tiberius 0.12 does not expose a `cancel_query()` method on `Client`. When
//! a tiberius future is dropped mid-flight the underlying tokio `TcpStream` is
//! dropped, which causes the OS to send a TCP RST. SQL Server interprets this as
//! an attention and rolls back the query on the server side. The connection is
//! *dirty* (bb8 marks it for discard) but we also fire `KILL <spid>` on a fresh
//! connection as a belt-and-suspenders fallback to guarantee the server-side
//! query terminates even in cases where the TCP RST is not delivered promptly
//! (e.g. Azure SQL with proxy routing).

use std::future::Future;
use std::time::Duration;

use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_util::compat::TokioAsyncWriteCompatExt;

use crate::error::{AppError, AppResult, MssqlErrorBody};
use crate::modules::mssql::errors::map_tiberius_error;
use crate::modules::mssql::params::MssqlParams;
use crate::modules::mssql::tls::build_tiberius_config;

// ---------------------------------------------------------------------------
// §6.1 — capture_spid
// ---------------------------------------------------------------------------

/// Run `SELECT @@SPID` on an already-acquired connection and return the
/// server process ID as `i32`. Called at the start of each cancellable query
/// so the cancel path knows which session to KILL.
///
/// tiberius surfaces `@@SPID` as `i16`; we widen to `i32` for convenience.
pub async fn capture_spid(
    client: &mut bb8::PooledConnection<'_, bb8_tiberius::ConnectionManager>,
) -> AppResult<i32> {
    let rows = client
        .simple_query("SELECT @@SPID")
        .await
        .map_err(map_tiberius_error)?
        .into_first_result()
        .await
        .map_err(map_tiberius_error)?;

    let row = rows
        .into_iter()
        .next()
        .ok_or_else(|| AppError::mssql("SELECT @@SPID returned no rows"))?;

    // tiberius returns @@SPID as i16.
    let spid: i16 = row
        .get::<i16, _>(0)
        .ok_or_else(|| AppError::mssql("SELECT @@SPID: missing column"))?;

    Ok(spid as i32)
}

// ---------------------------------------------------------------------------
// §6.2 — run_with_cancel (timeout wrapper)
// ---------------------------------------------------------------------------

/// Wrap `fut` with a hard timeout. On timeout, returns a "query cancelled"
/// `AppError::Mssql` with `code: None`.
///
/// NOTE: Dropping the future signals tiberius to send an Attention packet
/// (TCP RST → server-side attention). For belt-and-suspenders, the caller
/// should also fire `fire_mssql_cancel(spid, ...)` after this returns the
/// cancellation error (§6.3).
pub async fn run_with_cancel<F, T>(fut: F, timeout_secs: u64) -> AppResult<T>
where
    F: Future<Output = AppResult<T>>,
{
    match timeout(Duration::from_secs(timeout_secs), fut).await {
        Ok(result) => result,
        Err(_elapsed) => Err(AppError::Mssql(MssqlErrorBody {
            code: None,
            message: "query cancelled".into(),
            line: None,
            procedure: None,
        })),
    }
}

// ---------------------------------------------------------------------------
// §6.3 — fire_mssql_cancel
// ---------------------------------------------------------------------------

/// Open a fresh short-lived tiberius connection matching the original
/// session's `encrypt_mode` + `trust_server_certificate`, then run
/// `KILL <spid>` as a best-effort fallback.
///
/// Errors are **warn-logged but never propagated**. KILL is best-effort;
/// failure (e.g. the query already completed) must not mask the original
/// timeout error returned to the caller.
///
/// Safety: `spid` must be a positive i32 (SPID values are 1–32767 on
/// SQL Server). We validate this before formatting into the SQL string.
pub async fn fire_mssql_cancel(
    spid: i32,
    params: &MssqlParams,
    password: &str,
) -> AppResult<()> {
    if spid <= 0 {
        tracing::warn!("mssql cancel: invalid spid {spid}; skipping KILL");
        return Ok(());
    }

    let outcome = timeout(Duration::from_secs(5), async {
        let config = build_tiberius_config(params, password);
        let addr = config.get_addr();
        let tcp = TcpStream::connect(addr)
            .await
            .map_err(|e| AppError::mssql(format!("cancel TCP connect failed: {e}")))?;
        tcp.set_nodelay(true)
            .map_err(|e| AppError::mssql(format!("set_nodelay failed: {e}")))?;
        let mut client = tiberius::Client::connect(config, tcp.compat_write())
            .await
            .map_err(map_tiberius_error)?;

        // KILL does not accept parameters in T-SQL; we format the validated
        // positive i32 directly.
        let kill_sql = format!("KILL {spid}");
        client
            .simple_query(&kill_sql)
            .await
            .map_err(map_tiberius_error)?
            .into_first_result()
            .await
            .map_err(map_tiberius_error)?;

        Ok::<(), AppError>(())
    })
    .await;

    match outcome {
        Ok(Ok(())) => {
            tracing::debug!("mssql cancel: KILL {spid} succeeded");
        }
        Ok(Err(e)) => {
            tracing::warn!("mssql cancel: KILL {spid} failed: {e:?}");
        }
        Err(_elapsed) => {
            tracing::warn!("mssql cancel: KILL {spid} timed out after 5s");
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// §6.4 — run_cancellable_simple_query
// ---------------------------------------------------------------------------

/// Run a simple SQL query (no parameters) with per-query timeout and
/// KILL-based cancellation fallback.
///
/// Pattern:
/// 1. Acquire connection from pool.
/// 2. Capture SPID.
/// 3. Run the query under a timeout.
/// 4. On timeout: fire KILL <spid> (best-effort) and return "query cancelled".
///
/// This simpler form (string-in, rows-out) is used by Phase D/E commands to
/// avoid lifetime-juggling with generic closures over pooled connections.
pub async fn run_cancellable_simple_query(
    pool: &bb8::Pool<bb8_tiberius::ConnectionManager>,
    sql: &str,
    timeout_secs: u64,
    cancel_params: Option<(&MssqlParams, &str)>,
) -> AppResult<Vec<tiberius::Row>> {
    use crate::modules::mssql::pool::map_bb8_error;

    let mut conn = pool.get().await.map_err(map_bb8_error)?;

    // Capture SPID for cancel path.
    let spid = capture_spid(&mut conn).await.unwrap_or(-1);

    let sql_owned = sql.to_string();
    let result = timeout(Duration::from_secs(timeout_secs), async move {
        conn.simple_query(&sql_owned)
            .await
            .map_err(map_tiberius_error)?
            .into_first_result()
            .await
            .map_err(map_tiberius_error)
    })
    .await;

    match result {
        Ok(Ok(rows)) => Ok(rows),
        Ok(Err(e)) => Err(e),
        Err(_elapsed) => {
            // Fire best-effort KILL.
            if spid > 0 {
                if let Some((params, password)) = cancel_params {
                    fire_mssql_cancel(spid, params, password).await.ok();
                }
            }
            Err(AppError::Mssql(MssqlErrorBody {
                code: None,
                message: format!("query cancelled (timeout {}s)", timeout_secs),
                line: None,
                procedure: None,
            }))
        }
    }
}

// ---------------------------------------------------------------------------
// §6.4 — run_cancellable_query (generic closure form)
// ---------------------------------------------------------------------------

/// Generic cancellable query helper.
///
/// Acquires a connection, captures SPID, runs a user-provided closure, and
/// races the closure against a timeout. On timeout, fires KILL <spid> and
/// returns a "query cancelled" error.
///
/// `encrypt_mode_info`: optional `(params, password)` for the KILL connection.
/// If `None`, KILL is skipped (only drop-on-timeout applies).
pub async fn run_cancellable_query<F, Fut, T>(
    pool: &bb8::Pool<bb8_tiberius::ConnectionManager>,
    timeout_secs: u64,
    cancel_params: Option<(&MssqlParams, &str)>,
    f: F,
) -> AppResult<T>
where
    F: FnOnce(bb8::PooledConnection<'static, bb8_tiberius::ConnectionManager>) -> Fut,
    Fut: Future<Output = AppResult<T>>,
{
    use crate::modules::mssql::pool::map_bb8_error;

    // We need a static lifetime connection for the generic closure form.
    // Clone and leak the pool Arc so the PooledConnection can be 'static.
    let leaked: &'static bb8::Pool<bb8_tiberius::ConnectionManager> =
        Box::leak(Box::new(pool.clone()));

    let mut spid_conn = pool.get().await.map_err(map_bb8_error)?;
    let spid = capture_spid(&mut spid_conn).await.unwrap_or(-1);
    drop(spid_conn);

    let conn = leaked.get().await.map_err(map_bb8_error)?;
    let fut = f(conn);

    match timeout(Duration::from_secs(timeout_secs), fut).await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(e)) => Err(e),
        Err(_elapsed) => {
            if spid > 0 {
                if let Some((params, password)) = cancel_params {
                    fire_mssql_cancel(spid, params, password).await.ok();
                }
            }
            Err(AppError::Mssql(MssqlErrorBody {
                code: None,
                message: format!("query cancelled (timeout {}s)", timeout_secs),
                line: None,
                procedure: None,
            }))
        }
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::mssql::params::EncryptMode;

    fn dummy_params() -> MssqlParams {
        MssqlParams {
            host: "127.0.0.1".into(),
            port: 1,
            database: "test".into(),
            username: "sa".into(),
            encrypt: EncryptMode::Off,
            trust_server_certificate: true,
            read_only: false,
            instance_name: None,
            application_intent: None,
        }
    }

    #[tokio::test]
    async fn run_with_cancel_returns_error_on_timeout() {
        let result = run_with_cancel(
            async {
                tokio::time::sleep(Duration::from_secs(10)).await;
                Ok::<i32, AppError>(42)
            },
            0, // 0-second timeout → immediate
        )
        .await;

        match result {
            Err(AppError::Mssql(body)) => {
                assert!(body.code.is_none());
                assert!(body.message.contains("cancelled"));
            }
            other => panic!("expected Mssql cancellation error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn run_with_cancel_passes_success_through() {
        let result = run_with_cancel(
            async { Ok::<i32, AppError>(123) },
            5, // 5-second timeout — plenty
        )
        .await;

        assert_eq!(result.unwrap(), 123);
    }

    #[tokio::test]
    async fn run_with_cancel_passes_error_through() {
        let result = run_with_cancel(
            async { Err::<i32, AppError>(AppError::Validation("oops".into())) },
            5,
        )
        .await;

        assert!(matches!(result, Err(AppError::Validation(_))));
    }

    #[tokio::test]
    async fn fire_mssql_cancel_invalid_spid_is_silent() {
        // spid <= 0 → should warn and return Ok(()) without attempting to connect.
        let params = dummy_params();
        let result = fire_mssql_cancel(-1, &params, "password").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn fire_mssql_cancel_unreachable_host_is_silent() {
        // Unreachable port → inner connect fails → warn logged, Ok(()) returned.
        let params = dummy_params(); // port 1 is unreachable
        let result = fire_mssql_cancel(1234, &params, "password").await;
        assert!(result.is_ok(), "cancel failure must not propagate: {result:?}");
    }
}
