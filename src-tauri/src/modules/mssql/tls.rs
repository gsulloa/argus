//! TLS configuration helpers for `tiberius::Config`.
//!
//! # EncryptMode → EncryptionLevel matrix
//!
//! | EncryptMode | trust_server_certificate | EncryptionLevel        | trust_cert() |
//! |-------------|--------------------------|------------------------|--------------|
//! | Off         | (any)                    | `NotSupported`         | yes          |
//! | On          | false                    | `Required`             | no (default) |
//! | On          | true                     | `Required`             | yes          |
//! | Strict      | false                    | `Required`             | no (default) |
//! | Strict      | true                     | `Required`             | yes          |
//!
//! # Why `Off` maps to `NotSupported` instead of `Off`
//!
//! Tiberius's `EncryptionLevel::Off` means "data is not encrypted **after** the
//! login packet" — but the **pre-login handshake still negotiates TLS** for the
//! login packet itself. SQL Server then presents its self-signed cert; rustls's
//! strict X.509 parser rejects it with `UnsupportedCertVersion` (a common issue
//! with certs minted by `mcr.microsoft.com/mssql/server` Docker images, which
//! sometimes use TDS-specific X.509 v1 certs that webpki refuses to parse).
//!
//! `EncryptionLevel::NotSupported` tells the server "the client has no TLS
//! support at all" — SQL Server then skips the entire TLS handshake and the
//! login packet flows in plaintext. This matches user intent ("I picked no
//! TLS") and matches what TablePlus does internally with `tLSMode=0`.
//!
//! As a defensive measure we also call `trust_cert()` even in `Off` mode so
//! that if the server forces TLS anyway (rare, but configurable server-side
//! via `force encryption=1`), we still don't fail on the cert version check.
//!
//! # Note on Strict mode
//!
//! `tiberius 0.12` does not expose a separate "strict / TDS 8.0" encryption
//! variant — its `EncryptionLevel` enum has `Off`, `On`, `NotSupported`, and
//! `Required`. `Required` is the closest equivalent (encrypts all data, fails
//! if the server cannot honour it). We therefore treat `EncryptMode::Strict`
//! identically to `EncryptMode::On` at the driver level. A comment is left in
//! the code as a forward-compatibility hook for when tiberius adds TDS 8.0
//! strict support.

use tiberius::{AuthMethod, Config, EncryptionLevel};

use crate::modules::mssql::params::{ApplicationIntent, EncryptMode, MssqlParams};

/// Apply TLS settings to an existing `tiberius::Config`.
///
/// See the module-level table for the full mapping.
pub fn apply_tls_to_config(
    config: &mut Config,
    encrypt: EncryptMode,
    trust_server_certificate: bool,
) {
    match encrypt {
        EncryptMode::Off => {
            // Use `NotSupported` (not `Off`!) so the client advertises that it
            // cannot do TLS at all — this skips the pre-login TLS handshake
            // entirely. See the module-level docs for the full reasoning.
            config.encryption(EncryptionLevel::NotSupported);
            // Defensive: if the server has `force encryption = 1` and still
            // forces TLS, accept whatever cert it presents (including those
            // rustls would otherwise reject with UnsupportedCertVersion).
            config.trust_cert();
        }
        EncryptMode::On | EncryptMode::Strict => {
            // NOTE: tiberius 0.12 does not distinguish between "On" (opportunistic
            // encryption) and "Strict" (TDS 8.0 pre-login TLS). Both are mapped
            // to `EncryptionLevel::Required` which ensures the driver always
            // encrypts and fails if the server refuses. This is the safest
            // available setting in the current driver version.
            //
            // When tiberius gains `EncryptionLevel::Strict` (or equivalent TDS 8.0
            // support), replace `Required` with that variant for `EncryptMode::Strict`.
            config.encryption(EncryptionLevel::Required);

            if trust_server_certificate {
                // Accept any server certificate without validating the chain or
                // hostname. Suitable for Docker / self-signed development environments.
                config.trust_cert();
            }
            // If trust_server_certificate is false, the default `TrustConfig::Default`
            // is used, which validates against the system CA store (via webpki-roots
            // as bundled by tiberius's rustls feature).
        }
    }
}

/// Build a complete `tiberius::Config` from [`MssqlParams`] and a plaintext
/// password.
///
/// This is the single construction point used by both `test_connection` and
/// the pool builder (`build_mssql_pool`).
pub fn build_tiberius_config(params: &MssqlParams, password: &str) -> Config {
    let mut config = Config::new();

    config.host(&params.host);
    config.port(params.port);
    config.database(&params.database);

    if let Some(ref inst) = params.instance_name {
        config.instance_name(inst);
    }

    config.authentication(AuthMethod::sql_server(&params.username, password));

    apply_tls_to_config(&mut config, params.encrypt, params.trust_server_certificate);

    // ApplicationIntent routing — set ReadOnly when:
    // 1. The user explicitly chose ReadOnly intent, OR
    // 2. read_only=true and no explicit intent was specified.
    //
    // Setting ApplicationIntent=ReadOnly on a non-AG server is harmless; the
    // server ignores it. On Azure SQL / AG servers it routes to read replicas.
    let effective_intent = params.application_intent.unwrap_or_else(|| {
        if params.read_only {
            ApplicationIntent::ReadOnly
        } else {
            ApplicationIntent::ReadWrite
        }
    });

    config.readonly(matches!(effective_intent, ApplicationIntent::ReadOnly));

    config
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn base_params() -> MssqlParams {
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

    // Helper: inspect the debug output for key config values since tiberius
    // does not expose `encryption` or `trust` through public getters.
    fn config_debug(config: &Config) -> String {
        format!("{config:?}")
    }

    // -----------------------------------------------------------------------
    // apply_tls_to_config: EncryptMode::Off
    // -----------------------------------------------------------------------

    #[test]
    fn off_sets_encryption_not_supported() {
        let mut config = Config::new();
        apply_tls_to_config(&mut config, EncryptMode::Off, false);
        let debug = config_debug(&config);
        // Off must map to NotSupported (not the tiberius `Off` variant) so the
        // pre-login TLS handshake is skipped — see module-level docs.
        assert!(
            debug.contains("NotSupported"),
            "expected NotSupported in config debug: {debug}"
        );
        // Defensive trust_cert() is set even in Off mode to survive servers
        // with `force encryption = 1`.
        assert!(
            debug.contains("TrustAll"),
            "expected TrustAll defensively in Off mode: {debug}"
        );
    }

    #[test]
    fn off_with_trust_cert_still_sets_not_supported() {
        let mut config = Config::new();
        apply_tls_to_config(&mut config, EncryptMode::Off, true);
        let debug = config_debug(&config);
        assert!(
            debug.contains("NotSupported"),
            "expected NotSupported in config debug: {debug}"
        );
        assert!(
            debug.contains("TrustAll"),
            "expected TrustAll in config debug: {debug}"
        );
    }

    // -----------------------------------------------------------------------
    // apply_tls_to_config: EncryptMode::On
    // -----------------------------------------------------------------------

    #[test]
    fn on_no_trust_sets_required() {
        let mut config = Config::new();
        apply_tls_to_config(&mut config, EncryptMode::On, false);
        let debug = config_debug(&config);
        assert!(
            debug.contains("Required"),
            "expected Required in config debug: {debug}"
        );
        // Should NOT contain TrustAll
        assert!(
            !debug.contains("TrustAll"),
            "should not have TrustAll when trust_cert is false: {debug}"
        );
    }

    #[test]
    fn on_with_trust_cert_sets_required_and_trust_all() {
        let mut config = Config::new();
        apply_tls_to_config(&mut config, EncryptMode::On, true);
        let debug = config_debug(&config);
        assert!(
            debug.contains("Required"),
            "expected Required in config debug: {debug}"
        );
        assert!(
            debug.contains("TrustAll"),
            "expected TrustAll in config debug: {debug}"
        );
    }

    // -----------------------------------------------------------------------
    // apply_tls_to_config: EncryptMode::Strict
    // -----------------------------------------------------------------------

    #[test]
    fn strict_no_trust_sets_required() {
        let mut config = Config::new();
        apply_tls_to_config(&mut config, EncryptMode::Strict, false);
        let debug = config_debug(&config);
        assert!(
            debug.contains("Required"),
            "expected Required in config debug: {debug}"
        );
        assert!(
            !debug.contains("TrustAll"),
            "should not have TrustAll: {debug}"
        );
    }

    #[test]
    fn strict_with_trust_cert_sets_required_and_trust_all() {
        let mut config = Config::new();
        apply_tls_to_config(&mut config, EncryptMode::Strict, true);
        let debug = config_debug(&config);
        assert!(
            debug.contains("Required"),
            "expected Required in config debug: {debug}"
        );
        assert!(
            debug.contains("TrustAll"),
            "expected TrustAll in config debug: {debug}"
        );
    }

    // -----------------------------------------------------------------------
    // build_tiberius_config
    // -----------------------------------------------------------------------

    #[test]
    fn build_config_sets_host_and_port() {
        let p = base_params();
        let config = build_tiberius_config(&p, "secret");
        // get_addr() returns "host:port"
        assert_eq!(config.get_addr(), "db.local:1433");
    }

    #[test]
    fn build_config_with_instance_name() {
        let mut p = base_params();
        p.instance_name = Some("SQLEXPRESS".into());
        let config = build_tiberius_config(&p, "secret");
        let debug = config_debug(&config);
        assert!(
            debug.contains("SQLEXPRESS"),
            "expected SQLEXPRESS in config debug: {debug}"
        );
    }

    #[test]
    fn build_config_readonly_true_when_read_only_flag() {
        let mut p = base_params();
        p.read_only = true;
        let config = build_tiberius_config(&p, "secret");
        let debug = config_debug(&config);
        assert!(
            debug.contains("readonly: true"),
            "expected readonly: true in config debug: {debug}"
        );
    }

    #[test]
    fn build_config_readonly_false_when_not_set() {
        let p = base_params();
        let config = build_tiberius_config(&p, "secret");
        let debug = config_debug(&config);
        assert!(
            debug.contains("readonly: false"),
            "expected readonly: false in config debug: {debug}"
        );
    }

    #[test]
    fn build_config_readonly_true_when_explicit_intent_readonly() {
        let mut p = base_params();
        p.application_intent = Some(ApplicationIntent::ReadOnly);
        let config = build_tiberius_config(&p, "secret");
        let debug = config_debug(&config);
        assert!(
            debug.contains("readonly: true"),
            "expected readonly: true in config debug: {debug}"
        );
    }

    #[test]
    fn build_config_readonly_false_when_explicit_intent_readwrite() {
        let mut p = base_params();
        p.read_only = true; // global flag is true …
        p.application_intent = Some(ApplicationIntent::ReadWrite); // … but explicit intent overrides
        let config = build_tiberius_config(&p, "secret");
        let debug = config_debug(&config);
        assert!(
            debug.contains("readonly: false"),
            "expected readonly: false (explicit ReadWrite wins): {debug}"
        );
    }

    #[test]
    fn build_config_encryption_not_supported_when_encrypt_mode_off() {
        let mut p = base_params();
        p.encrypt = EncryptMode::Off;
        let config = build_tiberius_config(&p, "secret");
        let debug = config_debug(&config);
        // EncryptMode::Off must map to EncryptionLevel::NotSupported so the
        // pre-login TLS handshake is skipped — see module docs.
        assert!(
            debug.contains("NotSupported"),
            "expected NotSupported encryption in config debug: {debug}"
        );
    }
}
