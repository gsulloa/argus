use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::error::{AppError, AppResult};
use crate::modules::mysql::params::{MysqlParams, SslMode};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ParseResult {
    pub params: MysqlParams,
    pub password: Option<String>,
}

pub fn parse_mysql_url(input: &str) -> AppResult<ParseResult> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("URL must not be empty".into()));
    }

    let url =
        Url::parse(trimmed).map_err(|e| AppError::Validation(format!("malformed URL: {e}")))?;

    match url.scheme() {
        "mysql" | "mariadb" => {}
        other => {
            return Err(AppError::Validation(format!(
                "unsupported URL scheme '{other}'; expected mysql:// or mariadb://"
            )));
        }
    }

    let host = url
        .host_str()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| AppError::Validation("URL is missing a host".into()))?
        .to_string();

    let port = url.port().unwrap_or(3306);
    if port == 0 {
        return Err(AppError::Validation("port must be in [1, 65535]".into()));
    }

    let database = {
        let path = url.path();
        let stripped = path.strip_prefix('/').unwrap_or(path);
        if stripped.is_empty() {
            return Err(AppError::Validation("database path is required".into()));
        }
        decode(stripped)?
    };

    let username = if url.username().is_empty() {
        return Err(AppError::Validation(
            "URL is missing a username (mysql://<user>@host/db)".into(),
        ));
    } else {
        decode(url.username())?
    };

    let password = match url.password() {
        Some(p) => Some(decode(p)?),
        None => None,
    };

    let mut ssl_mode = SslMode::Preferred;

    for (k, v) in url.query_pairs() {
        let key = k.to_ascii_lowercase();
        match key.as_str() {
            "ssl-mode" | "sslmode" => ssl_mode = SslMode::parse(&v)?,
            other => {
                tracing::warn!("ignoring unsupported mysql URL query param: {other}");
            }
        }
    }

    let params = MysqlParams {
        host,
        port,
        database,
        username,
        ssl_mode,
        read_only: false,
    };
    params.validate()?;

    Ok(ParseResult { params, password })
}

fn decode(input: &str) -> AppResult<String> {
    percent_decode_str(input)
        .decode_utf8()
        .map(|cow| cow.into_owned())
        .map_err(|e| AppError::Validation(format!("invalid URL encoding: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_url_parses() {
        let parsed =
            parse_mysql_url("mysql://ana:s%3Acret@db.local:3307/analytics?ssl-mode=required")
                .unwrap();
        assert_eq!(parsed.params.host, "db.local");
        assert_eq!(parsed.params.port, 3307);
        assert_eq!(parsed.params.database, "analytics");
        assert_eq!(parsed.params.username, "ana");
        assert_eq!(parsed.params.ssl_mode, SslMode::Required);
        assert!(!parsed.params.read_only);
        assert_eq!(parsed.password.as_deref(), Some("s:cret"));
    }

    #[test]
    fn mariadb_scheme_accepted() {
        let parsed = parse_mysql_url("mariadb://u@db.local/mydb").unwrap();
        assert_eq!(parsed.params.host, "db.local");
        assert_eq!(parsed.params.database, "mydb");
    }

    #[test]
    fn missing_port_defaults_to_3306() {
        let parsed = parse_mysql_url("mysql://ana@db.local/analytics").unwrap();
        assert_eq!(parsed.params.port, 3306);
        assert!(parsed.password.is_none());
    }

    #[test]
    fn url_encoded_credentials_decoded() {
        let parsed = parse_mysql_url("mysql://us%40r:p%2Fss@db.local/analytics").unwrap();
        assert_eq!(parsed.params.username, "us@r");
        assert_eq!(parsed.password.as_deref(), Some("p/ss"));
    }

    #[test]
    fn sslmode_query_param_alias_accepted() {
        let parsed = parse_mysql_url("mysql://u@h/d?sslMode=verify-ca").unwrap();
        assert_eq!(parsed.params.ssl_mode, SslMode::VerifyCa);
    }

    #[test]
    fn unknown_scheme_rejected() {
        let err = parse_mysql_url("postgresql://u@h/d").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn unknown_ssl_mode_rejected() {
        let err = parse_mysql_url("mysql://u@h/d?ssl-mode=allow").unwrap_err();
        match err {
            AppError::Validation(msg) => assert!(msg.contains("verify-identity")),
            other => panic!("expected validation error, got {other:?}"),
        }
    }

    #[test]
    fn empty_database_path_rejected() {
        let err = parse_mysql_url("mysql://u@db.local/").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn malformed_url_rejected() {
        let err = parse_mysql_url("not-a-url").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn empty_input_rejected() {
        let err = parse_mysql_url("   ").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    // -----------------------------------------------------------------------
    // §24.2 additional coverage
    // -----------------------------------------------------------------------

    #[test]
    fn missing_username_rejected() {
        // URL without user part should be rejected.
        let err = parse_mysql_url("mysql://db.local/mydb").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn sslmode_camelcase_alias_accepted() {
        // sslMode (camelCase) should be accepted.
        let parsed = parse_mysql_url("mysql://u@h/d?sslMode=required").unwrap();
        assert_eq!(parsed.params.ssl_mode, SslMode::Required);
    }

    #[test]
    fn unknown_query_params_are_ignored() {
        // Unknown query params should not cause an error (just warn).
        let parsed = parse_mysql_url("mysql://u@h/d?charset=utf8&connect_timeout=10").unwrap();
        assert_eq!(parsed.params.ssl_mode, SslMode::Preferred); // default
    }

    #[test]
    fn verify_identity_ssl_mode_accepted() {
        let parsed = parse_mysql_url("mysql://u@h/d?ssl-mode=verify-identity").unwrap();
        assert_eq!(parsed.params.ssl_mode, SslMode::VerifyIdentity);
    }

    #[test]
    fn verify_ca_ssl_mode_accepted() {
        let parsed = parse_mysql_url("mysql://u@h/d?ssl-mode=verify_ca").unwrap();
        assert_eq!(parsed.params.ssl_mode, SslMode::VerifyCa);
    }

    #[test]
    fn no_password_yields_none() {
        let parsed = parse_mysql_url("mysql://user@db.local/mydb").unwrap();
        assert!(parsed.password.is_none());
    }

    #[test]
    fn numeric_host_is_valid() {
        let parsed = parse_mysql_url("mysql://u@127.0.0.1/db").unwrap();
        assert_eq!(parsed.params.host, "127.0.0.1");
        assert_eq!(parsed.params.port, 3306);
    }

    #[test]
    fn special_chars_in_database_name_decoded() {
        // Database name with URL-encoded characters.
        let parsed = parse_mysql_url("mysql://u@h/my%2Ddb").unwrap();
        assert_eq!(parsed.params.database, "my-db");
    }
}
