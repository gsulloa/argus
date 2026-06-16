use std::future::Future;
use std::time::Duration;

use sqlx::mysql::MySqlConnectOptions;
use sqlx::Connection as _;
use tokio::time::timeout;

use crate::error::{AppError, AppResult};
use crate::modules::mysql::errors::map_sqlx_error;
use crate::modules::mysql::params::MysqlParams;
use crate::modules::mysql::tls::apply_to_connect_options;

/// Open a fresh short-lived connection and run `KILL QUERY <thread_id>`.
/// Best-effort: failures are warn-logged but never propagated. The caller
/// always gets `Ok(())` so a cancel failure never masks the original timeout.
pub async fn fire_mysql_cancel(
    params: &MysqlParams,
    secret: Option<&str>,
    thread_id: u64,
) -> Result<(), AppError> {
    let outcome = timeout(Duration::from_secs(5), async {
        let mut opts = MySqlConnectOptions::new()
            .host(&params.host)
            .port(params.port)
            .username(&params.username)
            .database(&params.database);
        if let Some(p) = secret {
            opts = opts.password(p);
        }
        opts = apply_to_connect_options(opts, params.ssl_mode);

        let mut conn = sqlx::MySqlConnection::connect_with(&opts)
            .await
            .map_err(map_sqlx_error)?;
        sqlx::query(&format!("KILL QUERY {thread_id}"))
            .execute(&mut conn)
            .await
            .map_err(map_sqlx_error)?;
        conn.close().await.map_err(map_sqlx_error)?;
        Ok::<(), AppError>(())
    })
    .await;

    match outcome {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            tracing::warn!("mysql cancel: KILL QUERY {thread_id} failed: {e:?}");
        }
        Err(_elapsed) => {
            tracing::warn!("mysql cancel: KILL QUERY {thread_id} timed out after 5s");
        }
    }
    Ok(())
}

/// Run `SELECT CONNECTION_ID()` on an existing connection and return the
/// thread ID. Called at the start of each cancellable query so the cancel
/// path knows which thread to KILL.
pub async fn capture_thread_id(conn: &mut sqlx::MySqlConnection) -> AppResult<u64> {
    let (id,): (u64,) = sqlx::query_as("SELECT CONNECTION_ID()")
        .fetch_one(&mut *conn)
        .await
        .map_err(map_sqlx_error)?;
    Ok(id)
}

/// Wrap a cancellable future with a hard timeout. On timeout, fires
/// `KILL QUERY <thread_id>` (best-effort) and returns a 70100 error.
/// On success or early error the inner result passes through unchanged.
pub async fn with_mysql_timeout_and_cancel<F, T>(
    duration: Duration,
    params: &MysqlParams,
    secret: Option<&str>,
    thread_id: u64,
    fut: F,
) -> Result<T, AppError>
where
    F: Future<Output = Result<T, AppError>>,
{
    match timeout(duration, fut).await {
        Ok(result) => result,
        Err(_elapsed) => {
            fire_mysql_cancel(params, secret, thread_id).await.ok();
            Err(AppError::mysql_with_code(
                "70100",
                format!("query cancelled (timeout {}s)", duration.as_secs()),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_params() -> MysqlParams {
        MysqlParams {
            host: "127.0.0.1".into(),
            port: 1, // unreachable — cancel will fail silently
            database: "test".into(),
            username: "root".into(),
            ssl_mode: crate::modules::mysql::params::SslMode::Disabled,
            read_only: false,
        }
    }

    #[tokio::test]
    async fn timeout_path_returns_70100() {
        let params = dummy_params();
        let result =
            with_mysql_timeout_and_cancel(Duration::from_millis(50), &params, None, 999, async {
                tokio::time::sleep(Duration::from_secs(2)).await;
                Ok::<(), AppError>(())
            })
            .await;

        let err = result.unwrap_err();
        match err {
            AppError::Mysql(body) => {
                assert_eq!(body.code.as_deref(), Some("70100"));
                assert!(body.message.contains("timeout"));
            }
            other => panic!("expected Mysql error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn cancel_failure_does_not_propagate_still_gets_70100() {
        // Unreachable port → fire_mysql_cancel fails internally. The result
        // should still be the 70100 timeout error, not a connection error.
        let params = dummy_params();
        let result =
            with_mysql_timeout_and_cancel(Duration::from_millis(50), &params, None, 999, async {
                tokio::time::sleep(Duration::from_secs(2)).await;
                Ok::<(), AppError>(())
            })
            .await;

        let err = result.unwrap_err();
        assert!(matches!(err, AppError::Mysql(_)));
        if let AppError::Mysql(body) = err {
            assert_eq!(body.code.as_deref(), Some("70100"));
        }
    }

    #[tokio::test]
    async fn success_passes_through() {
        let params = dummy_params();
        let result =
            with_mysql_timeout_and_cancel(Duration::from_secs(5), &params, None, 999, async {
                Ok::<i32, AppError>(42)
            })
            .await;

        assert_eq!(result.unwrap(), 42);
    }

    #[tokio::test]
    async fn early_error_passes_through() {
        let params = dummy_params();
        let result =
            with_mysql_timeout_and_cancel(Duration::from_secs(5), &params, None, 999, async {
                Err::<i32, AppError>(AppError::Validation("oops".into()))
            })
            .await;

        let err = result.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }
}
