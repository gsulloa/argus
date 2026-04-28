use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Clone, Serialize)]
pub struct PostgresErrorBody {
    pub code: Option<String>,
    pub message: String,
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
        })
    }

    pub fn postgres_with_code(code: impl Into<String>, message: impl Into<String>) -> Self {
        AppError::Postgres(PostgresErrorBody {
            code: Some(code.into()),
            message: message.into(),
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
        AppError::Postgres(PostgresErrorBody {
            code,
            message: e.to_string(),
        })
    }
}

pub type AppResult<T> = Result<T, AppError>;
