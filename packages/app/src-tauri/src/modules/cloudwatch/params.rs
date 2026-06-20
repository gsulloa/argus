//! CloudWatch Logs connection parameters.

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::error::{AppError, AppResult};
use crate::modules::dynamo::params::is_known_region;

// ---------------------------------------------------------------------------
// Auth mode enum
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CloudwatchAuth {
    AccessKeys,
    Profile,
}

// ---------------------------------------------------------------------------
// CloudwatchParams struct
// ---------------------------------------------------------------------------

/// Parameters for a CloudWatch Logs connection.
///
/// No `read_only` field — CloudWatch Logs is read-only by nature in Argus.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudwatchParams {
    pub region: String,
    pub auth: CloudwatchAuth,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub profile: Option<String>,
}

impl CloudwatchParams {
    // -----------------------------------------------------------------------
    // JSON helpers
    // -----------------------------------------------------------------------

    pub fn from_json(value: &JsonValue) -> AppResult<Self> {
        serde_json::from_value::<CloudwatchParams>(value.clone())
            .map_err(|e| AppError::Validation(format!("invalid cloudwatch params: {e}")))
    }

    pub fn to_json(&self) -> AppResult<JsonValue> {
        serde_json::to_value(self).map_err(AppError::from)
    }

    // -----------------------------------------------------------------------
    // Validation
    // -----------------------------------------------------------------------

    /// Validates params plus the optional keychain secret payload.
    ///
    /// `secret` must be `Some(json_string)` when `auth == AccessKeys`.
    /// The JSON string must decode to an object with non-empty
    /// `access_key_id` and `secret_access_key` fields.
    pub fn validate(&self, secret: Option<&str>) -> AppResult<()> {
        // --- Region ---
        if self.region.is_empty() {
            return Err(AppError::Validation("region is required".into()));
        }
        if !is_known_region(&self.region) {
            return Err(AppError::Validation(format!(
                "unknown AWS region: {}",
                self.region
            )));
        }

        // --- Auth-mode specific ---
        match self.auth {
            CloudwatchAuth::Profile => match &self.profile {
                None => {
                    return Err(AppError::Validation(
                        "profile is required when auth = profile".into(),
                    ))
                }
                Some(p) if p.is_empty() => {
                    return Err(AppError::Validation(
                        "profile is required when auth = profile".into(),
                    ))
                }
                _ => {}
            },
            CloudwatchAuth::AccessKeys => {
                let raw = secret.ok_or_else(|| {
                    AppError::Validation("credentials are required when auth = access_keys".into())
                })?;

                let payload: JsonValue = serde_json::from_str(raw).map_err(|_| {
                    AppError::Validation("credentials payload is malformed JSON".into())
                })?;

                let access_key_id = payload
                    .get("access_key_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if access_key_id.is_empty() {
                    return Err(AppError::Validation("aws_access_key_id is required".into()));
                }

                let secret_access_key = payload
                    .get("secret_access_key")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if secret_access_key.is_empty() {
                    return Err(AppError::Validation(
                        "aws_secret_access_key is required".into(),
                    ));
                }
            }
        }

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_secret() -> &'static str {
        r#"{"access_key_id":"AKIAIOSFODNN7EXAMPLE","secret_access_key":"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}"#
    }

    fn access_keys_params() -> CloudwatchParams {
        CloudwatchParams {
            auth: CloudwatchAuth::AccessKeys,
            profile: None,
            region: "us-east-1".into(),
        }
    }

    fn profile_params() -> CloudwatchParams {
        CloudwatchParams {
            auth: CloudwatchAuth::Profile,
            profile: Some("default".into()),
            region: "us-east-1".into(),
        }
    }

    #[test]
    fn valid_access_keys_round_trip() {
        let p = access_keys_params();
        let json = p.to_json().unwrap();
        let p2 = CloudwatchParams::from_json(&json).unwrap();
        assert_eq!(p2.auth, CloudwatchAuth::AccessKeys);
        assert_eq!(p2.region, "us-east-1");
        p2.validate(Some(valid_secret())).unwrap();
    }

    #[test]
    fn valid_profile_round_trip() {
        let p = profile_params();
        let json = p.to_json().unwrap();
        let p2 = CloudwatchParams::from_json(&json).unwrap();
        assert_eq!(p2.auth, CloudwatchAuth::Profile);
        assert_eq!(p2.profile.as_deref(), Some("default"));
        p2.validate(None).unwrap();
    }

    #[test]
    fn rejects_empty_region() {
        let mut p = access_keys_params();
        p.region = "".into();
        assert!(matches!(
            p.validate(Some(valid_secret())),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn rejects_unknown_region() {
        let mut p = access_keys_params();
        p.region = "us-mars-1".into();
        let err = p.validate(Some(valid_secret())).unwrap_err();
        match err {
            AppError::Validation(msg) => assert!(msg.contains("us-mars-1")),
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[test]
    fn rejects_missing_profile_in_profile_mode() {
        let mut p = profile_params();
        p.profile = None;
        assert!(matches!(p.validate(None), Err(AppError::Validation(_))));
    }

    #[test]
    fn rejects_empty_profile_in_profile_mode() {
        let mut p = profile_params();
        p.profile = Some("".into());
        assert!(matches!(p.validate(None), Err(AppError::Validation(_))));
    }

    #[test]
    fn rejects_missing_secret_in_access_keys() {
        let p = access_keys_params();
        assert!(matches!(p.validate(None), Err(AppError::Validation(_))));
    }

    #[test]
    fn rejects_empty_access_key_id() {
        let p = access_keys_params();
        let secret = r#"{"access_key_id":"","secret_access_key":"x"}"#;
        let err = p.validate(Some(secret)).unwrap_err();
        match err {
            AppError::Validation(msg) => assert!(msg.contains("aws_access_key_id")),
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[test]
    fn rejects_empty_secret_access_key() {
        let p = access_keys_params();
        let secret = r#"{"access_key_id":"AKID","secret_access_key":""}"#;
        let err = p.validate(Some(secret)).unwrap_err();
        match err {
            AppError::Validation(msg) => assert!(msg.contains("aws_secret_access_key")),
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[test]
    fn rejects_malformed_secret_json() {
        let p = access_keys_params();
        let err = p.validate(Some("not json")).unwrap_err();
        match err {
            AppError::Validation(msg) => assert!(msg.contains("malformed JSON")),
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[test]
    fn no_read_only_field() {
        // CloudwatchParams must not have a read_only field (CloudWatch is read-only by nature).
        let p = access_keys_params();
        let json = p.to_json().unwrap();
        assert!(
            json.get("read_only").is_none(),
            "read_only should not be serialized"
        );
    }
}
