use percent_encoding::percent_decode_str;
use url::Url;

use crate::error::{AppError, AppResult};
use crate::modules::postgres::params::{PostgresParams, SslMode};

#[derive(Debug, Clone)]
pub struct ParsedUrl {
    pub params: PostgresParams,
    pub password: Option<String>,
}

pub fn parse_postgres_url(input: &str) -> AppResult<ParsedUrl> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("URL must not be empty".into()));
    }

    let url =
        Url::parse(trimmed).map_err(|e| AppError::Validation(format!("malformed URL: {e}")))?;

    match url.scheme() {
        "postgres" | "postgresql" => {}
        other => {
            return Err(AppError::Validation(format!(
                "unsupported URL scheme '{other}'; expected postgres:// or postgresql://"
            )));
        }
    }

    let host = url
        .host_str()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| AppError::Validation("URL is missing a host".into()))?
        .to_string();

    let port = url.port().unwrap_or(5432);
    if port == 0 {
        return Err(AppError::Validation("port must be in [1, 65535]".into()));
    }

    let database = {
        let path = url.path();
        let stripped = path.strip_prefix('/').unwrap_or(path);
        if stripped.is_empty() {
            return Err(AppError::Validation(
                "URL is missing a database path component (postgresql://host/<dbname>)".into(),
            ));
        }
        decode(stripped)?
    };

    let username = if url.username().is_empty() {
        return Err(AppError::Validation(
            "URL is missing a username (postgresql://<user>@host/db)".into(),
        ));
    } else {
        decode(url.username())?
    };

    let password = match url.password() {
        Some(p) => Some(decode(p)?),
        None => None,
    };

    let mut sslmode = SslMode::Prefer;
    let mut application_name: Option<String> = None;

    for (k, v) in url.query_pairs() {
        let key = k.to_ascii_lowercase();
        match key.as_str() {
            "sslmode" => sslmode = SslMode::parse(&v)?,
            "application_name" => {
                let v = v.to_string();
                if v.trim().is_empty() {
                    return Err(AppError::Validation(
                        "application_name in URL must not be empty".into(),
                    ));
                }
                application_name = Some(v);
            }
            other => {
                tracing::warn!("ignoring unsupported postgres URL query param: {other}");
            }
        }
    }

    let params = PostgresParams {
        host,
        port,
        database,
        username,
        sslmode,
        application_name,
        read_only: false,
    };
    params.validate()?;

    Ok(ParsedUrl { params, password })
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
        let parsed = parse_postgres_url(
            "postgresql://ana:s3cret@db.local:5433/analytics?sslmode=require&application_name=argus",
        )
        .unwrap();
        assert_eq!(parsed.params.host, "db.local");
        assert_eq!(parsed.params.port, 5433);
        assert_eq!(parsed.params.database, "analytics");
        assert_eq!(parsed.params.username, "ana");
        assert_eq!(parsed.params.sslmode, SslMode::Require);
        assert_eq!(parsed.params.application_name.as_deref(), Some("argus"));
        assert!(!parsed.params.read_only);
        assert_eq!(parsed.password.as_deref(), Some("s3cret"));
    }

    #[test]
    fn missing_port_defaults_to_5432() {
        let parsed = parse_postgres_url("postgresql://ana@db.local/analytics").unwrap();
        assert_eq!(parsed.params.port, 5432);
        assert!(parsed.password.is_none());
    }

    #[test]
    fn url_encoded_credentials_decoded() {
        let parsed = parse_postgres_url("postgresql://us%40r:p%2Fss@db.local/analytics").unwrap();
        assert_eq!(parsed.params.username, "us@r");
        assert_eq!(parsed.password.as_deref(), Some("p/ss"));
    }

    #[test]
    fn malformed_url_rejected() {
        let err = parse_postgres_url("not-a-url").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn unknown_sslmode_rejected() {
        let err = parse_postgres_url("postgresql://u@h/d?sslmode=allow").unwrap_err();
        match err {
            AppError::Validation(msg) => assert!(msg.contains("verify-full")),
            other => panic!("expected validation error, got {other:?}"),
        }
    }

    #[test]
    fn unsupported_scheme_rejected() {
        let err = parse_postgres_url("mysql://u@h/d").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn missing_username_rejected() {
        let err = parse_postgres_url("postgresql://db.local/analytics").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn missing_database_rejected() {
        let err = parse_postgres_url("postgresql://u@db.local/").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn alias_postgres_scheme_accepted() {
        let parsed = parse_postgres_url("postgres://u@h/d").unwrap();
        assert_eq!(parsed.params.host, "h");
    }

    #[test]
    fn empty_input_rejected() {
        let err = parse_postgres_url("   ").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }
}
