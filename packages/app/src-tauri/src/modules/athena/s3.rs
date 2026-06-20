//! S3 browse helpers for choosing an Athena query-results output location.
//!
//! These commands build an S3 client from the *form's* `AthenaParams` + secret
//! using the exact same credential resolution as the Athena/Glue clients
//! (`build_sdk_config`), so the bucket list the user browses always matches the
//! credentials they selected for the connection.

use aws_sdk_s3::Client as S3Client;
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::modules::athena::client::build_sdk_config;
use crate::modules::athena::errors::map_sdk_err_with_profile;
use crate::modules::athena::params::AthenaParams;

/// A common prefix ("folder") under an S3 bucket.
#[derive(Debug, Serialize)]
pub struct S3Prefix {
    /// The full key prefix, e.g. `athena-results/`.
    pub prefix: String,
}

fn parse_params(params: serde_json::Value) -> AppResult<AthenaParams> {
    serde_json::from_value(params).map_err(|e| AppError::Validation(format!("invalid params: {e}")))
}

/// List all S3 buckets visible to the form's credentials.
///
/// Used by the connection form to help the user pick an output-location bucket.
#[tauri::command]
pub async fn athena_list_s3_buckets(
    params: serde_json::Value,
    secret: Option<String>,
) -> AppResult<Vec<String>> {
    let parsed = parse_params(params)?;
    let sdk_config = build_sdk_config(&parsed, secret.as_deref()).await?;
    let s3 = S3Client::new(&sdk_config);

    let resp = s3
        .list_buckets()
        .send()
        .await
        .map_err(|e| map_sdk_err_with_profile(&e, parsed.profile.as_deref()))?;

    let mut names: Vec<String> = resp
        .buckets()
        .iter()
        .filter_map(|b| b.name().map(String::from))
        .collect();
    names.sort();
    Ok(names)
}

/// List the top-level "folders" (common prefixes) under a bucket, optionally
/// scoped to a `prefix`. Lets the user drill into a results folder rather than
/// dumping query output at the bucket root.
#[tauri::command]
pub async fn athena_list_s3_prefixes(
    params: serde_json::Value,
    secret: Option<String>,
    bucket: String,
    prefix: Option<String>,
) -> AppResult<Vec<S3Prefix>> {
    let parsed = parse_params(params)?;
    let sdk_config = build_sdk_config(&parsed, secret.as_deref()).await?;
    let s3 = S3Client::new(&sdk_config);

    let resp = s3
        .list_objects_v2()
        .bucket(&bucket)
        .delimiter("/")
        .set_prefix(prefix.filter(|p| !p.is_empty()))
        .max_keys(1000)
        .send()
        .await
        .map_err(|e| map_sdk_err_with_profile(&e, parsed.profile.as_deref()))?;

    let prefixes: Vec<S3Prefix> = resp
        .common_prefixes()
        .iter()
        .filter_map(|p| {
            p.prefix().map(|s| S3Prefix {
                prefix: s.to_string(),
            })
        })
        .collect();
    Ok(prefixes)
}
