//! CloudWatch Logs client builder and registry.

use std::collections::HashMap;

use aws_sdk_cloudwatchlogs::Client as CwClient;
use aws_sdk_sts::Client as StsClient;
use serde::Serialize;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::cloudwatch::params::{CloudwatchAuth, CloudwatchParams};

// ---------------------------------------------------------------------------
// Active client envelope
// ---------------------------------------------------------------------------

pub struct ActiveCloudwatchClient {
    pub client: CwClient,
    pub account_id: String,
    pub identity_arn: String,
    pub region: String,
    pub connected_at_unix_ms: i64,
}

/// Public-safe view (no client handle, no secret material) for the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct ActiveCloudwatchClientView {
    pub id: Uuid,
    pub region: String,
    pub account_id: String,
    pub identity_arn: String,
    pub connected_at_unix_ms: i64,
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/// Singleton registry of active CloudWatch Logs clients, stored as Tauri state.
pub struct CloudwatchClientRegistry {
    clients: RwLock<HashMap<Uuid, ActiveCloudwatchClient>>,
}

impl CloudwatchClientRegistry {
    pub fn new() -> Self {
        Self {
            clients: RwLock::new(HashMap::new()),
        }
    }

    /// Snapshot the active clients.
    pub async fn list_active(&self) -> Vec<ActiveCloudwatchClientView> {
        let guard = self.clients.read().await;
        guard
            .iter()
            .map(|(id, a)| ActiveCloudwatchClientView {
                id: *id,
                region: a.region.clone(),
                account_id: a.account_id.clone(),
                identity_arn: a.identity_arn.clone(),
                connected_at_unix_ms: a.connected_at_unix_ms,
            })
            .collect()
    }

    /// True if a client is registered for this id.
    pub async fn is_active(&self, id: &Uuid) -> bool {
        self.clients.read().await.contains_key(id)
    }

    /// Register a client.
    pub async fn insert(&self, id: Uuid, client: ActiveCloudwatchClient) {
        self.clients.write().await.insert(id, client);
    }

    /// Remove a client. Returns true if one was present.
    pub async fn remove(&self, id: &Uuid) -> bool {
        self.clients.write().await.remove(id).is_some()
    }

    /// Snapshot of stored client identity (cheap clone) — used by commands.rs
    /// to read state without holding the lock.
    pub async fn snapshot(&self, id: &Uuid) -> Option<ActiveCloudwatchClientView> {
        let guard = self.clients.read().await;
        guard.get(id).map(|a| ActiveCloudwatchClientView {
            id: *id,
            region: a.region.clone(),
            account_id: a.account_id.clone(),
            identity_arn: a.identity_arn.clone(),
            connected_at_unix_ms: a.connected_at_unix_ms,
        })
    }

    /// Borrow a clone of the underlying CloudWatch Logs client.
    /// (`aws_sdk_cloudwatchlogs::Client` is cheap to clone — it wraps an Arc.)
    pub async fn acquire(&self, id: &Uuid) -> AppResult<CwClient> {
        let guard = self.clients.read().await;
        guard
            .get(id)
            .map(|a| a.client.clone())
            .ok_or_else(|| AppError::NotFound(format!("cloudwatch client {id} not active")))
    }

    /// Disconnect all active clients.
    pub async fn disconnect_all(&self) -> usize {
        let mut guard = self.clients.write().await;
        let count = guard.len();
        guard.clear();
        count
    }
}

impl Default for CloudwatchClientRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// SDK client builder
// ---------------------------------------------------------------------------

/// Output of `build_cloudwatch_client`: configured client + resolved identity.
pub struct BuiltClient {
    pub client: CwClient,
    pub account_id: String,
    pub identity_arn: String,
    pub region: String,
}

/// Build a CloudWatch Logs client and run STS `GetCallerIdentity` to verify credentials.
///
/// `secret` is a JSON string `{ access_key_id, secret_access_key, session_token? }`
/// and is required when `params.auth == AccessKeys`. It is ignored (and may be `None`)
/// for `Profile` mode.
pub async fn build_cloudwatch_client(
    params: &CloudwatchParams,
    secret: Option<&str>,
) -> AppResult<BuiltClient> {
    use aws_config::Region;
    use aws_sdk_cloudwatchlogs::config::{BehaviorVersion, Credentials};

    let region = Region::new(params.region.clone());

    // Resolve credentials and build an SdkConfig.
    let sdk_config = match params.auth {
        CloudwatchAuth::AccessKeys => {
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

        CloudwatchAuth::Profile => {
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

    // Build CloudWatch Logs client.
    let client = CwClient::new(&sdk_config);

    // Verify credentials via STS GetCallerIdentity.
    let sts = StsClient::new(&sdk_config);
    let identity = sts
        .get_caller_identity()
        .send()
        .await
        .map_err(|e| sdk_error_to_app_err(&e))?;

    let account_id = identity.account.unwrap_or_default();
    let identity_arn = identity.arn.unwrap_or_default();

    Ok(BuiltClient {
        client,
        account_id,
        identity_arn,
        region: params.region.clone(),
    })
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_client() -> CwClient {
        use aws_sdk_cloudwatchlogs::config::{BehaviorVersion, Credentials, Region};
        let config = aws_sdk_cloudwatchlogs::Config::builder()
            .region(Region::new("us-east-1"))
            .credentials_provider(Credentials::new("AKIATEST", "secret", None, None, "test"))
            .behavior_version(BehaviorVersion::latest())
            .build();
        CwClient::from_conf(config)
    }

    fn make_active() -> ActiveCloudwatchClient {
        ActiveCloudwatchClient {
            client: make_test_client(),
            account_id: "123456789012".into(),
            identity_arn: "arn:aws:iam::123456789012:user/test".into(),
            region: "us-east-1".into(),
            connected_at_unix_ms: 0,
        }
    }

    #[tokio::test]
    async fn insert_and_is_active() {
        let reg = CloudwatchClientRegistry::new();
        let id = Uuid::new_v4();
        assert!(!reg.is_active(&id).await);
        reg.insert(id, make_active()).await;
        assert!(reg.is_active(&id).await);
    }

    #[tokio::test]
    async fn remove_returns_false_when_not_present() {
        let reg = CloudwatchClientRegistry::new();
        let id = Uuid::new_v4();
        assert!(!reg.remove(&id).await);
    }

    #[tokio::test]
    async fn acquire_returns_not_found_when_absent() {
        let reg = CloudwatchClientRegistry::new();
        let id = Uuid::new_v4();
        let err = reg.acquire(&id).await.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn snapshot_returns_view() {
        let reg = CloudwatchClientRegistry::new();
        let id = Uuid::new_v4();
        reg.insert(id, make_active()).await;
        let view = reg.snapshot(&id).await.unwrap();
        assert_eq!(view.id, id);
        assert_eq!(view.region, "us-east-1");
        assert_eq!(view.account_id, "123456789012");
    }

    #[tokio::test]
    async fn list_active_includes_registered() {
        let reg = CloudwatchClientRegistry::new();
        let id = Uuid::new_v4();
        reg.insert(id, make_active()).await;
        let list = reg.list_active().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, id);
    }

    #[tokio::test]
    async fn disconnect_all_clears_all() {
        let reg = CloudwatchClientRegistry::new();
        reg.insert(Uuid::new_v4(), make_active()).await;
        reg.insert(Uuid::new_v4(), make_active()).await;
        let count = reg.disconnect_all().await;
        assert_eq!(count, 2);
        assert!(reg.list_active().await.is_empty());
    }
}
