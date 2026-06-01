use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

// ---------------------------------------------------------------------------
// EncryptMode
// ---------------------------------------------------------------------------

/// Controls whether the driver uses TLS to encrypt communication.
///
/// Default is `On` (encrypt everything, trust the system CA store).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EncryptMode {
    Off,
    On,
    Strict,
}

impl Default for EncryptMode {
    fn default() -> Self {
        EncryptMode::On
    }
}

impl EncryptMode {
    /// Parse a user-supplied string into an `EncryptMode`.
    ///
    /// Accepted values (case-insensitive):
    /// - `off`, `false`, `no`, `0` → `Off`
    /// - `on`, `true`, `yes`, `1`, `mandatory`, `required` → `On`
    /// - `strict` → `Strict`
    pub fn parse(s: &str) -> AppResult<Self> {
        match s.to_ascii_lowercase().as_str() {
            "off" | "false" | "no" | "0" => Ok(EncryptMode::Off),
            "on" | "true" | "yes" | "1" | "mandatory" | "required" => Ok(EncryptMode::On),
            "strict" => Ok(EncryptMode::Strict),
            other => Err(AppError::Validation(format!(
                "unknown encrypt value '{other}'; expected one of: off, on, strict"
            ))),
        }
    }
}

// ---------------------------------------------------------------------------
// ApplicationIntent
// ---------------------------------------------------------------------------

/// Declares the application workload type when connecting to a server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicationIntent {
    ReadWrite,
    ReadOnly,
}

impl ApplicationIntent {
    /// Parse a user-supplied string into an `ApplicationIntent`.
    ///
    /// Accepted values (case-insensitive):
    /// - `readwrite`, `read-write`, `read_write` → `ReadWrite`
    /// - `readonly`, `read-only`, `read_only` → `ReadOnly`
    pub fn parse(s: &str) -> AppResult<Self> {
        match s.to_ascii_lowercase().replace('-', "_").as_str() {
            "readwrite" | "read_write" => Ok(ApplicationIntent::ReadWrite),
            "readonly" | "read_only" => Ok(ApplicationIntent::ReadOnly),
            other => Err(AppError::Validation(format!(
                "unknown applicationIntent value '{other}'; expected readwrite or readonly"
            ))),
        }
    }
}

// ---------------------------------------------------------------------------
// MssqlParams
// ---------------------------------------------------------------------------

/// Connection parameters for a MS SQL Server / Azure SQL connection.
///
/// The password is deliberately NOT stored here — it lives in the OS keychain
/// and is passed separately at connect-time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MssqlParams {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    #[serde(default)]
    pub encrypt: EncryptMode,
    #[serde(default)]
    pub trust_server_certificate: bool,
    #[serde(default)]
    pub read_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application_intent: Option<ApplicationIntent>,
}

impl MssqlParams {
    /// Validate the parameters and return `AppError::Validation` on the first
    /// failure.
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
        if let Some(ref name) = self.instance_name {
            if name.trim().is_empty() {
                return Err(AppError::Validation(
                    "instance_name must not be empty when provided".into(),
                ));
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_params() -> MssqlParams {
        MssqlParams {
            host: "db.local".into(),
            port: 1433,
            database: "mydb".into(),
            username: "sa".into(),
            encrypt: EncryptMode::On,
            trust_server_certificate: false,
            read_only: false,
            instance_name: None,
            application_intent: None,
        }
    }

    // --- validate ---

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
    fn max_port_is_valid() {
        let mut p = ok_params();
        p.port = 65535;
        p.validate().unwrap();
    }

    #[test]
    fn empty_database_fails() {
        let mut p = ok_params();
        p.database = "".into();
        assert!(matches!(p.validate(), Err(AppError::Validation(_))));
    }

    #[test]
    fn whitespace_database_fails() {
        let mut p = ok_params();
        p.database = "   ".into();
        assert!(matches!(p.validate(), Err(AppError::Validation(_))));
    }

    #[test]
    fn empty_username_fails() {
        let mut p = ok_params();
        p.username = "".into();
        assert!(matches!(p.validate(), Err(AppError::Validation(_))));
    }

    #[test]
    fn whitespace_username_fails() {
        let mut p = ok_params();
        p.username = "   ".into();
        assert!(matches!(p.validate(), Err(AppError::Validation(_))));
    }

    #[test]
    fn empty_instance_name_fails() {
        let mut p = ok_params();
        p.instance_name = Some("".into());
        assert!(matches!(p.validate(), Err(AppError::Validation(_))));
    }

    #[test]
    fn whitespace_instance_name_fails() {
        let mut p = ok_params();
        p.instance_name = Some("   ".into());
        assert!(matches!(p.validate(), Err(AppError::Validation(_))));
    }

    #[test]
    fn valid_instance_name_passes() {
        let mut p = ok_params();
        p.instance_name = Some("SQLEXPRESS".into());
        p.validate().unwrap();
    }

    // --- EncryptMode::parse ---

    #[test]
    fn encrypt_mode_parse_off_variants() {
        for s in &["off", "false", "no", "0", "OFF", "False"] {
            assert_eq!(EncryptMode::parse(s).unwrap(), EncryptMode::Off, "failed for '{s}'");
        }
    }

    #[test]
    fn encrypt_mode_parse_on_variants() {
        for s in &["on", "true", "yes", "1", "mandatory", "required", "ON", "True"] {
            assert_eq!(EncryptMode::parse(s).unwrap(), EncryptMode::On, "failed for '{s}'");
        }
    }

    #[test]
    fn encrypt_mode_parse_strict() {
        assert_eq!(EncryptMode::parse("strict").unwrap(), EncryptMode::Strict);
        assert_eq!(EncryptMode::parse("STRICT").unwrap(), EncryptMode::Strict);
    }

    #[test]
    fn encrypt_mode_parse_unknown_rejected() {
        let err = EncryptMode::parse("allow").unwrap_err();
        assert!(matches!(err, AppError::Validation(ref msg) if msg.contains("off")));
    }

    #[test]
    fn encrypt_mode_default_is_on() {
        assert_eq!(EncryptMode::default(), EncryptMode::On);
    }

    // --- ApplicationIntent::parse ---

    #[test]
    fn application_intent_readwrite_variants() {
        for s in &["readwrite", "read-write", "read_write", "ReadWrite", "Read-Write"] {
            assert_eq!(
                ApplicationIntent::parse(s).unwrap(),
                ApplicationIntent::ReadWrite,
                "failed for '{s}'"
            );
        }
    }

    #[test]
    fn application_intent_readonly_variants() {
        for s in &["readonly", "read-only", "read_only", "ReadOnly", "Read-Only"] {
            assert_eq!(
                ApplicationIntent::parse(s).unwrap(),
                ApplicationIntent::ReadOnly,
                "failed for '{s}'"
            );
        }
    }

    #[test]
    fn application_intent_unknown_rejected() {
        let err = ApplicationIntent::parse("write").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    // --- JSON round-trip ---

    #[test]
    fn params_json_round_trip() {
        let p = MssqlParams {
            host: "sql.example.com".into(),
            port: 1433,
            database: "AdventureWorks".into(),
            username: "admin".into(),
            encrypt: EncryptMode::Strict,
            trust_server_certificate: true,
            read_only: true,
            instance_name: Some("MSSQLSERVER".into()),
            application_intent: Some(ApplicationIntent::ReadOnly),
        };
        let json = serde_json::to_string(&p).unwrap();
        let p2: MssqlParams = serde_json::from_str(&json).unwrap();
        assert_eq!(p.host, p2.host);
        assert_eq!(p.port, p2.port);
        assert_eq!(p.database, p2.database);
        assert_eq!(p.username, p2.username);
        assert_eq!(p.encrypt, p2.encrypt);
        assert_eq!(p.trust_server_certificate, p2.trust_server_certificate);
        assert_eq!(p.read_only, p2.read_only);
        assert_eq!(p.instance_name, p2.instance_name);
        assert_eq!(p.application_intent, p2.application_intent);
    }

    #[test]
    fn encrypt_mode_json_round_trip() {
        for v in &[EncryptMode::Off, EncryptMode::On, EncryptMode::Strict] {
            let j = serde_json::to_string(v).unwrap();
            let back: EncryptMode = serde_json::from_str(&j).unwrap();
            assert_eq!(*v, back, "round-trip failed for {v:?}");
        }
    }

    #[test]
    fn application_intent_json_round_trip() {
        for v in &[ApplicationIntent::ReadWrite, ApplicationIntent::ReadOnly] {
            let j = serde_json::to_string(v).unwrap();
            let back: ApplicationIntent = serde_json::from_str(&j).unwrap();
            assert_eq!(*v, back, "round-trip failed for {v:?}");
        }
    }

    #[test]
    fn encrypt_default_when_missing_from_json() {
        let json = r#"{"host":"h","port":1433,"database":"d","username":"u"}"#;
        let p: MssqlParams = serde_json::from_str(json).unwrap();
        assert_eq!(p.encrypt, EncryptMode::On);
        assert!(!p.trust_server_certificate);
        assert!(!p.read_only);
        assert!(p.instance_name.is_none());
        assert!(p.application_intent.is_none());
    }
}
