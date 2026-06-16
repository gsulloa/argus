use std::collections::HashMap;

use aws_sdk_dynamodb::Client as DynamoClient;
use aws_sdk_sts::Client as StsClient;
use serde::Serialize;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::dynamo::params::{DynamoAuth, DynamoParams};

// ---------------------------------------------------------------------------
// §4.1  Active client envelope
// ---------------------------------------------------------------------------

pub struct ActiveDynamoClient {
    pub client: DynamoClient,
    pub account_id: String,
    pub identity_arn: String,
    pub region: String,
    pub read_only: bool,
    pub connected_at_unix_ms: i64,
}

/// Public-safe view (no client handle, no secret material) for the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct ActiveDynamoClientView {
    pub id: Uuid,
    pub account_id: String,
    pub identity_arn: String,
    pub region: String,
    pub read_only: bool,
    pub connected_at_unix_ms: i64,
}

// ---------------------------------------------------------------------------
// §4.2  Registry
// ---------------------------------------------------------------------------

/// Singleton registry of active Dynamo clients, stored as Tauri state.
pub struct DynamoClientRegistry {
    clients: RwLock<HashMap<Uuid, ActiveDynamoClient>>,
}

impl DynamoClientRegistry {
    pub fn new() -> Self {
        Self {
            clients: RwLock::new(HashMap::new()),
        }
    }

    /// Snapshot the active clients.
    pub async fn list_active(&self) -> Vec<ActiveDynamoClientView> {
        let guard = self.clients.read().await;
        guard
            .iter()
            .map(|(id, a)| ActiveDynamoClientView {
                id: *id,
                account_id: a.account_id.clone(),
                identity_arn: a.identity_arn.clone(),
                region: a.region.clone(),
                read_only: a.read_only,
                connected_at_unix_ms: a.connected_at_unix_ms,
            })
            .collect()
    }

    /// True if a client is registered for this id.
    pub async fn is_active(&self, id: &Uuid) -> bool {
        self.clients.read().await.contains_key(id)
    }

    /// Register a client.
    pub async fn insert(&self, id: Uuid, client: ActiveDynamoClient) {
        self.clients.write().await.insert(id, client);
    }

    /// Remove a client. Returns true if one was present.
    pub async fn remove(&self, id: &Uuid) -> bool {
        self.clients.write().await.remove(id).is_some()
    }

    // -----------------------------------------------------------------------
    // §4.3  Read-only enforcement
    // -----------------------------------------------------------------------

    /// Returns `Ok(())` when the client exists and is writable.
    /// Returns `NotFound` when no client is registered for `id`.
    /// Returns `Validation` when the client is read-only.
    pub async fn require_writable(&self, id: &Uuid) -> AppResult<()> {
        let guard = self.clients.read().await;
        match guard.get(id) {
            None => Err(AppError::NotFound(format!("dynamo client {id} not active"))),
            Some(a) if a.read_only => Err(AppError::Validation(
                "connection is read-only; mutating operations are blocked".into(),
            )),
            Some(_) => Ok(()),
        }
    }

    /// Snapshot of stored client identity (cheap clone) — used by commands.rs
    /// to read state without holding the lock.
    pub async fn snapshot(&self, id: &Uuid) -> Option<ActiveDynamoClientView> {
        let guard = self.clients.read().await;
        guard.get(id).map(|a| ActiveDynamoClientView {
            id: *id,
            account_id: a.account_id.clone(),
            identity_arn: a.identity_arn.clone(),
            region: a.region.clone(),
            read_only: a.read_only,
            connected_at_unix_ms: a.connected_at_unix_ms,
        })
    }

    /// Borrow a clone of the underlying DynamoDB client.
    /// (`aws_sdk_dynamodb::Client` is cheap to clone — it wraps an Arc.)
    pub async fn acquire(&self, id: &Uuid) -> AppResult<DynamoClient> {
        let guard = self.clients.read().await;
        guard
            .get(id)
            .map(|a| a.client.clone())
            .ok_or_else(|| AppError::NotFound(format!("dynamo client {id} not active")))
    }
}

impl Default for DynamoClientRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// §5.1–5.3  SDK client builder
// ---------------------------------------------------------------------------

/// Output of `build_dynamo_client`: configured Dynamo client + resolved identity.
pub struct BuiltClient {
    pub client: DynamoClient,
    pub account_id: String,
    pub identity_arn: String,
}

/// Build a DynamoDB client and run STS `GetCallerIdentity` to verify credentials.
///
/// `secret` is a JSON string `{ access_key_id, secret_access_key, session_token? }`
/// and is required when `params.auth == AccessKeys`. It is ignored (and may be `None`)
/// for `Profile` mode.
pub async fn build_dynamo_client(
    params: &DynamoParams,
    secret: Option<&str>,
) -> AppResult<BuiltClient> {
    use aws_config::Region;
    use aws_sdk_dynamodb::config::{BehaviorVersion, Credentials};

    let region = Region::new(params.region.clone());

    // --- §5.1  Resolve credentials and build an SdkConfig ---------------
    let sdk_config = match params.auth {
        DynamoAuth::AccessKeys => {
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
                .region(region.clone())
                .credentials_provider(creds)
                .load()
                .await
        }

        DynamoAuth::Profile => {
            let profile = params.profile.as_deref().ok_or_else(|| {
                AppError::Validation("profile is required when auth = profile".into())
            })?;

            aws_config::defaults(BehaviorVersion::latest())
                .region(region.clone())
                .profile_name(profile)
                .load()
                .await
        }
    };

    // --- §5.2  Build DynamoDB client config (region + optional endpoint) ---
    let mut dynamo_cfg_builder = aws_sdk_dynamodb::config::Builder::from(&sdk_config);

    if let Some(endpoint_url) = params.endpoint_url.as_ref().filter(|s| !s.is_empty()) {
        dynamo_cfg_builder = dynamo_cfg_builder.endpoint_url(endpoint_url);
        // TLS relaxation note: for loopback endpoints (http://localhost:*)
        // the SDK already uses plain HTTP, so no TLS is involved and no custom
        // connector is needed. For non-loopback HTTPS endpoints the SDK's
        // default rustls connector handles TLS with system roots.
    }

    let client = DynamoClient::from_conf(dynamo_cfg_builder.build());

    // --- §5.3  STS GetCallerIdentity — fail fast on bad credentials --------
    let sts = StsClient::new(&sdk_config);
    let identity = sts
        .get_caller_identity()
        .send()
        .await
        .map_err(|e| sdk_error_to_app(&e))?;

    let account_id = identity.account.unwrap_or_default();
    let identity_arn = identity.arn.unwrap_or_default();

    Ok(BuiltClient {
        client,
        account_id,
        identity_arn,
    })
}

// ---------------------------------------------------------------------------
// §5.4  Error classification
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AwsErrorClass {
    ExpiredSessionToken,
    ExpiredSso,
    AccessDenied,
    NetworkOrEndpoint,
    Other,
}

/// Classify an SDK error by examining its code and message.
///
/// Generic over the operation error type `E` and the raw response type `R`;
/// we look at `ProvideErrorMetadata` to extract the code and message strings
/// without depending on the concrete error or response enum.
/// The default raw response type is `HttpResponse` (matching the
/// `aws_sdk_sts::error::SdkError<E>` type alias); tests pass `()` as `R`
/// to avoid constructing an `HttpResponse`.
pub fn classify_aws_error<E, R>(
    err: &aws_smithy_runtime_api::client::result::SdkError<E, R>,
) -> AwsErrorClass
where
    E: aws_sdk_sts::error::ProvideErrorMetadata + std::fmt::Debug,
    R: std::fmt::Debug,
{
    use aws_sdk_sts::error::ProvideErrorMetadata;
    use aws_smithy_runtime_api::client::result::SdkError;

    let code = err.meta().code().unwrap_or_default();
    let msg = err.meta().message().unwrap_or_default();
    let lower_msg = msg.to_ascii_lowercase();

    // --- Expired STS session token / static key error codes ---
    if matches!(
        code,
        "ExpiredToken" | "ExpiredTokenException" | "InvalidClientTokenId" | "RequestExpired"
    ) {
        return AwsErrorClass::ExpiredSessionToken;
    }

    // --- SSO-related: SDK wraps these as construction/dispatch errors or
    //     AccessDeniedException with a "token has expired" message. ---
    if code == "SsoTokenProviderError"
        || lower_msg.contains("sso session has expired")
        || lower_msg.contains("sso token has expired")
        || lower_msg.contains("the sso session associated with this profile has expired")
    {
        return AwsErrorClass::ExpiredSso;
    }

    if code == "AccessDeniedException" || code == "AccessDenied" {
        // AccessDenied with a "token has expired" body is SSO-expired in disguise.
        if lower_msg.contains("token has expired") {
            return AwsErrorClass::ExpiredSso;
        }
        return AwsErrorClass::AccessDenied;
    }

    // --- Network / endpoint failures ---
    if matches!(
        err,
        SdkError::DispatchFailure(_) | SdkError::TimeoutError(_)
    ) {
        return AwsErrorClass::NetworkOrEndpoint;
    }

    AwsErrorClass::Other
}

/// Map any `SdkError` to `AppError::Aws` with a `retryable` flag.
fn sdk_error_to_app<E>(err: &aws_sdk_sts::error::SdkError<E>) -> AppError
where
    E: aws_sdk_sts::error::ProvideErrorMetadata + std::fmt::Debug,
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

// ---------------------------------------------------------------------------
// §4.4  Unit tests for require_writable
// §5.5  Classifier-only tests (no mocked SDK round-trips)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Test helper: build a minimal DynamoDB Client without hitting the network.
    // Uses static fake credentials and a no-op region; the client is never
    // actually used to make calls in these tests.
    // -----------------------------------------------------------------------
    fn make_test_client(region: &str) -> aws_sdk_dynamodb::Client {
        use aws_sdk_dynamodb::config::{BehaviorVersion, Credentials, Region};
        let config = aws_sdk_dynamodb::Config::builder()
            .region(Region::new(region.to_string()))
            .credentials_provider(Credentials::new("AKIATEST", "secret", None, None, "test"))
            .behavior_version(BehaviorVersion::latest())
            .build();
        aws_sdk_dynamodb::Client::from_conf(config)
    }

    fn make_active(read_only: bool) -> ActiveDynamoClient {
        ActiveDynamoClient {
            client: make_test_client("us-east-1"),
            account_id: "123456789012".into(),
            identity_arn: "arn:aws:iam::123456789012:user/test".into(),
            region: "us-east-1".into(),
            read_only,
            connected_at_unix_ms: 0,
        }
    }

    // -----------------------------------------------------------------------
    // §4.4 require_writable — three branches
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn require_writable_not_found() {
        let reg = DynamoClientRegistry::new();
        let id = Uuid::new_v4();
        let err = reg.require_writable(&id).await.unwrap_err();
        assert!(
            matches!(err, AppError::NotFound(_)),
            "expected NotFound, got {err:?}"
        );
    }

    #[tokio::test]
    async fn require_writable_readonly_rejected() {
        let reg = DynamoClientRegistry::new();
        let id = Uuid::new_v4();
        reg.insert(id, make_active(true)).await;
        let err = reg.require_writable(&id).await.unwrap_err();
        assert!(
            matches!(err, AppError::Validation(_)),
            "expected Validation, got {err:?}"
        );
    }

    #[tokio::test]
    async fn require_writable_writable_ok() {
        let reg = DynamoClientRegistry::new();
        let id = Uuid::new_v4();
        reg.insert(id, make_active(false)).await;
        reg.require_writable(&id).await.unwrap();
    }

    // -----------------------------------------------------------------------
    // §5.5  classify_aws_error — table-driven tests
    //
    // We construct SdkError<GetCallerIdentityError, ()> instances using the
    // public API: `SdkError::service_error(GetCallerIdentityError::generic(…), ())`
    // for service errors and `SdkError::dispatch_failure(…)` for network errors.
    // -----------------------------------------------------------------------

    use aws_sdk_sts::error::SdkError;
    use aws_sdk_sts::operation::get_caller_identity::GetCallerIdentityError;
    use aws_smithy_types::error::ErrorMetadata;

    /// Build a service-level SdkError with the given code and message.
    fn service_err(code: &str, msg: &str) -> SdkError<GetCallerIdentityError> {
        let meta = ErrorMetadata::builder().code(code).message(msg).build();
        let gci_err = GetCallerIdentityError::generic(meta);
        // The raw response can be `()` for unit tests; it's never inspected.
        SdkError::service_error(
            gci_err,
            ::aws_smithy_runtime_api::client::orchestrator::HttpResponse::new(
                200u16.try_into().unwrap(),
                aws_smithy_types::body::SdkBody::empty(),
            ),
        )
    }

    /// Build a DispatchFailure SdkError (simulates DNS / connect error).
    fn dispatch_err() -> SdkError<GetCallerIdentityError> {
        use aws_smithy_runtime_api::client::result::ConnectorError;
        let connector_err = ConnectorError::io(Box::new(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "connection refused",
        )));
        SdkError::dispatch_failure(connector_err)
    }

    /// Build a TimeoutError SdkError.
    fn timeout_err() -> SdkError<GetCallerIdentityError> {
        SdkError::timeout_error("request timed out")
    }

    // Case 1: ExpiredToken code → ExpiredSessionToken
    #[test]
    fn classify_expired_token() {
        let err = service_err("ExpiredToken", "token expired");
        assert_eq!(classify_aws_error(&err), AwsErrorClass::ExpiredSessionToken);
    }

    // Case 2: ExpiredTokenException code → ExpiredSessionToken
    #[test]
    fn classify_expired_token_exception() {
        let err = service_err(
            "ExpiredTokenException",
            "The security token included in the request is expired",
        );
        assert_eq!(classify_aws_error(&err), AwsErrorClass::ExpiredSessionToken);
    }

    // Case 3: InvalidClientTokenId code → ExpiredSessionToken
    #[test]
    fn classify_invalid_client_token_id() {
        let err = service_err(
            "InvalidClientTokenId",
            "The security token included in the request is invalid.",
        );
        assert_eq!(classify_aws_error(&err), AwsErrorClass::ExpiredSessionToken);
    }

    // Case 4: AccessDeniedException with "Token has expired" message → ExpiredSso
    #[test]
    fn classify_access_denied_token_expired_is_sso() {
        let err = service_err("AccessDeniedException", "Token has expired.");
        assert_eq!(classify_aws_error(&err), AwsErrorClass::ExpiredSso);
    }

    // Case 5: AccessDeniedException with generic message → AccessDenied
    #[test]
    fn classify_access_denied_generic() {
        let err = service_err(
            "AccessDeniedException",
            "User is not authorized to perform this action",
        );
        assert_eq!(classify_aws_error(&err), AwsErrorClass::AccessDenied);
    }

    // Case 6: SsoTokenProviderError code → ExpiredSso
    #[test]
    fn classify_sso_token_provider_error() {
        let err = service_err("SsoTokenProviderError", "The SSO token has expired");
        assert_eq!(classify_aws_error(&err), AwsErrorClass::ExpiredSso);
    }

    // Case 7: Empty code, msg containing "SSO session has expired" → ExpiredSso
    #[test]
    fn classify_empty_code_sso_session_expired_in_message() {
        let err = service_err("", "SSO session has expired");
        assert_eq!(classify_aws_error(&err), AwsErrorClass::ExpiredSso);
    }

    // Case 8: DispatchFailure → NetworkOrEndpoint
    #[test]
    fn classify_dispatch_failure_network() {
        let err = dispatch_err();
        assert_eq!(classify_aws_error(&err), AwsErrorClass::NetworkOrEndpoint);
    }

    // Case 9: TimeoutError → NetworkOrEndpoint
    #[test]
    fn classify_timeout_error_network() {
        let err = timeout_err();
        assert_eq!(classify_aws_error(&err), AwsErrorClass::NetworkOrEndpoint);
    }

    // Case 10: Unknown / unrecognised service error code → Other
    #[test]
    fn classify_unknown_code_is_other() {
        let err = service_err("SomeWeirdCode", "unrecognised error");
        assert_eq!(classify_aws_error(&err), AwsErrorClass::Other);
    }
}
