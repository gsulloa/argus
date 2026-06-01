//! Error mapping from `tiberius::error::Error` to [`AppError`].

use crate::error::{AppError, MssqlErrorBody};

/// Map a `tiberius::error::Error` to an [`AppError`].
///
/// Mapping rules:
/// - `Error::Server(token)` → `AppError::Mssql` with numeric code, message,
///   line, and procedure name extracted from the server token.
/// - `Error::Io { .. }` → `AppError::Mssql { code: None, message: ... }`
/// - `Error::Tls(s)` → `AppError::Mssql { code: None, message: "TLS handshake failed: ..." }`
/// - `Error::Routing { .. }` → `AppError::Mssql { code: None, message: ... }`
/// - All other variants → `AppError::Mssql { code: None, message: format!("{err}") }`
pub fn map_tiberius_error(err: tiberius::error::Error) -> AppError {
    match err {
        tiberius::error::Error::Server(token) => {
            let code = token.code() as i32;
            let message = token.message().to_string();
            // Line 0 means "not applicable"; normalise to None.
            let line = if token.line() == 0 {
                None
            } else {
                Some(token.line())
            };
            // Empty procedure string means "not applicable"; normalise to None.
            let procedure = {
                let p = token.procedure();
                if p.is_empty() {
                    None
                } else {
                    Some(p.to_string())
                }
            };
            AppError::Mssql(MssqlErrorBody {
                code: Some(code),
                message,
                line,
                procedure,
            })
        }
        tiberius::error::Error::Io { message, .. } => AppError::Mssql(MssqlErrorBody {
            code: None,
            message,
            line: None,
            procedure: None,
        }),
        tiberius::error::Error::Tls(s) => AppError::Mssql(MssqlErrorBody {
            code: None,
            message: format!("TLS handshake failed: {s}"),
            line: None,
            procedure: None,
        }),
        tiberius::error::Error::Routing { host, port } => AppError::Mssql(MssqlErrorBody {
            code: None,
            message: format!("server requested routing to {host}:{port}"),
            line: None,
            procedure: None,
        }),
        other => AppError::Mssql(MssqlErrorBody {
            code: None,
            message: format!("{other}"),
            line: None,
            procedure: None,
        }),
    }
}

/// Returns `true` when the error indicates a read-only database (e.g. the
/// database is a secondary replica in an AG and ApplicationIntent=ReadWrite
/// was requested against a read-only database).
///
/// Codes: 3906 (update failed — db is read-only), 3908 (implicit transaction
/// prohibited in read-only access mode).
pub fn is_read_only_error(err: &AppError) -> bool {
    match err {
        AppError::Mssql(body) => matches!(body.code, Some(3906) | Some(3908)),
        _ => false,
    }
}

/// Returns `true` when the error represents a constraint violation that
/// can be surfaced to the user with a typed message.
///
/// Codes:
/// - 547  – FK constraint violation
/// - 2627 – unique constraint violation (PK/UQ)
/// - 2601 – duplicate key in unique index
/// - 515  – NOT NULL violation
/// - 8152 – string / binary truncation (pre-2016 behavior)
/// - 2628 – string / binary truncation (SQL Server 2016+)
/// - 8115 – arithmetic overflow
/// - 241  – conversion failed (invalid date/time)
/// - 242  – conversion of datetime data to smalldatetime
pub fn is_constraint_error(err: &AppError) -> bool {
    match err {
        AppError::Mssql(body) => matches!(
            body.code,
            Some(547)
                | Some(2627)
                | Some(2601)
                | Some(515)
                | Some(8152)
                | Some(8115)
                | Some(241)
                | Some(242)
                | Some(2628)
        ),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;

    fn make_server_error(code: u32, msg: &str, line: u32, proc_name: &str) -> AppError {
        // Build a tiberius error by going through the full map path using a
        // hand-constructed TokenError via the public Display/Debug path.
        // We cannot construct TokenError directly (fields are pub(crate)), so
        // we test via the helper functions using already-mapped AppError values.
        AppError::Mssql(crate::error::MssqlErrorBody {
            code: Some(code as i32),
            message: msg.to_string(),
            line: if line == 0 { None } else { Some(line) },
            procedure: if proc_name.is_empty() {
                None
            } else {
                Some(proc_name.to_string())
            },
        })
    }

    #[test]
    fn is_read_only_error_detects_3906() {
        let err = make_server_error(3906, "db is read-only", 0, "");
        assert!(is_read_only_error(&err));
    }

    #[test]
    fn is_read_only_error_detects_3908() {
        let err = make_server_error(3908, "implicit transaction not allowed", 0, "");
        assert!(is_read_only_error(&err));
    }

    #[test]
    fn is_read_only_error_false_for_other_code() {
        let err = make_server_error(547, "FK violation", 1, "");
        assert!(!is_read_only_error(&err));
    }

    #[test]
    fn is_read_only_error_false_for_non_mssql() {
        let err = AppError::Validation("not mssql".into());
        assert!(!is_read_only_error(&err));
    }

    #[test]
    fn is_constraint_error_detects_all_codes() {
        for code in &[547u32, 2627, 2601, 515, 8152, 8115, 241, 242, 2628] {
            let err = make_server_error(*code, "constraint", 1, "");
            assert!(is_constraint_error(&err), "expected constraint error for code {code}");
        }
    }

    #[test]
    fn is_constraint_error_false_for_read_only_codes() {
        for code in &[3906u32, 3908] {
            let err = make_server_error(*code, "read-only", 0, "");
            assert!(!is_constraint_error(&err), "unexpected constraint error for code {code}");
        }
    }

    #[test]
    fn map_tiberius_io_error_yields_mssql_with_none_code() {
        let io_err = tiberius::error::Error::Io {
            kind: std::io::ErrorKind::ConnectionRefused,
            message: "connection refused".to_string(),
        };
        let app_err = map_tiberius_error(io_err);
        match app_err {
            AppError::Mssql(ref body) => {
                assert!(body.code.is_none());
                assert!(body.message.contains("connection refused"));
            }
            other => panic!("expected Mssql variant, got {other:?}"),
        }
    }

    #[test]
    fn map_tiberius_tls_error_yields_tls_message() {
        let tls_err = tiberius::error::Error::Tls("certificate verify failed".to_string());
        let app_err = map_tiberius_error(tls_err);
        match app_err {
            AppError::Mssql(ref body) => {
                assert!(body.code.is_none());
                assert!(body.message.contains("TLS handshake failed"));
                assert!(body.message.contains("certificate verify failed"));
            }
            other => panic!("expected Mssql variant, got {other:?}"),
        }
    }

    #[test]
    fn map_tiberius_routing_error() {
        let routing_err = tiberius::error::Error::Routing {
            host: "alt.server.com".to_string(),
            port: 1433,
        };
        let app_err = map_tiberius_error(routing_err);
        match app_err {
            AppError::Mssql(ref body) => {
                assert!(body.code.is_none());
                assert!(body.message.contains("alt.server.com"));
            }
            other => panic!("expected Mssql variant, got {other:?}"),
        }
    }

    #[test]
    fn map_tiberius_protocol_error() {
        let proto_err = tiberius::error::Error::Protocol("unexpected packet".into());
        let app_err = map_tiberius_error(proto_err);
        match app_err {
            AppError::Mssql(ref body) => {
                assert!(body.code.is_none());
            }
            other => panic!("expected Mssql variant, got {other:?}"),
        }
    }
}
