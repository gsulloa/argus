use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Clone, Serialize)]
pub struct AwsErrorBody {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PostgresErrorBody {
    pub code: Option<String>,
    pub message: String,
    /// 1-based character offset into the SQL where Postgres detected the error.
    /// Populated only when the underlying `tokio_postgres::Error` carries a
    /// DB error with a position; `None` for everything else (network, timeout,
    /// internal validation).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MysqlErrorBody {
    pub code: Option<String>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MssqlErrorBody {
    /// Numeric SQL Server error code (e.g. 18456 for auth failure, 547 for
    /// FK violation). `None` for driver-level errors (DNS, TLS, I/O, timeout).
    pub code: Option<i32>,
    pub message: String,
    /// 1-based line number inside the SQL batch where the error occurred.
    /// `0` means "not applicable" — we normalise that to `None`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    /// Stored procedure or trigger name involved, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub procedure: Option<String>,
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    #[error("storage error: {0}")]
    Storage(String),

    #[error("keychain error: {0}")]
    Keychain(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("validation: {0}")]
    Validation(String),

    #[error("internal: {0}")]
    Internal(String),

    #[error("postgres: {}", .0.message)]
    Postgres(PostgresErrorBody),

    #[error("aws: {}", .0.message)]
    Aws(AwsErrorBody),

    #[error("mysql: {}", .0.message)]
    Mysql(MysqlErrorBody),

    #[error("mssql: {}", .0.message)]
    Mssql(MssqlErrorBody),
}

impl AppError {
    pub fn aws(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        AppError::Aws(AwsErrorBody {
            code: code.into(),
            message: message.into(),
            retryable,
        })
    }

    pub fn postgres(message: impl Into<String>) -> Self {
        AppError::Postgres(PostgresErrorBody {
            code: None,
            message: message.into(),
            position: None,
        })
    }

    pub fn postgres_with_code(code: impl Into<String>, message: impl Into<String>) -> Self {
        AppError::Postgres(PostgresErrorBody {
            code: Some(code.into()),
            message: message.into(),
            position: None,
        })
    }

    pub fn mysql(message: impl Into<String>) -> Self {
        AppError::Mysql(MysqlErrorBody {
            code: None,
            message: message.into(),
            position: None,
        })
    }

    pub fn mysql_with_code(code: impl Into<String>, message: impl Into<String>) -> Self {
        AppError::Mysql(MysqlErrorBody {
            code: Some(code.into()),
            message: message.into(),
            position: None,
        })
    }

    pub fn mysql_with_position(
        code: impl Into<String>,
        message: impl Into<String>,
        position: u32,
    ) -> Self {
        AppError::Mysql(MysqlErrorBody {
            code: Some(code.into()),
            message: message.into(),
            position: Some(position),
        })
    }

    pub fn mssql(message: impl Into<String>) -> Self {
        AppError::Mssql(MssqlErrorBody {
            code: None,
            message: message.into(),
            line: None,
            procedure: None,
        })
    }

    pub fn mssql_with_code(code: i32, message: impl Into<String>) -> Self {
        AppError::Mssql(MssqlErrorBody {
            code: Some(code),
            message: message.into(),
            line: None,
            procedure: None,
        })
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Storage(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Storage(format!("json: {e}"))
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        match e {
            keyring::Error::NoEntry => AppError::NotFound("keychain entry".into()),
            other => AppError::Keychain(other.to_string()),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Storage(format!("io: {e}"))
    }
}

fn build_pg_message_from_parts(
    message: &str,
    detail: Option<&str>,
    hint: Option<&str>,
    where_: Option<&str>,
) -> String {
    let mut s = message.to_string();
    if let Some(d) = detail {
        s.push_str("\nDETAIL: ");
        s.push_str(d);
    }
    if let Some(h) = hint {
        s.push_str("\nHINT: ");
        s.push_str(h);
    }
    if let Some(w) = where_ {
        s.push_str("\nWHERE: ");
        s.push_str(w);
    }
    s
}

fn build_pg_message(e: &tokio_postgres::Error) -> String {
    match e.as_db_error() {
        Some(db) => build_pg_message_from_parts(db.message(), db.detail(), db.hint(), db.where_()),
        None => e.to_string(),
    }
}

impl From<tokio_postgres::Error> for AppError {
    fn from(e: tokio_postgres::Error) -> Self {
        let code = e
            .code()
            .map(|c| c.code().to_string())
            .or_else(|| e.as_db_error().map(|d| d.code().code().to_string()));
        let position = e.as_db_error().and_then(|d| match d.position() {
            Some(tokio_postgres::error::ErrorPosition::Original(p)) => Some(*p as i32),
            Some(tokio_postgres::error::ErrorPosition::Internal { position, .. }) => {
                Some(*position as i32)
            }
            None => None,
        });
        AppError::Postgres(PostgresErrorBody {
            code,
            message: build_pg_message(&e),
            position,
        })
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn db_error_with_detail_and_hint_assembles_multiline_message() {
        let msg = build_pg_message_from_parts(
            "invalid input syntax for type json",
            Some("offending value: not-json"),
            Some("use a valid JSON literal"),
            None,
        );
        assert_eq!(
            msg,
            "invalid input syntax for type json\nDETAIL: offending value: not-json\nHINT: use a valid JSON literal"
        );
    }

    #[test]
    fn db_error_message_only_has_no_extra_lines() {
        let msg = build_pg_message_from_parts("column \"foo\" does not exist", None, None, None);
        assert_eq!(msg, "column \"foo\" does not exist");
    }

    #[test]
    fn non_db_error_falls_back_to_display() {
        let e = tokio_postgres::Error::__private_api_timeout();
        let msg = build_pg_message(&e);
        assert_eq!(msg, e.to_string());
    }
}
