use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use url::Url;

use crate::error::{AppError, AppResult};

// ---------------------------------------------------------------------------
// AWS region list (§2.3)
// ---------------------------------------------------------------------------

/// Canonical list of standard AWS commercial regions supported by Argus V2.1.
pub const AWS_REGIONS: &[&str] = &[
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
    "af-south-1",
    "ap-east-1",
    "ap-south-1",
    "ap-south-2",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-southeast-3",
    "ap-southeast-4",
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-northeast-3",
    "ca-central-1",
    "ca-west-1",
    "eu-central-1",
    "eu-central-2",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-north-1",
    "eu-south-1",
    "eu-south-2",
    "il-central-1",
    "me-central-1",
    "me-south-1",
    "sa-east-1",
];

/// Returns `true` when `r` is one of the known commercial AWS regions.
pub fn is_known_region(r: &str) -> bool {
    AWS_REGIONS.contains(&r)
}

// ---------------------------------------------------------------------------
// Auth mode enum (§2.1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DynamoAuth {
    AccessKeys,
    Profile,
}

// ---------------------------------------------------------------------------
// Table-name normalization rule (dynamo-table-name-normalization)
// ---------------------------------------------------------------------------

/// Per-connection rule that folds a live physical DynamoDB table name into a
/// stable logical name. Two mutually-exclusive authoring forms:
///
/// * **Simple** — optional literal `prefix` and optional regex `suffix_pattern`.
/// * **Advanced** — a single `regex` with a named capture group `logical`.
///
/// All fields absent/empty ⇒ identity transform. The fields round-trip through
/// the opaque connection `params` JSON column.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TableMatch {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub prefix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub suffix_pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub regex: Option<String>,
}

impl TableMatch {
    /// True when no field carries a non-empty value (≡ identity transform).
    pub fn is_effectively_empty(&self) -> bool {
        let empty = |o: &Option<String>| o.as_deref().map_or(true, str::is_empty);
        empty(&self.prefix) && empty(&self.suffix_pattern) && empty(&self.regex)
    }

    /// True when the advanced (`regex`) form carries a non-empty value.
    pub fn has_advanced(&self) -> bool {
        self.regex.as_deref().map_or(false, |s| !s.is_empty())
    }

    /// True when the simple (`prefix`/`suffix_pattern`) form carries a value.
    pub fn has_simple(&self) -> bool {
        self.prefix.as_deref().map_or(false, |s| !s.is_empty())
            || self.suffix_pattern.as_deref().map_or(false, |s| !s.is_empty())
    }

    /// Validate the rule:
    /// * absent/empty ⇒ Ok (identity).
    /// * the two forms are mutually exclusive.
    /// * `suffix_pattern` and `regex` must compile.
    /// * advanced-form `regex` must contain a named capture group `logical`.
    pub fn validate(&self) -> AppResult<()> {
        if self.is_effectively_empty() {
            return Ok(());
        }

        if self.has_advanced() && self.has_simple() {
            return Err(AppError::Validation(
                "table_match: use either prefix/suffix_pattern or regex, not both".into(),
            ));
        }

        if let Some(re_str) = self.regex.as_deref().filter(|s| !s.is_empty()) {
            let re = Regex::new(re_str).map_err(|e| {
                AppError::Validation(format!("table_match.regex does not compile: {e}"))
            })?;
            if !re.capture_names().flatten().any(|n| n == "logical") {
                return Err(AppError::Validation(
                    "table_match.regex must contain a named capture group `logical`".into(),
                ));
            }
        }

        if let Some(suffix) = self.suffix_pattern.as_deref().filter(|s| !s.is_empty()) {
            Regex::new(suffix).map_err(|e| {
                AppError::Validation(format!("table_match.suffix_pattern does not compile: {e}"))
            })?;
        }

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// DynamoParams struct (§2.1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DynamoParams {
    pub auth: DynamoAuth,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub profile: Option<String>,
    pub region: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub endpoint_url: Option<String>,
    pub read_only: bool,
    /// Backend-only flag set when access-keys credentials have expired.
    /// Frontend must never set this; callers use `sanitized()` to strip it
    /// before persisting params received from the frontend.
    // TODO chunk E: call DynamoParams::sanitized at create/update boundary
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub needs_credentials: Option<bool>,
    /// Optional table-name normalization rule (see `TableMatch`). Used by the
    /// context system to fold CDK-style physical table names to logical names.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub table_match: Option<TableMatch>,
}

impl DynamoParams {
    // -----------------------------------------------------------------------
    // JSON helpers (mirrors PostgresParams pattern)
    // -----------------------------------------------------------------------

    pub fn from_json(value: &JsonValue) -> AppResult<Self> {
        serde_json::from_value::<DynamoParams>(value.clone())
            .map_err(|e| AppError::Validation(format!("invalid dynamo params: {e}")))
    }

    pub fn to_json(&self) -> AppResult<JsonValue> {
        serde_json::to_value(self).map_err(AppError::from)
    }

    // -----------------------------------------------------------------------
    // Sanitisation: strip frontend-injected `needs_credentials` (§2.2)
    // -----------------------------------------------------------------------

    /// Returns a copy of `self` with `needs_credentials` cleared.
    /// Call this at the create/update boundary so the frontend cannot set the
    /// flag directly; only the backend sets it when a session token expires.
    pub fn sanitized(mut self) -> Self {
        self.needs_credentials = None;
        self
    }

    // -----------------------------------------------------------------------
    // Validation (§2.2)
    // -----------------------------------------------------------------------

    /// Validates params plus the optional keychain secret payload.
    ///
    /// `secret` must be `Some(json_string)` when `auth == AccessKeys`.
    /// The JSON string must decode to an object with non-empty
    /// `access_key_id` and `secret_access_key` fields.
    pub fn validate(&self, secret: Option<&str>) -> AppResult<()> {
        // --- Universal: region ---
        if self.region.is_empty() {
            return Err(AppError::Validation("region is required".into()));
        }
        if !is_known_region(&self.region) {
            return Err(AppError::Validation(format!(
                "unknown AWS region: {}",
                self.region
            )));
        }

        // --- Universal: endpoint_url ---
        if let Some(url_str) = &self.endpoint_url {
            Url::parse(url_str)
                .map_err(|_| AppError::Validation("endpoint_url is not a valid URL".into()))?;
        }

        // --- Universal: table_match normalization rule ---
        if let Some(tm) = &self.table_match {
            tm.validate()?;
        }

        // --- Auth-mode specific ---
        match self.auth {
            DynamoAuth::Profile => match &self.profile {
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
            DynamoAuth::AccessKeys => {
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

                // session_token is optional — no validation required.
            }
        }

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Unit tests (§2.4)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_secret() -> &'static str {
        r#"{"access_key_id":"AKIAIOSFODNN7EXAMPLE","secret_access_key":"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}"#
    }

    fn access_keys_params() -> DynamoParams {
        DynamoParams {
            auth: DynamoAuth::AccessKeys,
            profile: None,
            region: "us-east-1".into(),
            endpoint_url: None,
            read_only: false,
            needs_credentials: None,
            table_match: None,
        }
    }

    fn profile_params() -> DynamoParams {
        DynamoParams {
            auth: DynamoAuth::Profile,
            profile: Some("default".into()),
            region: "us-east-1".into(),
            endpoint_url: None,
            read_only: false,
            needs_credentials: None,
            table_match: None,
        }
    }

    // 2.4.1 — access-keys round-trip through JSON + validate
    #[test]
    fn valid_access_keys_round_trip() {
        let p = access_keys_params();
        let json = p.to_json().unwrap();
        let p2 = DynamoParams::from_json(&json).unwrap();
        assert_eq!(p2.auth, DynamoAuth::AccessKeys);
        assert_eq!(p2.region, "us-east-1");
        p2.validate(Some(valid_secret())).unwrap();
    }

    // 2.4.2 — profile round-trip through JSON + validate
    #[test]
    fn valid_profile_round_trip() {
        let p = profile_params();
        let json = p.to_json().unwrap();
        let p2 = DynamoParams::from_json(&json).unwrap();
        assert_eq!(p2.auth, DynamoAuth::Profile);
        assert_eq!(p2.profile.as_deref(), Some("default"));
        p2.validate(None).unwrap();
    }

    // 2.4.3 — empty region rejected
    #[test]
    fn rejects_missing_region() {
        let mut p = access_keys_params();
        p.region = "".into();
        assert!(matches!(
            p.validate(Some(valid_secret())),
            Err(AppError::Validation(_))
        ));
    }

    // 2.4.4 — unrecognised region rejected
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

    // 2.4.5 — profile=None in profile mode
    #[test]
    fn rejects_missing_profile_in_profile_mode() {
        let mut p = profile_params();
        p.profile = None;
        assert!(matches!(p.validate(None), Err(AppError::Validation(_))));
    }

    // 2.4.6 — profile=Some("") in profile mode
    #[test]
    fn rejects_empty_profile_in_profile_mode() {
        let mut p = profile_params();
        p.profile = Some("".into());
        assert!(matches!(p.validate(None), Err(AppError::Validation(_))));
    }

    // 2.4.7 — secret=None in access-keys mode
    #[test]
    fn rejects_missing_secret_in_access_keys() {
        let p = access_keys_params();
        assert!(matches!(p.validate(None), Err(AppError::Validation(_))));
    }

    // 2.4.8 — empty access_key_id
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

    // 2.4.9 — empty secret_access_key
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

    // 2.4.10 — malformed JSON in secret
    #[test]
    fn rejects_malformed_secret_json() {
        let p = access_keys_params();
        let err = p.validate(Some("not json")).unwrap_err();
        match err {
            AppError::Validation(msg) => assert!(msg.contains("malformed JSON")),
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    // 2.4.11 — invalid endpoint URL
    #[test]
    fn rejects_malformed_endpoint_url() {
        let mut p = access_keys_params();
        p.endpoint_url = Some("not a url".into());
        assert!(matches!(
            p.validate(Some(valid_secret())),
            Err(AppError::Validation(_))
        ));
    }

    // 2.4.12 — loopback endpoint URL is accepted
    #[test]
    fn accepts_loopback_endpoint_url() {
        let mut p = access_keys_params();
        p.endpoint_url = Some("http://localhost:8000".into());
        p.validate(Some(valid_secret())).unwrap();
    }

    // 2.4.13 — sanitized() clears needs_credentials
    #[test]
    fn sanitized_clears_needs_credentials() {
        let mut p = access_keys_params();
        p.needs_credentials = Some(true);
        let p2 = p.sanitized();
        assert_eq!(p2.needs_credentials, None);
    }

    // ---- table_match validation (§2.4) ----

    // 2.4.14 — valid table_match round-trips through JSON + validate
    #[test]
    fn valid_table_match_round_trip() {
        let mut p = access_keys_params();
        p.table_match = Some(TableMatch {
            prefix: Some("MyApp-prod-".into()),
            suffix_pattern: Some("-[A-Z0-9]+$".into()),
            regex: None,
        });
        let json = p.to_json().unwrap();
        let p2 = DynamoParams::from_json(&json).unwrap();
        assert_eq!(p2.table_match, p.table_match);
        p2.validate(Some(valid_secret())).unwrap();
    }

    // 2.4.15 — malformed suffix_pattern regex rejected
    #[test]
    fn rejects_malformed_table_match_regex() {
        let mut p = access_keys_params();
        p.table_match = Some(TableMatch {
            prefix: None,
            suffix_pattern: Some("-[A-Z0-9".into()), // unbalanced
            regex: None,
        });
        assert!(matches!(
            p.validate(Some(valid_secret())),
            Err(AppError::Validation(_))
        ));
    }

    // 2.4.16 — advanced-form regex without `logical` group rejected
    #[test]
    fn rejects_advanced_regex_without_logical_group() {
        let mut p = access_keys_params();
        p.table_match = Some(TableMatch {
            prefix: None,
            suffix_pattern: None,
            regex: Some("^MyApp-prod-.+$".into()),
        });
        let err = p.validate(Some(valid_secret())).unwrap_err();
        match err {
            AppError::Validation(msg) => assert!(msg.contains("logical")),
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    // 2.4.17 — absent table_match is valid
    #[test]
    fn absent_table_match_is_valid() {
        let p = access_keys_params();
        assert!(p.table_match.is_none());
        p.validate(Some(valid_secret())).unwrap();
    }

    // 2.4.18 — empty table_match (all fields absent) is valid identity
    #[test]
    fn empty_table_match_is_valid() {
        let mut p = access_keys_params();
        p.table_match = Some(TableMatch::default());
        p.validate(Some(valid_secret())).unwrap();
    }

    // 2.4.19 — valid advanced regex with `logical` group accepted
    #[test]
    fn valid_advanced_regex_accepted() {
        let mut p = access_keys_params();
        p.table_match = Some(TableMatch {
            prefix: None,
            suffix_pattern: None,
            regex: Some("^MyApp-prod-(?<logical>.+?)-[A-Z0-9]+$".into()),
        });
        p.validate(Some(valid_secret())).unwrap();
    }

    // 2.4.20 — mixing simple and advanced forms rejected
    #[test]
    fn rejects_mixing_simple_and_advanced() {
        let mut p = access_keys_params();
        p.table_match = Some(TableMatch {
            prefix: Some("MyApp-".into()),
            suffix_pattern: None,
            regex: Some("^(?<logical>.+)$".into()),
        });
        assert!(matches!(
            p.validate(Some(valid_secret())),
            Err(AppError::Validation(_))
        ));
    }
}
