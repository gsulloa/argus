use serde::Serialize;
use thiserror::Error;

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
}

impl AppError {
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
            message: e.to_string(),
            position,
        })
    }
}

pub type AppResult<T> = Result<T, AppError>;
