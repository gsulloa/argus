use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::error::{AppError, AppResult};
use crate::modules::dynamo::params::is_known_region;

// Re-export the region list under the Athena name for symmetry.
pub use crate::modules::dynamo::params::AWS_REGIONS;

// ---------------------------------------------------------------------------
// Auth mode enum
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AthenaAuth {
    AccessKeys,
    Profile,
}

// ---------------------------------------------------------------------------
// AthenaParams struct
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AthenaParams {
    pub region: String,
    pub workgroup: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub output_location: Option<String>,
    pub auth: AthenaAuth,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub read_only: bool,
}

impl AthenaParams {
    pub fn from_json(value: &JsonValue) -> AppResult<Self> {
        serde_json::from_value::<AthenaParams>(value.clone())
            .map_err(|e| AppError::Validation(format!("invalid athena params: {e}")))
    }

    pub fn to_json(&self) -> AppResult<JsonValue> {
        serde_json::to_value(self).map_err(AppError::from)
    }

    /// Validate params plus optional secret.
    ///
    /// For `access_keys` auth, `secret` must be a JSON string with
    /// `{ access_key_id, secret_access_key, session_token? }`.
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

        // --- Workgroup ---
        if self.workgroup.trim().is_empty() {
            return Err(AppError::Validation("workgroup is required".into()));
        }

        // --- Output location (optional but must be s3:// if present) ---
        if let Some(loc) = &self.output_location {
            if !loc.trim().is_empty() && !loc.starts_with("s3://") {
                return Err(AppError::Validation(
                    "output_location must be a valid s3:// URI".into(),
                ));
            }
        }

        // --- Auth-mode specific ---
        match self.auth {
            AthenaAuth::Profile => match &self.profile {
                None => {
                    return Err(AppError::Validation(
                        "profile is required when auth = profile".into(),
                    ))
                }
                Some(p) if p.trim().is_empty() => {
                    return Err(AppError::Validation(
                        "profile is required when auth = profile".into(),
                    ))
                }
                _ => {}
            },
            AthenaAuth::AccessKeys => {
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
                // session_token is optional.
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

    fn access_keys_params() -> AthenaParams {
        AthenaParams {
            auth: AthenaAuth::AccessKeys,
            profile: None,
            region: "us-east-1".into(),
            workgroup: "primary".into(),
            output_location: None,
            read_only: false,
        }
    }

    fn profile_params() -> AthenaParams {
        AthenaParams {
            auth: AthenaAuth::Profile,
            profile: Some("default".into()),
            region: "us-east-1".into(),
            workgroup: "primary".into(),
            output_location: None,
            read_only: false,
        }
    }

    #[test]
    fn valid_access_keys_round_trip() {
        let p = access_keys_params();
        let json = p.to_json().unwrap();
        let p2 = AthenaParams::from_json(&json).unwrap();
        assert_eq!(p2.auth, AthenaAuth::AccessKeys);
        assert_eq!(p2.region, "us-east-1");
        p2.validate(Some(valid_secret())).unwrap();
    }

    #[test]
    fn valid_profile_round_trip() {
        let p = profile_params();
        let json = p.to_json().unwrap();
        let p2 = AthenaParams::from_json(&json).unwrap();
        assert_eq!(p2.auth, AthenaAuth::Profile);
        assert_eq!(p2.profile.as_deref(), Some("default"));
        p2.validate(None).unwrap();
    }

    #[test]
    fn rejects_missing_region() {
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
    fn rejects_empty_workgroup() {
        let mut p = access_keys_params();
        p.workgroup = "   ".into();
        assert!(matches!(
            p.validate(Some(valid_secret())),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn rejects_invalid_output_location() {
        let mut p = access_keys_params();
        p.output_location = Some("http://example.com/bucket".into());
        assert!(matches!(
            p.validate(Some(valid_secret())),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn accepts_valid_s3_output_location() {
        let mut p = access_keys_params();
        p.output_location = Some("s3://my-bucket/prefix/".into());
        p.validate(Some(valid_secret())).unwrap();
    }

    #[test]
    fn accepts_none_output_location() {
        let mut p = access_keys_params();
        p.output_location = None;
        p.validate(Some(valid_secret())).unwrap();
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
        assert!(matches!(
            p.validate(Some(secret)),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn rejects_empty_secret_access_key() {
        let p = access_keys_params();
        let secret = r#"{"access_key_id":"AKID","secret_access_key":""}"#;
        assert!(matches!(
            p.validate(Some(secret)),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn read_only_defaults_to_false() {
        let json = serde_json::json!({
            "region": "us-east-1",
            "workgroup": "primary",
            "auth": "profile",
            "profile": "default"
        });
        let p = AthenaParams::from_json(&json).unwrap();
        assert!(!p.read_only);
    }
}
