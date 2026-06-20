//! Error helpers for the Athena module.
//!
//! Maps Athena/Glue SDK errors to `AppError::Aws`, reusing the DynamoDB error
//! classification and remediation hints.

use crate::error::AppError;
use crate::modules::dynamo::client::{classify_aws_error, AwsErrorClass};

// ---------------------------------------------------------------------------
// SSO-expired message formatting (mirrored from dynamo/commands.rs)
// ---------------------------------------------------------------------------

pub fn maybe_sso_specialized(app_err: AppError, profile: Option<&str>) -> AppError {
    if let AppError::Aws(body) = &app_err {
        let lower = body.message.to_ascii_lowercase();
        let is_sso = body.code.eq_ignore_ascii_case("SsoTokenProviderError")
            || lower.contains("sso session has expired")
            || lower.contains("sso token has expired")
            || lower.contains("the sso session associated with this profile has expired")
            || (body.code == "AccessDeniedException" && lower.contains("token has expired"));
        if is_sso {
            let profile_str = profile.unwrap_or("<profile>");
            let new_msg = format!(
                "{} — run `aws sso login --profile {}` in your terminal, then try again",
                body.message, profile_str
            );
            return AppError::aws("SsoExpired", new_msg, false);
        }
    }
    app_err
}

// ---------------------------------------------------------------------------
// Generic SDK error → AppError::Aws mapper
// ---------------------------------------------------------------------------

/// Map any Athena/Glue/STS `SdkError` to `AppError::Aws`.
///
/// Generic over the error type; works for athena, glue, and sts SDK errors.
pub fn sdk_err_to_app<E, R>(
    err: &aws_smithy_runtime_api::client::result::SdkError<E, R>,
) -> AppError
where
    E: aws_sdk_sts::error::ProvideErrorMetadata + std::fmt::Debug,
    R: std::fmt::Debug,
{
    use aws_sdk_sts::error::ProvideErrorMetadata;

    let class = classify_aws_error(err);
    let code = err.meta().code().unwrap_or("Unknown").to_string();
    let message = err
        .meta()
        .message()
        .map(String::from)
        .unwrap_or_else(|| format!("{err:?}"));
    let retryable = matches!(class, AwsErrorClass::NetworkOrEndpoint);
    AppError::aws(code, message, retryable)
}

/// Map an error and apply SSO specialization.
pub fn map_sdk_err_with_profile<E, R>(
    err: &aws_smithy_runtime_api::client::result::SdkError<E, R>,
    profile: Option<&str>,
) -> AppError
where
    E: aws_sdk_sts::error::ProvideErrorMetadata + std::fmt::Debug,
    R: std::fmt::Debug,
{
    let app_err = sdk_err_to_app(err);
    maybe_sso_specialized(app_err, profile)
}
