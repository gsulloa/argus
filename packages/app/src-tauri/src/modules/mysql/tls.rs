use sqlx::mysql::MySqlConnectOptions;
use sqlx::mysql::MySqlSslMode;

use crate::modules::mysql::params::SslMode;

/// Map a `SslMode` to the corresponding `sqlx::mysql::MySqlSslMode`.
///
/// `MySqlSslMode::Required` uses TLS without hostname verification, matching
/// the Postgres `Prefer`/`Require` semantics. `VerifyCa` verifies the CA
/// chain; `VerifyIdentity` adds hostname verification. Mozilla roots are
/// bundled by sqlx through the `runtime-tokio-rustls` feature.
pub fn map_ssl_mode(mode: SslMode) -> MySqlSslMode {
    match mode {
        SslMode::Disabled => MySqlSslMode::Disabled,
        SslMode::Preferred => MySqlSslMode::Preferred,
        SslMode::Required => MySqlSslMode::Required,
        SslMode::VerifyCa => MySqlSslMode::VerifyCa,
        SslMode::VerifyIdentity => MySqlSslMode::VerifyIdentity,
    }
}

pub fn requires_tls(mode: SslMode) -> bool {
    !matches!(mode, SslMode::Disabled)
}

pub fn apply_to_connect_options(opts: MySqlConnectOptions, mode: SslMode) -> MySqlConnectOptions {
    opts.ssl_mode(map_ssl_mode(mode))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_does_not_require_tls() {
        assert!(!requires_tls(SslMode::Disabled));
    }

    #[test]
    fn required_requires_tls() {
        assert!(requires_tls(SslMode::Required));
    }

    #[test]
    fn preferred_requires_tls() {
        assert!(requires_tls(SslMode::Preferred));
    }

    #[test]
    fn map_ssl_mode_all_variants() {
        assert!(matches!(
            map_ssl_mode(SslMode::Disabled),
            MySqlSslMode::Disabled
        ));
        assert!(matches!(
            map_ssl_mode(SslMode::Preferred),
            MySqlSslMode::Preferred
        ));
        assert!(matches!(
            map_ssl_mode(SslMode::Required),
            MySqlSslMode::Required
        ));
        assert!(matches!(
            map_ssl_mode(SslMode::VerifyCa),
            MySqlSslMode::VerifyCa
        ));
        assert!(matches!(
            map_ssl_mode(SslMode::VerifyIdentity),
            MySqlSslMode::VerifyIdentity
        ));
    }
}
