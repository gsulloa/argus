//! Shared detection logic for local CLI AI providers (Claude Code, OpenAI Codex).
//!
//! A provider binary is located by resolving a single canonical path, used for
//! both validation (`--version` probe) and spawning, so a CLI that validates
//! also runs. Resolution order:
//!   1. Explicit environment override (`ARGUS_CLAUDE_BIN` / `ARGUS_CODEX_BIN`).
//!   2. Lookup on the (startup-enriched) process `PATH`.
//!   3. A fixed list of well-known install locations.
//!   4. Last resort: the bare command name, so the OS gets a final shot
//!      (preserves prior behaviour and Windows PATHEXT resolution).
//!
//! When detection fails the diagnostic distinguishes "PATH enrichment was
//! skipped" (and why) from "binary genuinely absent", and always lists the
//! remediation options.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use crate::modules::ai::types::ValidationResult;

const VALIDATION_TIMEOUT: Duration = Duration::from_secs(3);

/// Outcome of the startup macOS shell-PATH enrichment (`path_fix`). Recorded
/// once at startup and read by detection diagnostics so an unavailable provider
/// can explain *why* its binary was not found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnrichmentOutcome {
    /// PATH was enriched from the login shell (or already complete).
    Succeeded,
    /// Not macOS — no enrichment is attempted.
    NotMacos,
    /// The shell probe exceeded its timeout.
    SkippedTimeout,
    /// The shell probe failed to run or exited unusably.
    SkippedShellError,
    /// The shell probe ran but yielded no usable PATH entries.
    SkippedNoEntries,
}

static ENRICHMENT_OUTCOME: OnceLock<EnrichmentOutcome> = OnceLock::new();

/// Record the startup PATH-enrichment outcome. First write wins.
pub fn record_enrichment_outcome(outcome: EnrichmentOutcome) {
    let _ = ENRICHMENT_OUTCOME.set(outcome);
}

/// The recorded PATH-enrichment outcome, if startup has set it.
pub fn enrichment_outcome() -> Option<EnrichmentOutcome> {
    ENRICHMENT_OUTCOME.get().copied()
}

/// Resolve the canonical path of a CLI binary. Always returns a value: if no
/// existing candidate is found it falls back to the bare `name`, letting the OS
/// attempt its own resolution at spawn time.
///
/// `env_var` is the provider's absolute-path override (e.g. `ARGUS_CLAUDE_BIN`).
///
/// Naming convention: these override variables are `<ENV_VAR_PREFIX>_<PROVIDER>_BIN`
/// where the prefix is `config::app_identity::ENV_VAR_PREFIX` (`ARGUS`). They are
/// passed as literals at call sites (codex_cli.rs / claude_cli.rs); a rename must
/// update both the literals and `ENV_VAR_PREFIX`, and is documented in RENAMING.md.
pub fn resolve_cli_bin(name: &str, env_var: &str) -> PathBuf {
    // 1. Explicit override — trusted as-is (the user set it deliberately).
    if let Some(val) = std::env::var_os(env_var) {
        if !val.is_empty() {
            return PathBuf::from(val);
        }
    }

    // 2. Lookup on the enriched process PATH.
    if let Some(p) = lookup_on_path(name) {
        return p;
    }

    // 3. Well-known install locations.
    if let Some(p) = fallback_candidates(name)
        .into_iter()
        .find(|p| is_executable_file(p))
    {
        return p;
    }

    // 4. Last resort: bare name (OS PATH / PATHEXT resolution at spawn time).
    PathBuf::from(name)
}

/// Resolve and version-probe a CLI binary, returning a `ValidationResult`.
/// This is the single combined entry point so resolution does not double-spawn
/// `--version`.
pub async fn validate_cli(name: &str, env_var: &str) -> ValidationResult {
    let bin = resolve_cli_bin(name, env_var);
    match timeout(VALIDATION_TIMEOUT, version_probe(&bin)).await {
        Ok(Ok(())) => ValidationResult::Ready,
        Ok(Err(probe_err)) => ValidationResult::Missing {
            hint: missing_hint(name, env_var, &bin, Some(&probe_err)),
        },
        Err(_) => ValidationResult::Missing {
            hint: format!("`{name}` did not respond to --version within 3 seconds"),
        },
    }
}

/// Run `<bin> --version`, discarding output. `Ok(())` on a zero exit code.
async fn version_probe(bin: &Path) -> Result<(), String> {
    let status = Command::new(bin)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status()
        .await
        .map_err(|e| format!("could not spawn `{}`: {e}", bin.display()))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("`--version` exited with code {:?}", status.code()))
    }
}

/// Build the user-facing diagnostic for an unavailable provider. Incorporates
/// the startup PATH-enrichment outcome and always lists the three remediations.
fn missing_hint(name: &str, env_var: &str, tried: &Path, probe_err: Option<&str>) -> String {
    let mut s = format!("Could not run `{name}` (tried `{}`).", tried.display());
    if let Some(e) = probe_err {
        s.push(' ');
        s.push_str(e);
        s.push('.');
    }
    match enrichment_outcome() {
        Some(EnrichmentOutcome::SkippedTimeout) => s.push_str(
            " Argus's shell PATH probe timed out at startup, so directories from your \
shell config may be missing from the search path.",
        ),
        Some(EnrichmentOutcome::SkippedShellError) => s.push_str(
            " Argus's shell PATH probe failed at startup, so directories from your \
shell config may be missing from the search path.",
        ),
        Some(EnrichmentOutcome::SkippedNoEntries) => s.push_str(
            " Argus's shell PATH probe returned no usable entries at startup, so \
directories from your shell config may be missing from the search path.",
        ),
        _ => {}
    }
    s.push_str(&format!(
        " Fix: (a) ensure `{name}` is on your login-shell PATH (e.g. ~/.zshrc or \
~/.zprofile), (b) symlink it into /usr/local/bin, or (c) set {env_var} to the \
absolute path of the binary."
    ));
    s
}

/// Find `name` on the process `PATH`, returning the first executable match.
fn lookup_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(name))
        .find(|cand| is_executable_file(cand))
}

/// Well-known locations where the Claude / Codex CLIs are commonly installed
/// when they are not on the login-shell PATH. Probed only after PATH lookup
/// fails. Paths that don't exist on the current platform are simply skipped by
/// the existence check in `resolve_cli_bin`.
fn fallback_candidates(name: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();

    if let Some(home) = home_dir() {
        // Claude Code native installer.
        out.push(home.join(".claude").join("local").join(name));
        // XDG-ish user bin (Codex installer, pipx, cargo-style).
        out.push(home.join(".local").join("bin").join(name));
        // Common npm-global prefix without root.
        out.push(home.join(".npm-global").join("bin").join(name));
        // bun default install dir.
        out.push(home.join(".bun").join("bin").join(name));
    }

    // npm / bun honour these env vars for their global prefix.
    if let Some(prefix) = std::env::var_os("npm_config_prefix") {
        out.push(PathBuf::from(prefix).join("bin").join(name));
    }
    if let Some(bun) = std::env::var_os("BUN_INSTALL") {
        out.push(PathBuf::from(bun).join("bin").join(name));
    }

    // Homebrew (Apple Silicon and Intel) and the default launchd PATH location.
    out.push(PathBuf::from("/opt/homebrew/bin").join(name));
    out.push(PathBuf::from("/usr/local/bin").join(name));

    out
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// True if `p` is a regular file and (on Unix) has an executable bit set.
fn is_executable_file(p: &Path) -> bool {
    if !p.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_override_wins() {
        // set_var is racy under the parallel runner; this test uses a unique var
        // name so it doesn't interfere with the providers' own env tests.
        std::env::set_var("ARGUS_TEST_DETECT_BIN", "/custom/path/widget");
        let p = resolve_cli_bin("widget", "ARGUS_TEST_DETECT_BIN");
        assert_eq!(p, PathBuf::from("/custom/path/widget"));
        std::env::remove_var("ARGUS_TEST_DETECT_BIN");
    }

    #[test]
    fn empty_env_override_is_ignored() {
        std::env::remove_var("ARGUS_TEST_DETECT_EMPTY");
        std::env::set_var("ARGUS_TEST_DETECT_EMPTY", "");
        // A binary name that cannot exist anywhere → falls back to the bare name.
        let p = resolve_cli_bin("argus-nonexistent-binary-xyz", "ARGUS_TEST_DETECT_EMPTY");
        assert_eq!(p, PathBuf::from("argus-nonexistent-binary-xyz"));
        std::env::remove_var("ARGUS_TEST_DETECT_EMPTY");
    }

    #[test]
    fn unresolvable_binary_falls_back_to_bare_name() {
        std::env::remove_var("ARGUS_TEST_DETECT_NONE");
        let p = resolve_cli_bin("argus-nonexistent-binary-xyz", "ARGUS_TEST_DETECT_NONE");
        assert_eq!(p, PathBuf::from("argus-nonexistent-binary-xyz"));
    }

    #[test]
    fn fallback_candidates_include_well_known_locations() {
        let cands = fallback_candidates("claude");
        // Homebrew + /usr/local are always present regardless of HOME.
        assert!(cands.contains(&PathBuf::from("/opt/homebrew/bin/claude")));
        assert!(cands.contains(&PathBuf::from("/usr/local/bin/claude")));
    }

    #[test]
    fn missing_hint_mentions_remediations_and_enrichment() {
        // Without a recorded outcome, the hint still lists the three fixes.
        let hint = missing_hint(
            "claude",
            "ARGUS_CLAUDE_BIN",
            Path::new("claude"),
            Some("`--version` exited with code Some(1)"),
        );
        assert!(hint.contains("ARGUS_CLAUDE_BIN"));
        assert!(hint.contains("/usr/local/bin"));
        assert!(hint.contains("login-shell PATH"));
    }
}
