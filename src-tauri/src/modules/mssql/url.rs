//! URL and connection-string parsers for MS SQL Server.
//!
//! Accepted input forms:
//! - `mssql://user:pw@host:port/database?encrypt=on&...`
//! - `sqlserver://user:pw@host:port/database?encrypt=on&...`
//! - `microsoftsqlserver://user:pw@host[:port]/database?...` (TablePlus export)
//! - `jdbc:sqlserver://host:port;databaseName=foo;user=bar;password=baz`
//! - ADO.NET key=value connection string:
//!   `Server=tcp:host,1433;Database=foo;User Id=sa;Password=pw;Encrypt=true`

use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::error::{AppError, AppResult};
use crate::modules::mssql::params::{ApplicationIntent, EncryptMode, MssqlParams};

// ---------------------------------------------------------------------------
// ParseUrlResult
// ---------------------------------------------------------------------------

/// Result of parsing a connection URL or connection string.
///
/// The password is returned separately because it must not be stored in
/// `MssqlParams` (it lives in the OS keychain).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseUrlResult {
    pub params: MssqlParams,
    pub password: Option<String>,
}

// ---------------------------------------------------------------------------
// Auto-detect dispatcher
// ---------------------------------------------------------------------------

/// Auto-detect and parse any MS SQL Server connection string.
///
/// Detection rules (first match wins):
/// - Starts with `mssql://`, `sqlserver://`, `microsoftsqlserver://`, or `jdbc:` → URL parser
/// - Otherwise → ADO.NET key=value parser
pub fn parse_any(input: &str) -> AppResult<ParseUrlResult> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(
            "connection string must not be empty".into(),
        ));
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("mssql://")
        || lower.starts_with("sqlserver://")
        || lower.starts_with("microsoftsqlserver://")
        || lower.starts_with("jdbc:")
    {
        parse_mssql_url(trimmed)
    } else {
        parse_adonet_connection_string(trimmed)
    }
}

// ---------------------------------------------------------------------------
// URL parser  (mssql://, sqlserver://, jdbc:sqlserver://)
// ---------------------------------------------------------------------------

/// Parse an `mssql://`, `sqlserver://`, `microsoftsqlserver://`, or `jdbc:sqlserver://` URL.
///
/// Supported query parameters (case-insensitive, kebab/camel/underscore forms
/// accepted):
/// - `encrypt` → [`EncryptMode`]
/// - `trustServerCertificate` / `trust-server-certificate` / `trust_server_certificate` → bool
/// - `applicationIntent` / `application-intent` → [`ApplicationIntent`]
/// - `instanceName` / `instance-name` / `instance` → instance_name
/// - `readOnly` / `read-only` → read_only
///
/// For JDBC, the semicolon-property form is also handled:
/// `jdbc:sqlserver://host:port;databaseName=foo;user=bar;password=baz`
pub fn parse_mssql_url(input: &str) -> AppResult<ParseUrlResult> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("URL must not be empty".into()));
    }

    // Strip the `jdbc:` prefix so the rest looks like a standard URL.
    // Then split on the first `;` to separate the URL base from JDBC properties.
    let (url_part, jdbc_props_str) = if trimmed
        .to_ascii_lowercase()
        .starts_with("jdbc:")
    {
        let without_jdbc = &trimmed["jdbc:".len()..];
        match without_jdbc.find(';') {
            Some(pos) => (&without_jdbc[..pos], Some(&without_jdbc[pos + 1..])),
            None => (without_jdbc, None),
        }
    } else {
        // Non-JDBC URL — check for semicolon-style props that some tools append
        match trimmed.find(';') {
            Some(pos) => (&trimmed[..pos], Some(&trimmed[pos + 1..])),
            None => (trimmed, None),
        }
    };

    let url = Url::parse(url_part)
        .map_err(|e| AppError::Validation(format!("malformed URL: {e}")))?;

    match url.scheme() {
        "mssql" | "sqlserver" | "microsoftsqlserver" => {}
        other => {
            return Err(AppError::Validation(format!(
                "unsupported URL scheme '{other}'; expected mssql://, sqlserver://, microsoftsqlserver://, or jdbc:sqlserver://"
            )));
        }
    }

    let host = url
        .host_str()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| AppError::Validation("URL is missing a host".into()))?
        .to_string();

    let port = url.port().unwrap_or(1433);
    if port == 0 {
        return Err(AppError::Validation("port must be in [1, 65535]".into()));
    }

    // Database is the path component (strip leading `/`)
    let database_from_path = {
        let path = url.path();
        let stripped = path.strip_prefix('/').unwrap_or(path);
        if stripped.is_empty() {
            None
        } else {
            Some(decode(stripped)?)
        }
    };

    let username_from_url = if url.username().is_empty() {
        None
    } else {
        Some(decode(url.username())?)
    };

    let password_from_url = match url.password() {
        Some(p) => Some(decode(p)?),
        None => None,
    };

    // Defaults before applying query params
    let mut encrypt = EncryptMode::On;
    let mut trust_server_certificate = false;
    let mut application_intent: Option<ApplicationIntent> = None;
    let mut instance_name: Option<String> = None;
    let mut read_only = false;
    let mut database: Option<String> = database_from_path;
    let mut username: Option<String> = username_from_url;
    let mut password: Option<String> = password_from_url;

    // Apply query params from the URL
    for (k, v) in url.query_pairs() {
        apply_url_param(
            k.as_ref(),
            v.as_ref(),
            &mut encrypt,
            &mut trust_server_certificate,
            &mut application_intent,
            &mut instance_name,
            &mut read_only,
            &mut database,
            &mut username,
            &mut password,
        )?;
    }

    // Apply JDBC semicolon-style properties if present
    if let Some(props) = jdbc_props_str {
        for segment in props.split(';') {
            let segment = segment.trim();
            if segment.is_empty() {
                continue;
            }
            if let Some(eq_pos) = segment.find('=') {
                let k = segment[..eq_pos].trim();
                let v = segment[eq_pos + 1..].trim();
                apply_url_param(
                    k,
                    v,
                    &mut encrypt,
                    &mut trust_server_certificate,
                    &mut application_intent,
                    &mut instance_name,
                    &mut read_only,
                    &mut database,
                    &mut username,
                    &mut password,
                )?;
            } else {
                tracing::warn!(
                    "ignoring malformed JDBC property segment (no '='): {}",
                    segment
                );
            }
        }
    }

    let host_final = host;
    let database_final = database.ok_or_else(|| {
        AppError::Validation("database is required (supply as path or databaseName param)".into())
    })?;
    let username_final = username.ok_or_else(|| {
        AppError::Validation(
            "username is required (supply in URL or as user= param)".into(),
        )
    })?;

    let params = MssqlParams {
        host: host_final,
        port,
        database: database_final,
        username: username_final,
        encrypt,
        trust_server_certificate,
        read_only,
        instance_name,
        application_intent,
    };
    params.validate()?;

    Ok(ParseUrlResult { params, password })
}

/// Apply a single key=value pair from a URL query param or JDBC property.
#[allow(clippy::too_many_arguments)]
fn apply_url_param(
    key: &str,
    value: &str,
    encrypt: &mut EncryptMode,
    trust_server_certificate: &mut bool,
    application_intent: &mut Option<ApplicationIntent>,
    instance_name: &mut Option<String>,
    read_only: &mut bool,
    database: &mut Option<String>,
    username: &mut Option<String>,
    password: &mut Option<String>,
) -> AppResult<()> {
    let k = key.to_ascii_lowercase().replace('-', "_");
    match k.as_str() {
        "encrypt" => *encrypt = EncryptMode::parse(value)?,
        "trustservercertificate" | "trust_server_certificate" => {
            *trust_server_certificate = parse_bool(value)?;
        }
        "applicationintent" | "application_intent" => {
            *application_intent = Some(ApplicationIntent::parse(value)?);
        }
        "instancename" | "instance_name" | "instance" => {
            *instance_name = Some(value.to_string());
        }
        "readonly" | "read_only" => {
            *read_only = parse_bool(value)?;
        }
        // JDBC-style synonyms for database / user / password
        "databasename" | "database" | "initial_catalog" | "initialcatalog" => {
            *database = Some(value.to_string());
        }
        "user" | "uid" | "username" | "user_id" | "userid" => {
            *username = Some(value.to_string());
        }
        "password" | "pwd" => {
            *password = Some(value.to_string());
        }
        // TablePlus-specific: tLSMode encodes encryption posture.
        //   0 → no TLS (Off)
        //   1 → TLS preferred/lenient (On + trust_server_certificate=true)
        //   2 → TLS required/strict   (On + trust_server_certificate=false)
        // Other values are ignored with a warning.
        "tlsmode" => match value.trim() {
            "0" => *encrypt = EncryptMode::Off,
            "1" => {
                *encrypt = EncryptMode::On;
                *trust_server_certificate = true;
            }
            "2" => {
                *encrypt = EncryptMode::On;
                *trust_server_certificate = false;
            }
            other => tracing::warn!("ignoring unknown tLSMode value: {}", other),
        },
        other => {
            tracing::warn!(
                "ignoring unsupported mssql URL query param: {}",
                other
            );
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// ADO.NET connection-string parser
// ---------------------------------------------------------------------------

/// Parse an ADO.NET-style key=value connection string.
///
/// Keys are case-insensitive; the following synonyms are supported:
/// - `server` / `data source` / `addr` / `address` / `network address` → host:port
/// - `database` / `initial catalog` → database
/// - `user id` / `uid` / `user` → username
/// - `password` / `pwd` → password
/// - `encrypt` → EncryptMode
/// - `trustservercertificate` / `trust server certificate` → bool
/// - `applicationintent` / `application intent` → ApplicationIntent
/// - `instancename` → instance_name
/// - `readonly` / `read only` → read_only
///
/// Server field parsing:
/// - `tcp:host,1433` → strip `tcp:`, split on `,` for port
/// - `host\INSTANCE` → split on `\` for instance_name
///
/// Unknown keys produce a `tracing::warn!` but do not fail.
pub fn parse_adonet_connection_string(input: &str) -> AppResult<ParseUrlResult> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(
            "connection string must not be empty".into(),
        ));
    }

    let mut host: Option<String> = None;
    let mut port: Option<u16> = None;
    let mut database: Option<String> = None;
    let mut username: Option<String> = None;
    let mut password: Option<String> = None;
    let mut encrypt = EncryptMode::On;
    let mut trust_server_certificate = false;
    let mut application_intent: Option<ApplicationIntent> = None;
    let mut instance_name: Option<String> = None;
    let mut read_only = false;

    for segment in trimmed.split(';') {
        let segment = segment.trim();
        if segment.is_empty() {
            continue;
        }
        let eq_pos = match segment.find('=') {
            Some(p) => p,
            None => {
                tracing::warn!(
                    "ignoring malformed ADO.NET connection string segment (no '='): {}",
                    segment
                );
                continue;
            }
        };
        let raw_key = segment[..eq_pos].trim();
        let value = segment[eq_pos + 1..].trim();
        // Normalise key: lowercase + collapse spaces to single space
        let key_norm: String = raw_key
            .to_ascii_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        match key_norm.as_str() {
            "server" | "data source" | "addr" | "address" | "network address" => {
                let (h, p, inst) = parse_server_value(value);
                host = Some(h);
                if let Some(p_val) = p {
                    port = Some(p_val);
                }
                if let Some(inst_val) = inst {
                    // only set if not already set by explicit instanceName key
                    if instance_name.is_none() {
                        instance_name = Some(inst_val);
                    }
                }
            }
            "database" | "initial catalog" => {
                database = Some(value.to_string());
            }
            "user id" | "uid" | "user" => {
                username = Some(value.to_string());
            }
            "password" | "pwd" => {
                password = Some(value.to_string());
            }
            "encrypt" => {
                encrypt = EncryptMode::parse(value)?;
            }
            "trustservercertificate" | "trust server certificate" => {
                trust_server_certificate = parse_bool(value)?;
            }
            "applicationintent" | "application intent" => {
                application_intent = Some(ApplicationIntent::parse(value)?);
            }
            "instancename" | "instance name" => {
                instance_name = Some(value.to_string());
            }
            "readonly" | "read only" | "applicationreadonly" => {
                read_only = parse_bool(value)?;
            }
            // Common but unsupported keys — tolerated silently with a warning
            "connect timeout"
            | "connection timeout"
            | "login timeout"
            | "connection lifetime"
            | "min pool size"
            | "max pool size"
            | "pooling"
            | "packet size"
            | "persist security info"
            | "integrated security"
            | "workstation id"
            | "application name"
            | "failover partner"
            | "multisubnetfailover"
            | "multipleactiveresultsets"
            | "attachdbfilename"
            | "current language"
            | "column encryption setting"
            | "attestation protocol"
            | "enclave attestation url"
            | "trust server certificate ca" => {
                tracing::warn!(
                    "ignoring unsupported/unneeded ADO.NET connection string key: {}",
                    raw_key
                );
            }
            other => {
                tracing::warn!(
                    "ignoring unknown ADO.NET connection string key: {}",
                    other
                );
            }
        }
    }

    let host_final = host.ok_or_else(|| {
        AppError::Validation(
            "connection string is missing a server / host (e.g. Server=myserver)".into(),
        )
    })?;
    let database_final = database.ok_or_else(|| {
        AppError::Validation(
            "connection string is missing a database (e.g. Database=mydb or Initial Catalog=mydb)"
                .into(),
        )
    })?;
    let username_final = username.ok_or_else(|| {
        AppError::Validation(
            "connection string is missing a username (e.g. User Id=sa or Uid=sa)".into(),
        )
    })?;

    let port_final = port.unwrap_or(1433);
    if port_final == 0 {
        return Err(AppError::Validation("port must be in [1, 65535]".into()));
    }

    let params = MssqlParams {
        host: host_final,
        port: port_final,
        database: database_final,
        username: username_final,
        encrypt,
        trust_server_certificate,
        read_only,
        instance_name,
        application_intent,
    };
    params.validate()?;

    Ok(ParseUrlResult { params, password })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Parse the `Server=` value which may be in any of these forms:
/// - `tcp:host,1433`
/// - `host,1433`
/// - `host\INSTANCE`
/// - `tcp:host\INSTANCE,1433`
/// - `host`
///
/// Returns `(host, Option<port>, Option<instance_name>)`.
fn parse_server_value(value: &str) -> (String, Option<u16>, Option<String>) {
    // Strip optional `tcp:` prefix
    let v = value
        .strip_prefix("tcp:")
        .unwrap_or(value)
        .trim();

    // Split on `\` first (before the comma) to extract an instance name
    let (host_and_port, inst) = if let Some(bs_pos) = v.find('\\') {
        let h = &v[..bs_pos];
        let rest = &v[bs_pos + 1..];
        // The rest might be `INSTANCE` or `INSTANCE,PORT`
        if let Some(comma_pos) = rest.find(',') {
            let inst_part = &rest[..comma_pos];
            let port_part = &rest[comma_pos + 1..];
            (
                format!("{},{}", h, port_part),
                Some(inst_part.to_string()),
            )
        } else {
            (h.to_string(), Some(rest.to_string()))
        }
    } else {
        (v.to_string(), None)
    };

    // Now split host_and_port on `,` to extract port
    let (host, port_opt) = if let Some(comma_pos) = host_and_port.find(',') {
        let h = host_and_port[..comma_pos].trim().to_string();
        let p_str = host_and_port[comma_pos + 1..].trim();
        let p: Option<u16> = p_str.parse().ok();
        (h, p)
    } else {
        (host_and_port.trim().to_string(), None)
    };

    (host, port_opt, inst)
}

/// Parse a truthy/falsy string.
fn parse_bool(s: &str) -> AppResult<bool> {
    match s.to_ascii_lowercase().as_str() {
        "true" | "yes" | "1" | "on" => Ok(true),
        "false" | "no" | "0" | "off" => Ok(false),
        other => Err(AppError::Validation(format!(
            "expected true/false, got '{other}'"
        ))),
    }
}

/// Percent-decode a URL component.
fn decode(input: &str) -> AppResult<String> {
    percent_decode_str(input)
        .decode_utf8()
        .map(|cow| cow.into_owned())
        .map_err(|e| AppError::Validation(format!("invalid URL encoding: {e}")))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // parse_mssql_url
    // -----------------------------------------------------------------------

    #[test]
    fn mssql_scheme_full_url_parses() {
        let r = parse_mssql_url("mssql://sa:s3cr3t@db.local:1433/AdventureWorks?encrypt=on")
            .unwrap();
        assert_eq!(r.params.host, "db.local");
        assert_eq!(r.params.port, 1433);
        assert_eq!(r.params.database, "AdventureWorks");
        assert_eq!(r.params.username, "sa");
        assert_eq!(r.params.encrypt, EncryptMode::On);
        assert_eq!(r.password.as_deref(), Some("s3cr3t"));
    }

    #[test]
    fn sqlserver_scheme_accepted() {
        let r = parse_mssql_url("sqlserver://sa@db.local/mydb").unwrap();
        assert_eq!(r.params.host, "db.local");
        assert_eq!(r.params.database, "mydb");
    }

    #[test]
    fn jdbc_prefix_stripped() {
        let r = parse_mssql_url(
            "jdbc:sqlserver://db.local:1433;databaseName=AdventureWorks;user=sa;password=pw",
        )
        .unwrap();
        assert_eq!(r.params.host, "db.local");
        assert_eq!(r.params.port, 1433);
        assert_eq!(r.params.database, "AdventureWorks");
        assert_eq!(r.params.username, "sa");
        assert_eq!(r.password.as_deref(), Some("pw"));
    }

    #[test]
    fn default_port_is_1433() {
        let r = parse_mssql_url("mssql://sa@db.local/mydb").unwrap();
        assert_eq!(r.params.port, 1433);
    }

    #[test]
    fn url_encoded_credentials_decoded() {
        let r =
            parse_mssql_url("mssql://us%40r:p%40ss@db.local/mydb").unwrap();
        assert_eq!(r.params.username, "us@r");
        assert_eq!(r.password.as_deref(), Some("p@ss"));
    }

    #[test]
    fn trust_server_certificate_param() {
        let r = parse_mssql_url(
            "mssql://sa@db.local/mydb?trustServerCertificate=true",
        )
        .unwrap();
        assert!(r.params.trust_server_certificate);
    }

    #[test]
    fn trust_server_certificate_underscore_param() {
        let r = parse_mssql_url(
            "mssql://sa@db.local/mydb?trust_server_certificate=true",
        )
        .unwrap();
        assert!(r.params.trust_server_certificate);
    }

    #[test]
    fn application_intent_param() {
        let r = parse_mssql_url(
            "mssql://sa@db.local/mydb?applicationIntent=ReadOnly",
        )
        .unwrap();
        assert_eq!(r.params.application_intent, Some(ApplicationIntent::ReadOnly));
    }

    #[test]
    fn instance_name_param() {
        let r = parse_mssql_url(
            "mssql://sa@db.local/mydb?instanceName=SQLEXPRESS",
        )
        .unwrap();
        assert_eq!(r.params.instance_name.as_deref(), Some("SQLEXPRESS"));
    }

    #[test]
    fn encrypt_off_param() {
        let r = parse_mssql_url("mssql://sa@db.local/mydb?encrypt=off").unwrap();
        assert_eq!(r.params.encrypt, EncryptMode::Off);
    }

    #[test]
    fn unknown_query_params_do_not_fail() {
        // Unknown params should warn but not error
        let r = parse_mssql_url(
            "mssql://sa@db.local/mydb?connectTimeout=30&charset=utf8",
        )
        .unwrap();
        assert_eq!(r.params.host, "db.local");
    }

    #[test]
    fn jdbc_trailing_props_form() {
        let r = parse_mssql_url(
            "jdbc:sqlserver://localhost:1433;databaseName=TestDB;user=sa;password=Secret1;encrypt=false;trustServerCertificate=true",
        ).unwrap();
        assert_eq!(r.params.host, "localhost");
        assert_eq!(r.params.database, "TestDB");
        assert_eq!(r.params.username, "sa");
        assert_eq!(r.password.as_deref(), Some("Secret1"));
        assert_eq!(r.params.encrypt, EncryptMode::Off);
        assert!(r.params.trust_server_certificate);
    }

    #[test]
    fn missing_database_fails() {
        // No path, no databaseName param
        let err = parse_mssql_url("mssql://sa@db.local/").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn missing_username_fails() {
        let err = parse_mssql_url("mssql://db.local/mydb").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn unsupported_scheme_rejected() {
        let err = parse_mssql_url("postgresql://sa@db.local/mydb").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn empty_input_rejected() {
        let err = parse_mssql_url("   ").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn malformed_url_rejected() {
        let err = parse_mssql_url("not-a-url").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn no_password_yields_none() {
        let r = parse_mssql_url("mssql://sa@db.local/mydb").unwrap();
        assert!(r.password.is_none());
    }

    // -----------------------------------------------------------------------
    // microsoftsqlserver:// (TablePlus export form)
    // -----------------------------------------------------------------------

    #[test]
    fn microsoftsqlserver_scheme_accepted() {
        let r = parse_mssql_url(
            "microsoftsqlserver://sa:s3cr3t@localhost/bhp_api",
        )
        .unwrap();
        assert_eq!(r.params.host, "localhost");
        assert_eq!(r.params.port, 1433);
        assert_eq!(r.params.database, "bhp_api");
        assert_eq!(r.params.username, "sa");
        assert_eq!(r.password.as_deref(), Some("s3cr3t"));
    }

    #[test]
    fn tableplus_export_full_url_parses() {
        // Real-world URL as exported by TablePlus: scheme is microsoftsqlserver,
        // no port (defaults to 1433), tLSMode=0 (no TLS), and a pile of vendor
        // params (statusColor, env, name, usePrivateKey, safeModeLevel, ...)
        // that should be silently ignored.
        let r = parse_mssql_url(
            "microsoftsqlserver://sa:YourStrong!Passw0rd@localhost/bhp_api?statusColor=686B6F&env=&name=New%20Connection&tLSMode=0&usePrivateKey=false&safeModeLevel=0&advancedSafeModeLevel=0&driverVersion=6",
        )
        .unwrap();
        assert_eq!(r.params.host, "localhost");
        assert_eq!(r.params.port, 1433);
        assert_eq!(r.params.database, "bhp_api");
        assert_eq!(r.params.username, "sa");
        assert_eq!(r.password.as_deref(), Some("YourStrong!Passw0rd"));
        // tLSMode=0 → EncryptMode::Off (no TLS, matches the TablePlus posture)
        assert_eq!(r.params.encrypt, EncryptMode::Off);
        assert!(!r.params.trust_server_certificate);
    }

    #[test]
    fn parse_any_auto_detects_microsoftsqlserver_scheme() {
        let r = parse_any("microsoftsqlserver://sa:pw@localhost/db").unwrap();
        assert_eq!(r.params.host, "localhost");
        assert_eq!(r.params.database, "db");
    }

    #[test]
    fn tls_mode_0_maps_to_off() {
        let r = parse_mssql_url("mssql://sa@db.local/mydb?tLSMode=0").unwrap();
        assert_eq!(r.params.encrypt, EncryptMode::Off);
        assert!(!r.params.trust_server_certificate);
    }

    #[test]
    fn tls_mode_1_maps_to_on_with_trust_cert() {
        let r = parse_mssql_url("mssql://sa@db.local/mydb?tLSMode=1").unwrap();
        assert_eq!(r.params.encrypt, EncryptMode::On);
        assert!(r.params.trust_server_certificate);
    }

    #[test]
    fn tls_mode_2_maps_to_on_strict() {
        let r = parse_mssql_url("mssql://sa@db.local/mydb?tLSMode=2").unwrap();
        assert_eq!(r.params.encrypt, EncryptMode::On);
        assert!(!r.params.trust_server_certificate);
    }

    #[test]
    fn tls_mode_unknown_is_warn_and_keep_default() {
        let r = parse_mssql_url("mssql://sa@db.local/mydb?tLSMode=99").unwrap();
        // Default encrypt stays On (the documented v1 default)
        assert_eq!(r.params.encrypt, EncryptMode::On);
        assert!(!r.params.trust_server_certificate);
    }

    // -----------------------------------------------------------------------
    // parse_adonet_connection_string
    // -----------------------------------------------------------------------

    #[test]
    fn adonet_basic_parses() {
        let r = parse_adonet_connection_string(
            "Server=tcp:db.local,1433;Database=mydb;User Id=sa;Password=pw;Encrypt=true",
        )
        .unwrap();
        assert_eq!(r.params.host, "db.local");
        assert_eq!(r.params.port, 1433);
        assert_eq!(r.params.database, "mydb");
        assert_eq!(r.params.username, "sa");
        assert_eq!(r.params.encrypt, EncryptMode::On);
        assert_eq!(r.password.as_deref(), Some("pw"));
    }

    #[test]
    fn adonet_data_source_synonym() {
        let r = parse_adonet_connection_string(
            "Data Source=sql.example.com;Initial Catalog=testdb;Uid=user1;Pwd=pass",
        )
        .unwrap();
        assert_eq!(r.params.host, "sql.example.com");
        assert_eq!(r.params.database, "testdb");
        assert_eq!(r.params.username, "user1");
        assert_eq!(r.password.as_deref(), Some("pass"));
    }

    #[test]
    fn adonet_addr_synonym() {
        let r = parse_adonet_connection_string(
            "Addr=myserver;Database=d;User=u;Password=p",
        )
        .unwrap();
        assert_eq!(r.params.host, "myserver");
    }

    #[test]
    fn adonet_address_synonym() {
        let r = parse_adonet_connection_string(
            "Address=myserver;Database=d;Uid=u;Password=p",
        )
        .unwrap();
        assert_eq!(r.params.host, "myserver");
    }

    #[test]
    fn adonet_network_address_synonym() {
        let r = parse_adonet_connection_string(
            "Network Address=myserver;Database=d;Uid=u;Password=p",
        )
        .unwrap();
        assert_eq!(r.params.host, "myserver");
    }

    #[test]
    fn adonet_initial_catalog_synonym() {
        let r = parse_adonet_connection_string(
            "Server=myserver;Initial Catalog=mydb;User Id=sa;Password=pw",
        )
        .unwrap();
        assert_eq!(r.params.database, "mydb");
    }

    #[test]
    fn adonet_uid_synonym() {
        let r = parse_adonet_connection_string(
            "Server=myserver;Database=d;Uid=u;Password=p",
        )
        .unwrap();
        assert_eq!(r.params.username, "u");
    }

    #[test]
    fn adonet_user_synonym() {
        let r = parse_adonet_connection_string(
            "Server=myserver;Database=d;User=u;Password=p",
        )
        .unwrap();
        assert_eq!(r.params.username, "u");
    }

    #[test]
    fn adonet_pwd_synonym() {
        let r = parse_adonet_connection_string(
            "Server=myserver;Database=d;User Id=u;Pwd=secret",
        )
        .unwrap();
        assert_eq!(r.password.as_deref(), Some("secret"));
    }

    #[test]
    fn adonet_server_with_port_comma() {
        let r = parse_adonet_connection_string(
            "Server=db.local,5433;Database=d;User Id=u;Password=p",
        )
        .unwrap();
        assert_eq!(r.params.host, "db.local");
        assert_eq!(r.params.port, 5433);
    }

    #[test]
    fn adonet_server_tcp_prefix_stripped() {
        let r = parse_adonet_connection_string(
            "Server=tcp:db.local,1433;Database=d;User Id=u;Password=p",
        )
        .unwrap();
        assert_eq!(r.params.host, "db.local");
        assert_eq!(r.params.port, 1433);
    }

    #[test]
    fn adonet_server_backslash_instance() {
        let r = parse_adonet_connection_string(
            "Server=db.local\\SQLEXPRESS;Database=d;User Id=u;Password=p",
        )
        .unwrap();
        assert_eq!(r.params.host, "db.local");
        assert_eq!(r.params.instance_name.as_deref(), Some("SQLEXPRESS"));
    }

    #[test]
    fn adonet_trust_server_certificate() {
        let r = parse_adonet_connection_string(
            "Server=s;Database=d;User Id=u;Password=p;TrustServerCertificate=true",
        )
        .unwrap();
        assert!(r.params.trust_server_certificate);
    }

    #[test]
    fn adonet_trust_server_certificate_spaced_key() {
        let r = parse_adonet_connection_string(
            "Server=s;Database=d;User Id=u;Password=p;Trust Server Certificate=yes",
        )
        .unwrap();
        assert!(r.params.trust_server_certificate);
    }

    #[test]
    fn adonet_application_intent() {
        let r = parse_adonet_connection_string(
            "Server=s;Database=d;User Id=u;Password=p;ApplicationIntent=ReadOnly",
        )
        .unwrap();
        assert_eq!(r.params.application_intent, Some(ApplicationIntent::ReadOnly));
    }

    #[test]
    fn adonet_unknown_keys_tolerated() {
        // e.g. TablePlus adds statusColor, driverVersion, etc.
        let r = parse_adonet_connection_string(
            "Server=s;Database=d;User Id=u;Password=p;statusColor=686B6F;driverVersion=6",
        )
        .unwrap();
        assert_eq!(r.params.host, "s");
    }

    #[test]
    fn adonet_connect_timeout_ignored() {
        let r = parse_adonet_connection_string(
            "Server=s;Database=d;User Id=u;Password=p;Connect Timeout=30",
        )
        .unwrap();
        assert_eq!(r.params.host, "s");
    }

    #[test]
    fn adonet_case_insensitive_keys() {
        let r = parse_adonet_connection_string(
            "SERVER=s;DATABASE=d;USER ID=u;PASSWORD=p",
        )
        .unwrap();
        assert_eq!(r.params.host, "s");
        assert_eq!(r.params.database, "d");
        assert_eq!(r.params.username, "u");
    }

    #[test]
    fn adonet_missing_server_fails() {
        let err = parse_adonet_connection_string(
            "Database=d;User Id=u;Password=p",
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn adonet_missing_database_fails() {
        let err = parse_adonet_connection_string(
            "Server=s;User Id=u;Password=p",
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn adonet_missing_user_fails() {
        let err = parse_adonet_connection_string(
            "Server=s;Database=d;Password=p",
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn adonet_default_port_is_1433() {
        let r = parse_adonet_connection_string(
            "Server=myserver;Database=d;User Id=u;Password=p",
        )
        .unwrap();
        assert_eq!(r.params.port, 1433);
    }

    #[test]
    fn adonet_encrypt_false() {
        let r = parse_adonet_connection_string(
            "Server=s;Database=d;User Id=u;Password=p;Encrypt=False",
        )
        .unwrap();
        assert_eq!(r.params.encrypt, EncryptMode::Off);
    }

    // -----------------------------------------------------------------------
    // parse_any
    // -----------------------------------------------------------------------

    #[test]
    fn parse_any_detects_mssql_url() {
        let r = parse_any("mssql://sa@db.local/mydb").unwrap();
        assert_eq!(r.params.host, "db.local");
    }

    #[test]
    fn parse_any_detects_sqlserver_url() {
        let r = parse_any("sqlserver://sa@db.local/mydb").unwrap();
        assert_eq!(r.params.host, "db.local");
    }

    #[test]
    fn parse_any_detects_jdbc_url() {
        let r = parse_any(
            "jdbc:sqlserver://db.local:1433;databaseName=mydb;user=sa;password=pw",
        )
        .unwrap();
        assert_eq!(r.params.host, "db.local");
    }

    #[test]
    fn parse_any_detects_adonet() {
        let r = parse_any(
            "Server=db.local;Database=mydb;User Id=sa;Password=pw",
        )
        .unwrap();
        assert_eq!(r.params.host, "db.local");
    }

    #[test]
    fn parse_any_empty_fails() {
        let err = parse_any("  ").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }
}
