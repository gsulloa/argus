// Codex non-interactive invocation (spiked 2026-06-03):
//   `codex exec <PROMPT>` — the `exec` subcommand runs the agent non-interactively.
//   Model is selected with `-m <MODEL>` (e.g. `codex exec -m gpt-5.1 "write SQL…"`).
//   Working directory is set via `Command::current_dir`.
//
// Sentinel pattern for provider_state (mirrors claude_cli.rs):
//   ChatDelta::Status("__codex_warning_shown__") — emitted after the first-turn
//   warning Status so the Tauri command can set provider_state["codex_warning_shown"]
//   and suppress the warning on subsequent turns.

use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::{self, StreamExt as _};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;
use tokio_stream::wrappers::LinesStream;

use crate::error::{AppError, AppResult};
use crate::modules::ai::caps::{CODEX_CLI_DEFAULT_MODEL, CODEX_CLI_MODELS};
use crate::modules::ai::claude_cli::{flatten_history_for_cli, resolve_model};
use crate::modules::ai::types::{build_cli_system_prompt, build_inspector_system_prompt};
use crate::modules::ai::provider::AiProvider;

/// Return the `codex` binary path to use.
/// Respects the `ARGUS_CODEX_BIN` environment variable as an escape hatch
/// for users whose `codex` is not on the inherited PATH.
fn codex_bin() -> String {
    std::env::var("ARGUS_CODEX_BIN")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "codex".to_string())
}
use crate::modules::ai::types::{
    Capabilities, ChatDelta, ChatRequest, ChatStream, GenerateDelta, GenerateRequest, GenerateStream,
    InspectRequest, ProviderId, ValidationResult,
};

const VALIDATION_TIMEOUT: Duration = Duration::from_secs(3);

pub struct CodexCli {
    /// Model override resolved from settings at construction time.
    pub configured_model: Option<String>,
}

impl CodexCli {
    pub fn new(configured_model: Option<String>) -> Self {
        Self { configured_model }
    }
}

#[async_trait]
impl AiProvider for CodexCli {
    fn id(&self) -> ProviderId {
        ProviderId::CodexCli
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            can_read_files: true,
            supports_streaming: true,
            requires_api_key: false,
            default_model: CODEX_CLI_DEFAULT_MODEL,
            available_models: CODEX_CLI_MODELS,
        }
    }

    async fn validate(&self) -> ValidationResult {
        match timeout(VALIDATION_TIMEOUT, run_version_probe(&codex_bin())).await {
            Ok(Ok(_)) => ValidationResult::Ready,
            Ok(Err(msg)) => ValidationResult::Missing { hint: msg },
            Err(_) => ValidationResult::Missing {
                hint: "codex command did not respond within 3 seconds".into(),
            },
        }
    }

    async fn generate_sql(&self, req: GenerateRequest) -> AppResult<GenerateStream> {
        let model = resolve_model(
            &req.model,
            &self.configured_model,
            CODEX_CLI_MODELS,
            CODEX_CLI_DEFAULT_MODEL,
        )?;

        let cwd = req.context_path.clone().unwrap_or_else(std::env::temp_dir);
        let system = build_cli_system_prompt(&cwd);
        // codex exec has no --system-prompt flag; prepend the system prompt to the user prompt.
        let prompt = format!("{system}\n\n{}", req.prompt);

        let mut cmd = Command::new(codex_bin());
        cmd.arg("exec");
        if let Some(m) = model.as_deref() {
            cmd.args(["-m", m]);
        }
        cmd.arg(&prompt);
        cmd.current_dir(&cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| map_spawn_err("codex", e))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Internal("codex: no stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AppError::Internal("codex: no stderr".into()))?;

        Ok(build_generate_stream(child, stdout, stderr))
    }

    async fn inspect(&self, req: InspectRequest) -> AppResult<ChatStream> {
        let model = resolve_model(
            &req.model,
            &self.configured_model,
            CODEX_CLI_MODELS,
            CODEX_CLI_DEFAULT_MODEL,
        )?;
        let system = build_inspector_system_prompt(&req.table_description_json);
        let user_prompt = "Inspect this repository's source code and propose DynamoDB models for the table described in your instructions. Reply with only the JSON code block.";
        let prompt = format!("{system}\n\n{user_prompt}");

        let mut cmd = Command::new(codex_bin());
        cmd.arg("exec");
        if let Some(m) = model.as_deref() {
            cmd.args(["-m", m]);
        }
        cmd.arg(&prompt);
        cmd.current_dir(&req.project_source_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| map_spawn_err("codex", e))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Internal("codex: no stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AppError::Internal("codex: no stderr".into()))?;

        Ok(build_chat_stream(child, stdout, stderr))
    }

    async fn chat(&self, req: ChatRequest) -> AppResult<ChatStream> {
        let model = resolve_model(
            &req.model,
            &self.configured_model,
            CODEX_CLI_MODELS,
            CODEX_CLI_DEFAULT_MODEL,
        )?;

        let cwd = req.context_path.clone().unwrap_or_else(std::env::temp_dir);
        // codex exec has no --system-prompt flag; prepend the system prompt to the
        // flattened history so it is always the first thing the agent reads.
        let system = build_cli_system_prompt(&cwd);
        let history = flatten_history_for_cli(&req.turns, &req.attached_results);
        let prompt = format!("{system}\n\n{history}");

        let warning_shown = req.provider_state.get("codex_warning_shown").is_some();

        let mut cmd = Command::new(codex_bin());
        cmd.arg("exec");
        if let Some(m) = model.as_deref() {
            cmd.args(["-m", m]);
        }
        cmd.arg(&prompt);
        cmd.current_dir(&cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| map_spawn_err("codex", e))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Internal("codex: no stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AppError::Internal("codex: no stderr".into()))?;

        let base_stream = build_chat_stream(child, stdout, stderr);

        // Prepend warning on first turn.
        if !warning_shown {
            let warning = stream::iter(vec![
                Ok(ChatDelta::Status(
                    "codex doesn't expose structured tool events yet — showing raw output".into(),
                )),
                // Sentinel for the Tauri command to persist the flag.
                Ok(ChatDelta::Status("__codex_warning_shown__".into())),
            ]);
            Ok(Box::pin(warning.chain(base_stream)))
        } else {
            Ok(base_stream)
        }
    }
}

/// Build a ChatStream from a running codex process (plain text streaming).
fn build_chat_stream(
    mut child: tokio::process::Child,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
) -> ChatStream {
    let stdout_lines = LinesStream::new(BufReader::new(stdout).lines());
    let stderr_handle = tokio::spawn(async move {
        let mut buf = String::new();
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            buf.push_str(&line);
            buf.push('\n');
        }
        buf
    });

    let mapped = stdout_lines.map(|line_res| {
        line_res
            .map(ChatDelta::Text)
            .map_err(|e| AppError::Internal(format!("codex stdout read failed: {e}")))
    });

    let tail = async move {
        let status = child.wait().await;
        let stderr_text = stderr_handle.await.unwrap_or_default();
        match status {
            Ok(s) if s.success() => Ok(ChatDelta::Done { finish_reason: None }),
            Ok(s) => Err(AppError::Internal(format!(
                "codex exited with {:?}: {}",
                s.code(),
                stderr_text.trim()
            ))),
            Err(e) => Err(AppError::Internal(format!("codex wait failed: {e}"))),
        }
    };

    Box::pin(mapped.chain(stream::once(tail)))
}

async fn run_version_probe(cmd: &str) -> Result<(), String> {
    let out = Command::new(cmd)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status()
        .await
        .map_err(|e| format!(
        "could not find `{cmd}` on PATH ({e}). Argus tried to inherit your shell PATH at startup \
but couldn't find the binary. Either (a) ensure `codex` is in PATH for your login shell \
(e.g. ~/.zprofile), (b) symlink it to /usr/local/bin, or (c) set the ARGUS_CODEX_BIN env var \
to the absolute path of the binary."
    ))?;
    if out.success() {
        Ok(())
    } else {
        Err(format!(
            "`{cmd} --version` exited with code {:?}",
            out.code()
        ))
    }
}

fn map_spawn_err(name: &str, e: std::io::Error) -> AppError {
    if e.kind() == std::io::ErrorKind::NotFound {
        AppError::Internal(format!(
            "could not find `{name}` on PATH. Argus tried to inherit your shell PATH at startup \
but couldn't find the binary. Either (a) ensure `codex` is in PATH for your login shell \
(e.g. ~/.zprofile), (b) symlink it to /usr/local/bin, or (c) set the ARGUS_CODEX_BIN env var \
to the absolute path of the binary."
        ))
    } else {
        AppError::Internal(format!("failed to spawn `{name}`: {e}"))
    }
}

fn build_generate_stream(
    mut child: tokio::process::Child,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
) -> GenerateStream {
    let stdout_lines = LinesStream::new(BufReader::new(stdout).lines());
    let stderr_handle = tokio::spawn(async move {
        let mut buf = String::new();
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            buf.push_str(&line);
            buf.push('\n');
        }
        buf
    });

    let mapped = stdout_lines.map(|line_res| {
        line_res
            .map(GenerateDelta::Text)
            .map_err(|e| AppError::Internal(format!("codex stdout read failed: {e}")))
    });

    let tail = async move {
        let status = child.wait().await;
        let stderr_text = stderr_handle.await.unwrap_or_default();
        match status {
            Ok(s) if s.success() => Ok(GenerateDelta::Done { finish_reason: None }),
            Ok(s) => Err(AppError::Internal(format!(
                "codex exited with {:?}: {}",
                s.code(),
                stderr_text.trim()
            ))),
            Err(e) => Err(AppError::Internal(format!("codex wait failed: {e}"))),
        }
    };

    Box::pin(mapped.chain(stream::once(tail)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::ai::types::{ChatRole, ChatTurn};

    // Spawn tests are omitted — see claude_cli.rs for rationale.

    #[test]
    fn codex_bin_respects_env_override() {
        // Note: std::env::set_var is not thread-safe in a parallel test runner.
        // This test is kept simple intentionally; if flakiness is observed in CI,
        // wrap with a Mutex or add `serial_test` crate.
        std::env::set_var("ARGUS_CODEX_BIN", "/custom/path/codex");
        assert_eq!(codex_bin(), "/custom/path/codex");
        std::env::remove_var("ARGUS_CODEX_BIN");
        assert_eq!(codex_bin(), "codex");
    }

    #[test]
    fn codex_bin_ignores_empty_env_var() {
        // Remove first to avoid interference from parallel tests setting the var.
        std::env::remove_var("ARGUS_CODEX_BIN");
        std::env::set_var("ARGUS_CODEX_BIN", "");
        assert_eq!(codex_bin(), "codex");
        std::env::remove_var("ARGUS_CODEX_BIN");
    }

    #[test]
    fn resolve_model_accepts_known_codex_model() {
        let result = resolve_model(&Some("o3-mini".into()), &None, CODEX_CLI_MODELS, CODEX_CLI_DEFAULT_MODEL);
        assert_eq!(result.unwrap(), Some("o3-mini".to_string()));
    }

    #[test]
    fn resolve_model_rejects_unknown_codex_model() {
        let result = resolve_model(
            &Some("claude-opus-4-7".into()),
            &None,
            CODEX_CLI_MODELS,
            CODEX_CLI_DEFAULT_MODEL,
        );
        assert!(matches!(result, Err(AppError::Validation(_))));
    }

    #[test]
    fn flatten_history_single_turn_codex() {
        let turns = vec![ChatTurn {
            role: ChatRole::User,
            content: "list tables".into(),
            tool_uses: vec![],
        }];
        let result = flatten_history_for_cli(&turns, &[]);
        assert_eq!(result, "list tables");
    }

    #[test]
    fn chat_prompt_system_precedes_history() {
        // Verify the built chat prompt has the system prompt before the flattened history.
        let cwd = std::env::temp_dir();
        let system = build_cli_system_prompt(&cwd);
        let turns = vec![
            ChatTurn { role: ChatRole::User, content: "show tables".into(), tool_uses: vec![] },
            ChatTurn { role: ChatRole::Assistant, content: "users, orders".into(), tool_uses: vec![] },
            ChatTurn { role: ChatRole::User, content: "count users".into(), tool_uses: vec![] },
        ];
        let history = flatten_history_for_cli(&turns, &[]);
        let prompt = format!("{system}\n\n{history}");

        let system_pos = prompt.find("Role and restrictions").expect("system prompt header not found");
        let history_pos = prompt.find("User: show tables").expect("history content not found");
        assert!(
            system_pos < history_pos,
            "system prompt (pos {system_pos}) must precede history (pos {history_pos})"
        );
    }

    #[test]
    fn flatten_history_multi_turn_codex() {
        let turns = vec![
            ChatTurn { role: ChatRole::User, content: "show tables".into(), tool_uses: vec![] },
            ChatTurn { role: ChatRole::Assistant, content: "users, orders".into(), tool_uses: vec![] },
            ChatTurn { role: ChatRole::User, content: "count users".into(), tool_uses: vec![] },
        ];
        let result = flatten_history_for_cli(&turns, &[]);
        assert!(result.contains("User: show tables"));
        assert!(result.contains("Assistant: users, orders"));
        assert!(result.contains("User's new request: count users"));
    }
}
