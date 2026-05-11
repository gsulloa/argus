use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SslMode {
    Disable,
    Prefer,
    Require,
    #[serde(rename = "verify-ca")]
    VerifyCa,
    #[serde(rename = "verify-full")]
    VerifyFull,
}

impl SslMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SslMode::Disable => "disable",
            SslMode::Prefer => "prefer",
            SslMode::Require => "require",
            SslMode::VerifyCa => "verify-ca",
            SslMode::VerifyFull => "verify-full",
        }
    }

    pub fn parse(input: &str) -> AppResult<Self> {
        match input.to_ascii_lowercase().as_str() {
            "disable" => Ok(SslMode::Disable),
            "prefer" => Ok(SslMode::Prefer),
            "require" => Ok(SslMode::Require),
            "verify-ca" | "verify_ca" | "verifyca" => Ok(SslMode::VerifyCa),
            "verify-full" | "verify_full" | "verifyfull" => Ok(SslMode::VerifyFull),
            other => Err(AppError::Validation(format!(
                "unknown sslmode '{other}'; expected one of: disable, prefer, require, verify-ca, verify-full"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostgresParams {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub sslmode: SslMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_name: Option<String>,
    #[serde(default)]
    pub read_only: bool,
}

impl PostgresParams {
    pub fn validate(&self) -> AppResult<()> {
        if self.host.trim().is_empty() {
            return Err(AppError::Validation("host must not be empty".into()));
        }
        if self.port == 0 {
            return Err(AppError::Validation("port must be in [1, 65535]".into()));
        }
        if self.database.trim().is_empty() {
            return Err(AppError::Validation("database must not be empty".into()));
        }
        if self.username.trim().is_empty() {
            return Err(AppError::Validation("username must not be empty".into()));
        }
        if let Some(app) = self.application_name.as_deref() {
            if app.trim().is_empty() {
                return Err(AppError::Validation(
                    "application_name must not be empty when provided".into(),
                ));
            }
        }
        Ok(())
    }

    pub fn from_json(value: &JsonValue) -> AppResult<Self> {
        serde_json::from_value::<PostgresParams>(value.clone())
            .map_err(|e| AppError::Validation(format!("invalid postgres params: {e}")))
    }

    pub fn to_json(&self) -> AppResult<JsonValue> {
        serde_json::to_value(self).map_err(AppError::from)
    }

    pub fn effective_application_name(&self) -> &str {
        self.application_name.as_deref().unwrap_or("argus")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_params() -> PostgresParams {
        PostgresParams {
            host: "db.local".into(),
            port: 5432,
            database: "analytics".into(),
            username: "ana".into(),
            sslmode: SslMode::Require,
            application_name: Some("argus".into()),
            read_only: false,
        }
    }

    #[test]
    fn valid_params_pass() {
        ok_params().validate().unwrap();
    }

    #[test]
    fn empty_host_fails() {
        let mut p = ok_params();
        p.host = "  ".into();
        assert!(matches!(p.validate(), Err(AppError::Validation(_))));
    }

    #[test]
    fn zero_port_fails() {
        let mut p = ok_params();
        p.port = 0;
        assert!(matches!(p.validate(), Err(AppError::Validation(_))));
    }

    #[test]
    fn empty_database_fails() {
        let mut p = ok_params();
        p.database = "".into();
        assert!(matches!(p.validate(), Err(AppError::Validation(_))));
    }

    #[test]
    fn empty_username_fails() {
        let mut p = ok_params();
        p.username = "".into();
        assert!(matches!(p.validate(), Err(AppError::Validation(_))));
    }

    #[test]
    fn empty_application_name_fails() {
        let mut p = ok_params();
        p.application_name = Some(" ".into());
        assert!(matches!(p.validate(), Err(AppError::Validation(_))));
    }

    #[test]
    fn read_only_defaults_false_in_json() {
        let json = serde_json::json!({
            "host": "h",
            "port": 5432,
            "database": "d",
            "username": "u",
            "sslmode": "disable"
        });
        let p = PostgresParams::from_json(&json).unwrap();
        assert!(!p.read_only);
    }

    #[test]
    fn round_trip_through_json() {
        let p = ok_params();
        let j = p.to_json().unwrap();
        let p2 = PostgresParams::from_json(&j).unwrap();
        assert_eq!(p.host, p2.host);
        assert_eq!(p.port, p2.port);
        assert_eq!(p.sslmode, p2.sslmode);
        assert_eq!(p.application_name, p2.application_name);
        assert_eq!(p.read_only, p2.read_only);
    }

    #[test]
    fn sslmode_parse_known_values() {
        assert_eq!(SslMode::parse("disable").unwrap(), SslMode::Disable);
        assert_eq!(SslMode::parse("PREFER").unwrap(), SslMode::Prefer);
        assert_eq!(SslMode::parse("verify-ca").unwrap(), SslMode::VerifyCa);
        assert_eq!(SslMode::parse("verify-full").unwrap(), SslMode::VerifyFull);
    }

    #[test]
    fn sslmode_parse_unknown_rejected() {
        let err = SslMode::parse("allow").unwrap_err();
        match err {
            AppError::Validation(msg) => {
                assert!(msg.contains("disable"));
                assert!(msg.contains("verify-full"));
            }
            other => panic!("expected validation error, got {other:?}"),
        }
    }
}
