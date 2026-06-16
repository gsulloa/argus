use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    Disabled,
    Preferred,
    Required,
    VerifyCa,
    VerifyIdentity,
}

impl Default for SslMode {
    fn default() -> Self {
        SslMode::Preferred
    }
}

impl SslMode {
    pub fn parse(input: &str) -> AppResult<Self> {
        match input.to_ascii_lowercase().as_str() {
            "disabled" => Ok(SslMode::Disabled),
            "preferred" => Ok(SslMode::Preferred),
            "required" => Ok(SslMode::Required),
            "verify-ca" | "verify_ca" => Ok(SslMode::VerifyCa),
            "verify-identity" | "verify_identity" => Ok(SslMode::VerifyIdentity),
            other => Err(AppError::Validation(format!(
                "unknown ssl-mode '{other}'; expected one of: disabled, preferred, required, verify-ca, verify-identity"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct MysqlParams {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub ssl_mode: SslMode,
    #[serde(default)]
    pub read_only: bool,
}

impl MysqlParams {
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
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_params() -> MysqlParams {
        MysqlParams {
            host: "db.local".into(),
            port: 3306,
            database: "analytics".into(),
            username: "ana".into(),
            ssl_mode: SslMode::Required,
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
        p.host = "".into();
        assert!(matches!(p.validate(), Err(AppError::Validation(_))));
    }

    #[test]
    fn whitespace_host_fails() {
        let mut p = ok_params();
        p.host = "   ".into();
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
    fn sslmode_parse_all_variants() {
        assert_eq!(SslMode::parse("disabled").unwrap(), SslMode::Disabled);
        assert_eq!(SslMode::parse("preferred").unwrap(), SslMode::Preferred);
        assert_eq!(SslMode::parse("required").unwrap(), SslMode::Required);
        assert_eq!(SslMode::parse("verify-ca").unwrap(), SslMode::VerifyCa);
        assert_eq!(SslMode::parse("verify_ca").unwrap(), SslMode::VerifyCa);
        assert_eq!(
            SslMode::parse("verify-identity").unwrap(),
            SslMode::VerifyIdentity
        );
        assert_eq!(
            SslMode::parse("verify_identity").unwrap(),
            SslMode::VerifyIdentity
        );
    }

    #[test]
    fn sslmode_parse_case_insensitive() {
        assert_eq!(SslMode::parse("DISABLED").unwrap(), SslMode::Disabled);
        assert_eq!(SslMode::parse("Preferred").unwrap(), SslMode::Preferred);
        assert_eq!(SslMode::parse("REQUIRED").unwrap(), SslMode::Required);
    }

    #[test]
    fn sslmode_parse_unknown_rejected() {
        let err = SslMode::parse("allow").unwrap_err();
        match err {
            AppError::Validation(msg) => {
                assert!(msg.contains("disabled"));
                assert!(msg.contains("verify-identity"));
            }
            other => panic!("expected validation error, got {other:?}"),
        }
    }

    #[test]
    fn sslmode_default_is_preferred() {
        assert_eq!(SslMode::default(), SslMode::Preferred);
    }

    // -----------------------------------------------------------------------
    // §24.1 additional coverage
    // -----------------------------------------------------------------------

    #[test]
    fn whitespace_database_fails() {
        let mut p = ok_params();
        p.database = "   ".into();
        assert!(matches!(p.validate(), Err(AppError::Validation(_))));
    }

    #[test]
    fn whitespace_username_fails() {
        let mut p = ok_params();
        p.username = "   ".into();
        assert!(matches!(p.validate(), Err(AppError::Validation(_))));
    }

    #[test]
    fn max_port_is_valid() {
        let mut p = ok_params();
        p.port = 65535;
        assert!(p.validate().is_ok());
    }

    #[test]
    fn params_json_round_trip() {
        let p = ok_params();
        let json = serde_json::to_string(&p).unwrap();
        let p2: MysqlParams = serde_json::from_str(&json).unwrap();
        assert_eq!(p.host, p2.host);
        assert_eq!(p.port, p2.port);
        assert_eq!(p.database, p2.database);
        assert_eq!(p.username, p2.username);
        assert_eq!(p.ssl_mode, p2.ssl_mode);
        assert_eq!(p.read_only, p2.read_only);
    }

    #[test]
    fn sslmode_json_round_trip() {
        // All variants round-trip through serde (kebab-case).
        let variants = [
            SslMode::Disabled,
            SslMode::Preferred,
            SslMode::Required,
            SslMode::VerifyCa,
            SslMode::VerifyIdentity,
        ];
        for v in &variants {
            let j = serde_json::to_string(v).unwrap();
            let back: SslMode = serde_json::from_str(&j).unwrap();
            assert_eq!(*v, back, "round-trip failed for {v:?}");
        }
    }

    #[test]
    fn read_only_default_is_false() {
        let json =
            r#"{"host":"h","port":3306,"database":"d","username":"u","ssl_mode":"preferred"}"#;
        let p: MysqlParams = serde_json::from_str(json).unwrap();
        assert!(!p.read_only);
    }
}
