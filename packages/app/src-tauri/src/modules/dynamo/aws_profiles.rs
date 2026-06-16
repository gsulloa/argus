use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProfileInfo {
    pub name: String,
    pub sso: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
}

/// Public entry point — resolves `~/.aws/credentials` and `~/.aws/config`
/// from `HOME` (or `USERPROFILE` on Windows) and delegates to
/// `list_profiles_from`.  Re-reads the filesystem on every call; no caching.
pub fn list_profiles() -> AppResult<Vec<ProfileInfo>> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| AppError::Internal("HOME not set".into()))?;
    let base = PathBuf::from(&home).join(".aws");
    list_profiles_from(&base.join("credentials"), &base.join("config"))
}

/// Testable inner implementation that accepts explicit paths.
pub(crate) fn list_profiles_from(
    creds_path: &Path,
    config_path: &Path,
) -> AppResult<Vec<ProfileInfo>> {
    let creds = read_optional(creds_path)?;
    let cfg = read_optional(config_path)?;

    let mut merged: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();

    // ~/.aws/credentials: section name is the bare profile name.
    for (section, kvs) in parse_ini(&creds) {
        merged.entry(section).or_default().extend(kvs);
    }

    // ~/.aws/config: "[profile foo]" → "foo", "[default]" → "default".
    // All other section types (e.g. "[sso-session …]", "[services …]") are skipped.
    for (section, kvs) in parse_ini(&cfg) {
        let name = if section == "default" {
            "default".to_string()
        } else if let Some(rest) = section.strip_prefix("profile ") {
            rest.to_string()
        } else {
            continue;
        };
        let entry = merged.entry(name).or_default();
        for (k, v) in kvs {
            // credentials file wins on key conflicts.
            entry.entry(k).or_insert(v);
        }
    }

    let mut out: Vec<ProfileInfo> = merged
        .into_iter()
        .map(|(name, kvs)| {
            let sso = kvs.contains_key("sso_session")
                || kvs.contains_key("sso_start_url")
                || kvs.contains_key("sso_account_id");
            let region = kvs.get("region").cloned();
            ProfileInfo { name, sso, region }
        })
        .collect();

    // Stable sort: alphabetical by name.
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Read a file to a string; treat "not found" as an empty string rather than
/// an error, since either AWS file may legitimately be absent.
fn read_optional(path: &Path) -> AppResult<String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(AppError::Internal(format!(
            "read {}: {}",
            path.display(),
            e
        ))),
    }
}

/// Minimal INI parser for AWS credential/config files.
///
/// Rules:
/// - Lines starting with `;` or `#` are comments and ignored.
/// - Blank lines are ignored.
/// - `[section name]` starts a new section.
/// - `key = value` (or `key=value`) adds a key to the current section.
/// - Whitespace around section names and key/value tokens is trimmed.
/// - Multi-value continuation lines (indented) are not used by the keys we
///   care about, so we don't implement them.
fn parse_ini(src: &str) -> Vec<(String, BTreeMap<String, String>)> {
    let mut sections: Vec<(String, BTreeMap<String, String>)> = Vec::new();
    let mut cur: Option<(String, BTreeMap<String, String>)> = None;

    for raw_line in src.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            if let Some(sec) = cur.take() {
                sections.push(sec);
            }
            cur = Some((name.trim().to_string(), BTreeMap::new()));
        } else if let Some((k, v)) = line.split_once('=') {
            if let Some((_, kvs)) = cur.as_mut() {
                kvs.insert(k.trim().to_string(), v.trim().to_string());
            }
            // Key/value before any section header is silently ignored.
        }
    }
    if let Some(sec) = cur.take() {
        sections.push(sec);
    }
    sections
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    fn tmp_dir() -> tempfile::TempDir {
        tempfile::TempDir::new().expect("tempdir")
    }

    fn write(dir: &tempfile::TempDir, name: &str, content: &str) -> PathBuf {
        let p = dir.path().join(name);
        fs::write(&p, content).expect("write fixture");
        p
    }

    fn absent(dir: &tempfile::TempDir, name: &str) -> PathBuf {
        dir.path().join(name)
    }

    // ---------------------------------------------------------------------------
    // Tests
    // ---------------------------------------------------------------------------

    #[test]
    fn both_files_missing_returns_empty() {
        let dir = tmp_dir();
        let creds = absent(&dir, "credentials");
        let cfg = absent(&dir, "config");
        let result = list_profiles_from(&creds, &cfg).unwrap();
        assert!(result.is_empty(), "expected empty list, got {:?}", result);
    }

    #[test]
    fn credentials_only_access_keys_profile() {
        let dir = tmp_dir();
        let creds = write(
            &dir,
            "credentials",
            "[work]\naws_access_key_id=AKIAIOSFODNN7EXAMPLE\naws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
        );
        let cfg = absent(&dir, "config");
        let result = list_profiles_from(&creds, &cfg).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0],
            ProfileInfo {
                name: "work".into(),
                sso: false,
                region: None,
            }
        );
    }

    #[test]
    fn config_only_sso_profile() {
        let dir = tmp_dir();
        let creds = absent(&dir, "credentials");
        let cfg = write(
            &dir,
            "config",
            "[profile sso-prod]\nsso_session=corp\nsso_start_url=https://example.com/start\nregion=us-east-1\n",
        );
        let result = list_profiles_from(&creds, &cfg).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0],
            ProfileInfo {
                name: "sso-prod".into(),
                sso: true,
                region: Some("us-east-1".into()),
            }
        );
    }

    #[test]
    fn merged_profile_credentials_overrides_config() {
        let dir = tmp_dir();
        let creds = write(
            &dir,
            "credentials",
            "[work]\nregion=us-west-2\naws_access_key_id=AKIA\n",
        );
        let cfg = write(&dir, "config", "[profile work]\nregion=eu-central-1\n");
        let result = list_profiles_from(&creds, &cfg).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].region.as_deref(), Some("us-west-2"));
    }

    #[test]
    fn default_profile_unprefixed_in_config() {
        let dir = tmp_dir();
        let creds = absent(&dir, "credentials");
        let cfg = write(&dir, "config", "[default]\nregion=us-east-1\n");
        let result = list_profiles_from(&creds, &cfg).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "default");
        assert_eq!(result[0].region.as_deref(), Some("us-east-1"));
    }

    #[test]
    fn ignores_unknown_sections_in_config() {
        let dir = tmp_dir();
        let creds = absent(&dir, "credentials");
        let cfg = write(
            &dir,
            "config",
            "[services foo]\nendpoint_url=https://example.com\n\n[profile valid]\nregion=us-west-1\n",
        );
        let result = list_profiles_from(&creds, &cfg).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "valid");
    }

    #[test]
    fn sso_via_account_id_only() {
        let dir = tmp_dir();
        let creds = absent(&dir, "credentials");
        let cfg = write(
            &dir,
            "config",
            "[profile corp]\nsso_account_id=123456789012\nregion=eu-west-1\n",
        );
        let result = list_profiles_from(&creds, &cfg).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0],
            ProfileInfo {
                name: "corp".into(),
                sso: true,
                region: Some("eu-west-1".into()),
            }
        );
    }
}
