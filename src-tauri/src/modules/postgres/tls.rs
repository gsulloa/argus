use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use tokio_postgres::config::SslMode as PgSslMode;
use tokio_postgres::Config as PgConfig;

use crate::error::AppResult;
use crate::modules::postgres::params::SslMode;

/// Build a `rustls::ClientConfig` for the given sslmode.
///
/// - `Disable` returns `None` (no TLS).
/// - `Prefer` / `Require` return a config that does NOT verify CA or hostname.
/// - `VerifyCa` and `VerifyFull` both verify the full chain + hostname against
///   the bundled Mozilla roots. (Pure "verify CA but skip hostname" is deferred —
///   most managed-Postgres certs are issued for the host you connect to.)
pub fn client_config_for(sslmode: SslMode) -> AppResult<Option<Arc<ClientConfig>>> {
    if matches!(sslmode, SslMode::Disable) {
        return Ok(None);
    }

    // Ensure rustls has a crypto provider installed for this process.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let cfg = match sslmode {
        SslMode::Disable => unreachable!(),
        SslMode::Prefer | SslMode::Require => ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerify))
            .with_no_client_auth(),
        SslMode::VerifyCa | SslMode::VerifyFull => {
            let mut roots = rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth()
        }
    };

    Ok(Some(Arc::new(cfg)))
}

pub fn apply_tls_to_pg_config(pg: &mut PgConfig, sslmode: SslMode) {
    let mode = match sslmode {
        SslMode::Disable => PgSslMode::Disable,
        SslMode::Prefer => PgSslMode::Prefer,
        SslMode::Require | SslMode::VerifyCa | SslMode::VerifyFull => PgSslMode::Require,
    };
    pg.ssl_mode(mode);
}

/// rustls verifier that accepts any certificate. Used for `Prefer` / `Require`
/// sslmodes — encryption without authentication.
#[derive(Debug)]
struct NoVerify;

impl ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::ED25519,
        ]
    }
}
