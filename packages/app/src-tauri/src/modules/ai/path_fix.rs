/// Inherit the login-shell PATH on macOS so that CLI tools installed via
/// Homebrew, npm, bun, cargo, nvm, asdf, etc. are found when the app is
/// launched from Finder, the Dock, or the auto-updater (where launchd gives
/// the process only `/usr/bin:/bin:/usr/sbin:/sbin`).
///
/// The same technique is used by VS Code (`fix-path` npm package) and
/// GitHub Desktop. It is a no-op on non-macOS platforms.
///
/// Safety: never panics, never blocks for more than 2 seconds.

use crate::modules::ai::cli_detect::{record_enrichment_outcome, EnrichmentOutcome};

#[cfg(not(target_os = "macos"))]
pub fn fix_macos_path() {
    // No-op on non-macOS — but record the outcome so detection diagnostics can
    // explain that no shell-PATH enrichment was attempted.
    record_enrichment_outcome(EnrichmentOutcome::NotMacos);
}

#[cfg(target_os = "macos")]
pub fn fix_macos_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let (program, args) = shell_probe_command(&shell);

    // Spawn the interactive login shell in a background thread. We communicate
    // the result back via an mpsc channel, then recv_timeout below.
    let (tx, rx) = std::sync::mpsc::channel::<std::io::Result<std::process::Output>>();

    std::thread::spawn(move || {
        let result = std::process::Command::new(&program)
            .args(&args)
            // Redirect stdin from /dev/null so an interactive shell never blocks
            // waiting on input at startup.
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output();
        // send() fails only if the receiver has dropped (timeout elapsed), which is fine.
        let _ = tx.send(result);
    });

    // Interactive shells (oh-my-zsh, nvm/fnm lazy-load) can take several seconds
    // to initialise, so allow up to 5s.
    let output = match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            tracing::warn!("fix_macos_path: failed to run login shell `{shell}`: {e}");
            record_enrichment_outcome(EnrichmentOutcome::SkippedShellError);
            return;
        }
        Err(_) => {
            tracing::warn!(
                "fix_macos_path: login shell `{shell}` timed out after 5s — skipping PATH merge"
            );
            record_enrichment_outcome(EnrichmentOutcome::SkippedTimeout);
            return;
        }
    };

    if !output.status.success() {
        tracing::warn!(
            "fix_macos_path: login shell exited with {:?}, stderr: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
        // Still try to parse stdout in case some entries came through.
    }

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();

    let shell_entries = match parse_shell_path(&stdout) {
        Some(entries) => entries,
        None => {
            tracing::warn!(
                "fix_macos_path: could not parse PATH markers from login shell output"
            );
            record_enrichment_outcome(EnrichmentOutcome::SkippedNoEntries);
            return;
        }
    };

    // Validate: at least one entry must exist on disk.
    let any_valid = shell_entries
        .iter()
        .any(|e| std::path::Path::new(e.as_str()).exists());
    if !any_valid {
        tracing::warn!(
            "fix_macos_path: no existing paths found in login shell PATH — skipping"
        );
        record_enrichment_outcome(EnrichmentOutcome::SkippedNoEntries);
        return;
    }

    // Merge: append entries not already in the current PATH.
    let current = std::env::var("PATH").unwrap_or_default();
    let current_set: std::collections::HashSet<&str> = current.split(':').collect();

    let new_entries: Vec<&str> = shell_entries
        .iter()
        .map(|s| s.as_str())
        .filter(|e| !e.is_empty() && !current_set.contains(e))
        .collect();

    if new_entries.is_empty() {
        tracing::info!("fix_macos_path: PATH already includes all login shell entries");
        record_enrichment_outcome(EnrichmentOutcome::Succeeded);
        return;
    }

    let new_path = if current.is_empty() {
        new_entries.join(":")
    } else {
        format!("{}:{}", current, new_entries.join(":"))
    };

    // SAFETY: single-threaded startup context; no other threads are reading
    // PATH at this point.
    std::env::set_var("PATH", &new_path);

    tracing::info!(
        "fix_macos_path: appended {} entries from login shell PATH: {:?}",
        new_entries.len(),
        new_entries
    );
    record_enrichment_outcome(EnrichmentOutcome::Succeeded);
}

/// Build the `(program, args)` for the shell PATH probe.
///
/// The shell is run as an **interactive login** shell (`-i -l -c`) so that PATH
/// entries set in interactive startup files (`~/.zshrc`, `~/.bashrc` — where
/// nvm/fnm/asdf/Volta and npm-global setups overwhelmingly live) are captured,
/// not only those in login files (`~/.zprofile`, `~/.zlogin`).
///
/// `fish` represents `$PATH` as a space-separated list, so its colon-delimited
/// form must be produced explicitly with `string join`. Every other (POSIX)
/// shell expands `$PATH` colon-delimited already.
fn shell_probe_command(shell: &str) -> (String, Vec<String>) {
    let base = std::path::Path::new(shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");

    let body = if base == "fish" {
        "echo -n __ARGUS_PATH_START__:(string join : $PATH):__ARGUS_PATH_END__".to_string()
    } else {
        "echo -n __ARGUS_PATH_START__:$PATH:__ARGUS_PATH_END__".to_string()
    };

    (
        shell.to_string(),
        vec!["-i".into(), "-l".into(), "-c".into(), body],
    )
}

/// Extract PATH entries from the output of:
///   `<shell> -l -c 'echo -n __ARGUS_PATH_START__:$PATH:__ARGUS_PATH_END__'`
///
/// Returns `None` if the markers are absent (e.g. the shell printed an error
/// message instead of expanding `$PATH`).
fn parse_shell_path(stdout: &str) -> Option<Vec<String>> {
    let start_marker = "__ARGUS_PATH_START__:";
    let end_marker = ":__ARGUS_PATH_END__";

    let start_pos = stdout.find(start_marker)?;
    let after_start = &stdout[start_pos + start_marker.len()..];
    let end_pos = after_start.find(end_marker)?;
    let raw = &after_start[..end_pos];

    Some(
        raw.split(':')
            .filter(|e| !e.is_empty())
            .map(String::from)
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_shell_path unit tests ───────────────────────────────────────────

    #[test]
    fn parse_clean_markers() {
        let stdout = "__ARGUS_PATH_START__:/usr/bin:/opt/homebrew/bin:__ARGUS_PATH_END__";
        let result = parse_shell_path(stdout).unwrap();
        assert_eq!(result, vec!["/usr/bin", "/opt/homebrew/bin"]);
    }

    #[test]
    fn parse_with_noise_before_and_after() {
        let stdout = "some warning\n__ARGUS_PATH_START__:/usr/bin:/usr/local/bin:__ARGUS_PATH_END__\nextra output";
        let result = parse_shell_path(stdout).unwrap();
        assert_eq!(result, vec!["/usr/bin", "/usr/local/bin"]);
    }

    #[test]
    fn parse_missing_markers_returns_none() {
        let stdout = "no markers here at all";
        assert!(parse_shell_path(stdout).is_none());
    }

    #[test]
    fn parse_missing_end_marker_returns_none() {
        let stdout = "__ARGUS_PATH_START__:/usr/bin";
        assert!(parse_shell_path(stdout).is_none());
    }

    #[test]
    fn parse_empty_path_between_markers() {
        // Edge case: $PATH is empty (shouldn't happen in practice).
        let stdout = "__ARGUS_PATH_START__::__ARGUS_PATH_END__";
        let result = parse_shell_path(stdout).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn parse_single_entry() {
        let stdout = "__ARGUS_PATH_START__:/opt/homebrew/bin:__ARGUS_PATH_END__";
        let result = parse_shell_path(stdout).unwrap();
        assert_eq!(result, vec!["/opt/homebrew/bin"]);
    }

    // ── shell_probe_command tests ─────────────────────────────────────────────

    #[test]
    fn probe_uses_interactive_login_shell() {
        let (program, args) = shell_probe_command("/bin/zsh");
        assert_eq!(program, "/bin/zsh");
        // Interactive (-i) and login (-l) flags must both be present so that
        // both ~/.zshrc and ~/.zprofile are sourced.
        assert!(args.iter().any(|a| a == "-i"), "missing -i: {args:?}");
        assert!(args.iter().any(|a| a == "-l"), "missing -l: {args:?}");
        assert!(args.iter().any(|a| a == "-c"), "missing -c: {args:?}");
    }

    #[test]
    fn probe_posix_shell_uses_dollar_path() {
        let (_, args) = shell_probe_command("/bin/bash");
        let body = args.last().unwrap();
        assert!(body.contains("$PATH"), "posix body should expand $PATH: {body}");
        assert!(!body.contains("string join"));
        assert!(body.contains("__ARGUS_PATH_START__"));
        assert!(body.contains("__ARGUS_PATH_END__"));
    }

    #[test]
    fn probe_fish_shell_uses_string_join() {
        // fish's $PATH is space-separated, so the probe must colon-join it
        // explicitly or parse_shell_path would collapse it to one entry.
        let (program, args) = shell_probe_command("/opt/homebrew/bin/fish");
        assert_eq!(program, "/opt/homebrew/bin/fish");
        let body = args.last().unwrap();
        assert!(body.contains("string join : $PATH"), "fish body: {body}");
        assert!(body.contains("__ARGUS_PATH_START__"));
        assert!(body.contains("__ARGUS_PATH_END__"));
    }

    #[test]
    fn fish_style_colon_joined_output_parses() {
        // What the fish branch emits (already colon-joined) must parse cleanly.
        let stdout = "__ARGUS_PATH_START__:/opt/homebrew/bin:/usr/bin:__ARGUS_PATH_END__";
        let result = parse_shell_path(stdout).unwrap();
        assert_eq!(result, vec!["/opt/homebrew/bin", "/usr/bin"]);
    }

    // ── no-op test on non-macOS ───────────────────────────────────────────────
    //
    // On macOS this test still verifies the function runs without panic and
    // doesn't crash when the current PATH is already fully populated.
    #[test]
    fn does_not_crash_or_panic() {
        // Just call it — any platform. The important thing is no panic.
        fix_macos_path();
    }
}
