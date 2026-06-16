use aws_sdk_athena::Client as AthenaClient;
use aws_sdk_glue::Client as GlueClient;
use aws_sdk_sts::Client as StsClient;

use crate::error::{AppError, AppResult};
use crate::modules::athena::params::{AthenaAuth, AthenaParams};

// ---------------------------------------------------------------------------
// Built clients output
// ---------------------------------------------------------------------------

/// Output of `build_athena_clients`: Athena + Glue clients + resolved identity.
pub struct BuiltClients {
    pub athena: AthenaClient,
    pub glue: GlueClient,
    pub account_id: String,
    pub identity_arn: String,
}

// ---------------------------------------------------------------------------
// Client builder
// ---------------------------------------------------------------------------

/// Build Athena and Glue clients, verify with STS GetCallerIdentity.
///
/// `secret` is a JSON string `{ access_key_id, secret_access_key, session_token? }`
/// required when `params.auth == AccessKeys`.
pub async fn build_athena_clients(
    params: &AthenaParams,
    secret: Option<&str>,
) -> AppResult<BuiltClients> {
    let sdk_config = build_sdk_config(params, secret).await?;

    // Build Athena client.
    let athena = AthenaClient::new(&sdk_config);

    // Build Glue client.
    let glue = GlueClient::new(&sdk_config);

    // Verify credentials via STS GetCallerIdentity.
    let sts = StsClient::new(&sdk_config);
    let identity = sts
        .get_caller_identity()
        .send()
        .await
        .map_err(|e| sdk_error_to_app_err(&e))?;

    let account_id = identity.account.unwrap_or_default();
    let identity_arn = identity.arn.unwrap_or_default();

    Ok(BuiltClients {
        athena,
        glue,
        account_id,
        identity_arn,
    })
}

/// Resolve credentials and build an `SdkConfig` from `AthenaParams` + secret.
///
/// Shared by `build_athena_clients` and any other AWS client built from the
/// same connection (e.g. the S3 client used to browse output-location buckets),
/// so every client uses the exact credentials the user selected for the form.
pub async fn build_sdk_config(
    params: &AthenaParams,
    secret: Option<&str>,
) -> AppResult<aws_config::SdkConfig> {
    use aws_config::Region;
    use aws_sdk_athena::config::BehaviorVersion;
    use aws_sdk_athena::config::Credentials;

    let region = Region::new(params.region.clone());

    // Resolve credentials and build SdkConfig.
    let sdk_config = match params.auth {
        AthenaAuth::AccessKeys => {
            let secret = secret.ok_or_else(|| {
                AppError::Validation("credentials are required when auth = access_keys".into())
            })?;
            let parsed: serde_json::Value = serde_json::from_str(secret).map_err(|_| {
                AppError::Validation("credentials payload is malformed JSON".into())
            })?;
            let access_key_id = parsed
                .get("access_key_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::Validation("aws_access_key_id is required".into()))?
                .to_string();
            let secret_access_key = parsed
                .get("secret_access_key")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::Validation("aws_secret_access_key is required".into()))?
                .to_string();
            let session_token = parsed
                .get("session_token")
                .and_then(|v| v.as_str())
                .map(String::from);

            let creds = Credentials::new(
                access_key_id,
                secret_access_key,
                session_token,
                None,
                "argus-static",
            );

            aws_config::defaults(BehaviorVersion::latest())
                .region(region)
                .credentials_provider(creds)
                .load()
                .await
        }

        AthenaAuth::Profile => {
            let profile = params.profile.as_deref().ok_or_else(|| {
                AppError::Validation("profile is required when auth = profile".into())
            })?;

            aws_config::defaults(BehaviorVersion::latest())
                .region(region)
                .profile_name(profile)
                .load()
                .await
        }
    };

    Ok(sdk_config)
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

/// Map an STS SdkError to AppError::Aws.
fn sdk_error_to_app_err<E>(err: &aws_sdk_sts::error::SdkError<E>) -> AppError
where
    E: aws_sdk_sts::error::ProvideErrorMetadata + std::fmt::Debug,
{
    use aws_sdk_sts::error::ProvideErrorMetadata;
    let code = err.meta().code().unwrap_or("Unknown").to_string();
    let message = err
        .meta()
        .message()
        .map(String::from)
        .unwrap_or_else(|| format!("{err:?}"));
    AppError::aws(code, message, false)
}
