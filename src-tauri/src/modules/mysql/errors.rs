use crate::error::{AppError, MysqlErrorBody};

pub fn map_sqlx_error(err: sqlx::Error) -> AppError {
    match err {
        sqlx::Error::Database(db_err) => {
            let code = db_err.code().map(|c| c.into_owned());
            let message = db_err.message().to_string();
            // TODO(phase-e): parse "near 'X' at line N" from message to extract position
            AppError::Mysql(MysqlErrorBody {
                code,
                message,
                position: None,
            })
        }
        sqlx::Error::RowNotFound => AppError::NotFound("row".into()),
        other => AppError::Mysql(MysqlErrorBody {
            code: None,
            message: other.to_string(),
            position: None,
        }),
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        map_sqlx_error(e)
    }
}
