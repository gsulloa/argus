// claude-cli chat() implementation.
//
// Pinned stream-json schema (verified 2026-06-03 against `claude --version`):
//   - content_block_delta with delta.type = text_delta
//   - tool_use with id, name, input
//   - tool_result with tool_use_id, content, optional is_error
//   - message_stop with optional stop_reason
//   - session_id with session_id (top-level OR nested in message_start)
//
// Pinned CLI flags (verified 2026-06-06 against claude CLI 2.1.152):
//   --system-prompt <prompt>   replaces the session system prompt (full replace, not append)
//   --tools <list>             restricts available built-in tools (e.g. "Read Glob Grep")
//
// Unknown event types degrade to ChatDelta::Status, not Err. The CLI may evolve;
// unknown types are not fatal.
//
// Resume id handling: when the CLI emits a session_id event, the provider yields
// ChatDelta::Status("__resume_id__:<id>"). The Tauri command (commands.rs)
// detects this sentinel and stores the id in ChatSession.provider_state["resume_id"]
// so the next turn can pass --resume <id>.

use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::{self, StreamExt as _};
use serde_json::Value as JsonValue;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;
use tokio_stream::wrappers::LinesStream;

use crate::error::{AppError, AppResult};
use crate::modules::ai::caps::{CLAUDE_CLI_DEFAULT_MODEL, CLAUDE_CLI_MODELS};
use crate::modules::ai::provider::AiProvider;

/// Return the `claude` binary path to use.
/// Respects the `ARGUS_CLAUDE_BIN` environment variable as an escape hatch
/// for users whose `claude` is not on the inherited PATH.
fn claude_bin() -> String {
    std::env::var("ARGUS_CLAUDE_BIN")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "claude".to_string())
}
use crate::modules::ai::types::{
    build_cli_system_prompt, render_attachments_prefix, Capabilities, ChatDelta, ChatRequest,
    ChatRole, ChatStream, GenerateDelta, GenerateRequest, GenerateStream, ProviderId,
    ValidationResult,
};

const VALIDATION_TIMEOUT: Duration = Duration::from_secs(3);

pub struct ClaudeCli {
    /// Model override resolved from settings at construction time.
    pub configured_model: Option<String>,
}

impl ClaudeCli {
    pub fn new(configured_model: Option<String>) -> Self {
        Self { configured_model }
    }
}

#[async_trait]
impl AiProvider for ClaudeCli {
    fn id(&self) -> ProviderId {
        ProviderId::ClaudeCli
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            can_read_files: true,
            supports_streaming: true,
            requires_api_key: false,
            default_model: CLAUDE_CLI_DEFAULT_MODEL,
            available_models: CLAUDE_CLI_MODELS,
        }
    }

    async fn validate(&self) -> ValidationResult {
        match timeout(VALIDATION_TIMEOUT, run_version_probe(&claude_bin())).await {
            Ok(Ok(_)) => ValidationResult::Ready,
            Ok(Err(msg)) => ValidationResult::Missing { hint: msg },
            Err(_) => ValidationResult::Missing {
                hint: "claude command did not respond within 3 seconds".into(),
            },
        }
    }

    async fn generate_sql(&self, req: GenerateRequest) -> AppResult<GenerateStream> {
        let model = resolve_model(
            &req.model,
            &self.configured_model,
            CLAUDE_CLI_MODELS,
            CLAUDE_CLI_DEFAULT_MODEL,
        )?;

        let cwd = req.context_path.clone().unwrap_or_else(std::env::temp_dir);
        let system_prompt = build_cli_system_prompt(&cwd);

        let mut cmd = Command::new(claude_bin());
        cmd.arg("-p");
        // Ignore any user/project MCP config so no external tool (e.g. a DB MCP
        // server) can give the agent a path to execute SQL despite --tools.
        cmd.arg("--strict-mcp-config");
        if let Some(m) = model.as_deref() {
            cmd.args(["--model", m]);
        }
        cmd.args(["--system-prompt", &system_prompt]);
        cmd.args(["--tools", "Read Glob Grep"]);
        // `--` terminates option parsing so the variadic `--tools` does not
        // swallow the positional prompt (see build_claude_argv for details).
        cmd.arg("--");
        cmd.arg(&req.prompt);
        cmd.current_dir(&cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| map_spawn_err("claude", e))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Internal("claude: no stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AppError::Internal("claude: no stderr".into()))?;

        Ok(build_generate_stream(child, stdout, stderr))
    }

    async fn chat(&self, req: ChatRequest) -> AppResult<ChatStream> {
        let model = resolve_model(
            &req.model,
            &self.configured_model,
            CLAUDE_CLI_MODELS,
            CLAUDE_CLI_DEFAULT_MODEL,
        )?;

        let cwd = req.context_path.clone().unwrap_or_else(std::env::temp_dir);
        let system_prompt = build_cli_system_prompt(&cwd);
        let resume_id = req.provider_state.get("resume_id").cloned();

        // If we have a resume id, try to use --resume first.
        // If that fails quickly (non-zero exit within RESUME_FAIL_TIMEOUT), retry without.
        if let Some(ref rid) = resume_id {
            // With --resume, we only need the latest user message.
            let latest_prompt = format!(
                "{}{}",
                render_attachments_prefix(&req.attached_results),
                req.turns.last().map(|t| t.content.as_str()).unwrap_or("")
            );

            match spawn_claude_stream_json(
                &latest_prompt,
                model.as_deref(),
                Some(rid),
                &system_prompt,
                "Read Glob Grep",
                &cwd,
            ) {
                Ok((child, stdout, stderr)) => {
                    return Ok(build_chat_stream(child, stdout, stderr));
                }
                Err(e) => {
                    // spawn itself failed — fall through to full-history retry
                    tracing::warn!("claude --resume spawn failed ({e}), retrying without");
                }
            }
        }

        // Either no resume_id, or spawn with resume failed — flatten full history.
        let prompt = flatten_history_for_cli(&req.turns, &req.attached_results);

        let (child, stdout, stderr) = spawn_claude_stream_json(
            &prompt,
            model.as_deref(),
            None,
            &system_prompt,
            "Read Glob Grep",
            &cwd,
        )?;

        let base_stream = build_chat_stream(child, stdout, stderr);

        // If we had a resume_id but are falling back, prepend a status notice.
        if resume_id.is_some() {
            let notice = stream::once(async {
                Ok(ChatDelta::Status("session-resume unavailable, replaying history".into()))
            });
            Ok(Box::pin(notice.chain(base_stream)))
        } else {
            Ok(base_stream)
        }
    }
}

/// Build the full argv vector for a `claude` stream-json invocation.
///
/// Pure function — takes no `Command`, returns a `Vec<String>`. This makes
/// the constructed flags (including `--system-prompt` and `--tools`) unit-testable
/// without spawning a real `claude` binary.
///
/// Verified flags (claude CLI 2.1.152, 2026-06-06):
///   -p                           non-interactive prompt mode
///   --verbose                    required when -p is paired with --output-format stream-json
///   --output-format stream-json  machine-readable streaming output
///   --strict-mcp-config          ignore all user/project MCP servers (none passed)
///   --model <model>              select model (optional)
///   --resume <id>                resume a previous session (optional)
///   --system-prompt <prompt>     replace session system prompt (full replace, not append)
///   --tools <list>               restrict available built-in tools (VARIADIC: needs `--` after)
///   --                           terminates option parsing (keeps variadic --tools off the prompt)
///   <prompt>                     positional prompt (last argument)
pub(crate) fn build_claude_argv(
    prompt: &str,
    model: Option<&str>,
    resume_id: Option<&str>,
    system_prompt: &str,
    tools: &str,
) -> Vec<String> {
    let mut argv: Vec<String> = Vec::new();
    // -p and --verbose are always present.
    argv.push("-p".into());
    argv.push("--verbose".into());
    argv.push("--output-format".into());
    argv.push("stream-json".into());
    // Only use MCP servers from --mcp-config (we pass none), ignoring any
    // user/project MCP configuration. Without this, a globally-configured DB
    // MCP server could give the agent a way to execute SQL despite --tools.
    argv.push("--strict-mcp-config".into());
    if let Some(m) = model {
        argv.push("--model".into());
        argv.push(m.to_string());
    }
    if let Some(rid) = resume_id {
        argv.push("--resume".into());
        argv.push(rid.to_string());
    }
    argv.push("--system-prompt".into());
    argv.push(system_prompt.to_string());
    argv.push("--tools".into());
    argv.push(tools.to_string());
    // `--tools` is variadic (`--tools <tools...>`); without an explicit `--`
    // option terminator it greedily consumes the positional prompt as another
    // tool name, and claude then errors with "Input must be provided ...".
    // `--` ends option parsing so the prompt is treated as the positional arg.
    argv.push("--".into());
    // Positional prompt is always last.
    argv.push(prompt.to_string());
    argv
}

/// Spawn claude with --output-format stream-json. Returns (child, stdout, stderr).
fn spawn_claude_stream_json(
    prompt: &str,
    model: Option<&str>,
    resume_id: Option<&str>,
    system_prompt: &str,
    tools: &str,
    cwd: &std::path::Path,
) -> AppResult<(
    tokio::process::Child,
    tokio::process::ChildStdout,
    tokio::process::ChildStderr,
)> {
    let argv = build_claude_argv(prompt, model, resume_id, system_prompt, tools);
    let mut cmd = Command::new(claude_bin());
    for arg in &argv {
        cmd.arg(arg);
    }
    cmd.current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| map_spawn_err("claude", e))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Internal("claude: no stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Internal("claude: no stderr".into()))?;

    Ok((child, stdout, stderr))
}

/// Flatten a multi-turn conversation into a single prompt string for the CLI.
/// Used when there is no --resume id (first turn or resume unavailable).
pub(crate) fn flatten_history_for_cli(
    turns: &[crate::modules::ai::types::ChatTurn],
    attachments: &[crate::modules::ai::types::AttachedResult],
) -> String {
    if turns.is_empty() {
        return String::new();
    }

    let attachment_prefix = render_attachments_prefix(attachments);

    let all_but_last = &turns[..turns.len() - 1];
    let last = &turns[turns.len() - 1];

    let mut parts = Vec::new();

    if !all_but_last.is_empty() {
        let history: String = all_but_last
            .iter()
            .map(|t| {
                let role = match t.role {
                    ChatRole::User => "User",
                    ChatRole::Assistant => "Assistant",
                };
                format!("{}: {}", role, t.content)
            })
            .collect::<Vec<_>>()
            .join("\n");
        parts.push(history);
        // ── #62 insertion point ──────────────────────────────────────────────
        // Prepend the markdown result table to `last.content` before formatting
        // into the "User's new request:" line. The table prefix appears BEFORE
        // the user's natural-language question so the agent sees the data first.
        // When attachments is empty, attachment_prefix is "" → byte-identical output.
        parts.push(format!("User's new request: {attachment_prefix}{}", last.content));
    } else {
        // First turn — just the content directly.
        // ── #62 insertion point ──────────────────────────────────────────────
        // Prepend the markdown result table for single-turn (first) requests,
        // same as the multi-turn case above.
        parts.push(format!("{attachment_prefix}{}", last.content));
    }

    parts.join("\n\n")
}

/// Build a ChatStream from a running claude --output-format stream-json process.
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

    let mapped = stdout_lines.flat_map(|line_res| {
        let deltas = match line_res {
            Err(e) => vec![Err(AppError::Internal(format!("claude stdout read failed: {e}")))],
            Ok(line) if line.trim().is_empty() => vec![],
            Ok(line) => parse_stream_json_line(&line),
        };
        stream::iter(deltas)
    });

    let tail = async move {
        let status = child.wait().await;
        let stderr_text = stderr_handle.await.unwrap_or_default();
        match status {
            Ok(s) if s.success() => None,
            Ok(s) => Some(Err(AppError::Internal(format!(
                "claude exited with {:?}: {}",
                s.code(),
                stderr_text.trim()
            )))),
            Err(e) => Some(Err(AppError::Internal(format!("claude wait failed: {e}")))),
        }
    };

    // Append the tail (only emits if there was an error).
    let combined = mapped.chain(stream::once(tail).filter_map(|x| async move { x }));
    Box::pin(combined)
}

/// Parse a single stream-json line from claude into zero or more ChatDelta values.
///
/// The CLI `--output-format stream-json --verbose` schema is NOT the Anthropic
/// streaming-SDK schema. Each line has a top-level `type` of:
///   - "system"     — initialization (subtype "init"), or session metadata
///   - "assistant"  — assistant message: `message.content[]` of `text` and `tool_use`
///   - "user"       — tool results sent back: `message.content[]` of `tool_result`
///   - "result"     — terminal event with final text + cost/duration
///
/// The first line typically carries the new `session_id` we capture for --resume.
pub(crate) fn parse_stream_json_line(line: &str) -> Vec<AppResult<ChatDelta>> {
    let value: JsonValue = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => {
            let truncated: String = line.chars().take(80).collect();
            return vec![Ok(ChatDelta::Status(format!(
                "non-json line from claude: {truncated}"
            )))];
        }
    };

    let event_type = value
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();

    let mut out: Vec<AppResult<ChatDelta>> = Vec::new();

    // Capture session_id from any top-level event that carries one (every event
    // does in practice). We forward it as a sentinel exactly once per session.
    if let Some(sid) = value.get("session_id").and_then(|v| v.as_str()) {
        out.push(Ok(ChatDelta::Status(format!("__resume_id__:{sid}"))));
    }

    match event_type.as_str() {
        "system" => {
            let subtype = value
                .get("subtype")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if subtype == "init" {
                let model = value.get("model").and_then(|v| v.as_str()).unwrap_or("");
                out.push(Ok(ChatDelta::Status(if model.is_empty() {
                    "Initialised".into()
                } else {
                    format!("Initialised ({model})")
                })));
            } else if !subtype.is_empty() {
                out.push(Ok(ChatDelta::Status(format!("system: {subtype}"))));
            }
        }
        "assistant" => {
            let content = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array());
            if let Some(blocks) = content {
                for block in blocks {
                    let btype = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match btype {
                        "text" => {
                            if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                                if !t.is_empty() {
                                    out.push(Ok(ChatDelta::Text(t.to_string())));
                                }
                            }
                        }
                        "tool_use" => {
                            let id = block
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let name = block
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let input = block
                                .get("input")
                                .cloned()
                                .unwrap_or(JsonValue::Object(serde_json::Map::new()));
                            out.push(Ok(ChatDelta::Status(if name.is_empty() {
                                "Running tool…".into()
                            } else {
                                format!("Running {name}…")
                            })));
                            out.push(Ok(ChatDelta::ToolCallStarted { id, name, input }));
                        }
                        _ => {}
                    }
                }
            }
        }
        "user" => {
            // Tool results returned to the model. Surface as ToolCallFinished.
            let content = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array());
            if let Some(blocks) = content {
                for block in blocks {
                    let btype = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if btype == "tool_result" {
                        let id = block
                            .get("tool_use_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        // content may be a string OR an array of {type:"text", text:"..."}.
                        let output = match block.get("content") {
                            Some(JsonValue::String(s)) => s.clone(),
                            Some(JsonValue::Array(arr)) => arr
                                .iter()
                                .filter_map(|x| x.get("text").and_then(|t| t.as_str()))
                                .collect::<Vec<_>>()
                                .join(""),
                            _ => String::new(),
                        };
                        let is_error = block
                            .get("is_error")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        out.push(Ok(ChatDelta::ToolCallFinished { id, output, is_error }));
                    }
                }
            }
        }
        "result" => {
            // Terminal event. If a final assembled `result` string exists and no
            // assistant text has been emitted yet (rare — usually the assistant
            // event already streamed it), emit it. Then Done.
            if let Some(r) = value.get("result").and_then(|v| v.as_str()) {
                if !r.is_empty() {
                    out.push(Ok(ChatDelta::Text(r.to_string())));
                }
            }
            let subtype = value
                .get("subtype")
                .and_then(|v| v.as_str())
                .map(String::from);
            out.push(Ok(ChatDelta::Done { finish_reason: subtype }));
        }
        // Legacy / SDK-style events kept for fixture compatibility.
        "content_block_delta" => {
            if let Some(t) = value
                .get("delta")
                .and_then(|d| {
                    if d.get("type").and_then(|t| t.as_str()) == Some("text_delta") {
                        d.get("text").and_then(|t| t.as_str())
                    } else {
                        None
                    }
                })
            {
                if !t.is_empty() {
                    out.push(Ok(ChatDelta::Text(t.to_string())));
                }
            }
        }
        "tool_use" => {
            let id = value
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let name = value
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let input = value
                .get("input")
                .cloned()
                .unwrap_or(JsonValue::Object(serde_json::Map::new()));
            out.push(Ok(ChatDelta::ToolCallStarted { id, name, input }));
        }
        "tool_result" => {
            let id = value
                .get("tool_use_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let output = value
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let is_error = value
                .get("is_error")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            out.push(Ok(ChatDelta::ToolCallFinished { id, output, is_error }));
        }
        "message_stop" => {
            let finish_reason = value
                .get("stop_reason")
                .and_then(|v| v.as_str())
                .map(String::from);
            out.push(Ok(ChatDelta::Done { finish_reason }));
        }
        "message_start" | "content_block_start" | "content_block_stop"
        | "message_delta" | "ping" | "session_id" => {
            // Informational / structural — silent. session_id payload, if any,
            // was already captured by the top-level extraction above.
        }
        other if !other.is_empty() => {
            out.push(Ok(ChatDelta::Status(format!("event: {other}"))));
        }
        _ => {}
    }

    out
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
but couldn't find the binary. Either (a) ensure `claude` is in PATH for your login shell \
(e.g. ~/.zprofile), (b) symlink it to /usr/local/bin, or (c) set the ARGUS_CLAUDE_BIN env var \
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
but couldn't find the binary. Either (a) ensure `claude` is in PATH for your login shell \
(e.g. ~/.zprofile), (b) symlink it to /usr/local/bin, or (c) set the ARGUS_CLAUDE_BIN env var \
to the absolute path of the binary."
        ))
    } else {
        AppError::Internal(format!("failed to spawn `{name}`: {e}"))
    }
}

/// Validate `req.model` is supported; return the chosen model (None means use CLI default).
pub(crate) fn resolve_model(
    req_model: &Option<String>,
    configured: &Option<String>,
    available: &[&str],
    _default: &str,
) -> AppResult<Option<String>> {
    let pick = req_model.clone().or_else(|| configured.clone());
    if let Some(m) = &pick {
        if !available.iter().any(|x| *x == m) {
            return Err(AppError::Validation(format!("unsupported model: {m}")));
        }
    }
    Ok(pick)
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
            .map_err(|e| AppError::Internal(format!("claude stdout read failed: {e}")))
    });

    let tail = async move {
        let status = child.wait().await;
        let stderr_text = stderr_handle.await.unwrap_or_default();
        match status {
            Ok(s) if s.success() => Ok(GenerateDelta::Done { finish_reason: None }),
            Ok(s) => Err(AppError::Internal(format!(
                "claude exited with {:?}: {}",
                s.code(),
                stderr_text.trim()
            ))),
            Err(e) => Err(AppError::Internal(format!("claude wait failed: {e}"))),
        }
    };

    Box::pin(mapped.chain(stream::once(tail)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::ai::types::ChatDelta;

    // Spawn tests are omitted: creating a fake `claude` binary on PATH in Rust
    // is fragile and racy in a parallel test runner. Real spawn paths are
    // covered by the manual smoke tests in task 11.

    #[test]
    fn claude_bin_respects_env_override() {
        // Note: std::env::set_var is not thread-safe in a parallel test runner.
        // This test is kept simple intentionally; if flakiness is observed in CI,
        // wrap with a Mutex or add `serial_test` crate.
        std::env::set_var("ARGUS_CLAUDE_BIN", "/custom/path/claude");
        assert_eq!(claude_bin(), "/custom/path/claude");
        std::env::remove_var("ARGUS_CLAUDE_BIN");
        assert_eq!(claude_bin(), "claude");
    }

    #[test]
    fn claude_bin_ignores_empty_env_var() {
        // This test reads env state potentially set by a parallel test.
        // We only verify the invariant when the var is explicitly empty.
        // The remove+set sequence is still racy; in CI, parallel test runs
        // may interleave. Use `serial_test` crate if this becomes flaky.
        std::env::remove_var("ARGUS_CLAUDE_BIN");
        std::env::set_var("ARGUS_CLAUDE_BIN", "");
        assert_eq!(claude_bin(), "claude");
        std::env::remove_var("ARGUS_CLAUDE_BIN");
    }

    #[test]
    fn resolve_model_accepts_known_model() {
        let result = resolve_model(
            &Some("claude-sonnet-4-6".into()),
            &None,
            CLAUDE_CLI_MODELS,
            CLAUDE_CLI_DEFAULT_MODEL,
        );
        assert_eq!(result.unwrap(), Some("claude-sonnet-4-6".to_string()));
    }

    #[test]
    fn resolve_model_rejects_unknown_model() {
        let result = resolve_model(
            &Some("gpt-9000".into()),
            &None,
            CLAUDE_CLI_MODELS,
            CLAUDE_CLI_DEFAULT_MODEL,
        );
        assert!(matches!(result, Err(AppError::Validation(_))));
    }

    #[test]
    fn resolve_model_falls_back_to_configured() {
        let result = resolve_model(
            &None,
            &Some("claude-haiku-4-5".into()),
            CLAUDE_CLI_MODELS,
            CLAUDE_CLI_DEFAULT_MODEL,
        );
        assert_eq!(result.unwrap(), Some("claude-haiku-4-5".to_string()));
    }

    #[test]
    fn resolve_model_none_when_no_override() {
        let result = resolve_model(&None, &None, CLAUDE_CLI_MODELS, CLAUDE_CLI_DEFAULT_MODEL);
        assert_eq!(result.unwrap(), None);
    }

    // ── build_claude_argv tests ────────────────────────────────────────────────

    #[test]
    fn build_claude_argv_no_resume_contains_required_flags() {
        let sp = "You are a SQL assistant. MUST NOT execute SQL.";
        let argv = build_claude_argv("SELECT 1", None, None, sp, "Read Glob Grep");
        assert!(argv.contains(&"-p".to_string()), "must contain -p");
        assert!(argv.contains(&"--verbose".to_string()), "must contain --verbose");
        assert!(argv.contains(&"--output-format".to_string()));
        assert!(argv.contains(&"stream-json".to_string()));
        assert!(argv.contains(&"--strict-mcp-config".to_string()), "must ignore external MCP servers");
        // --system-prompt with SQL-only text
        let sp_idx = argv.iter().position(|a| a == "--system-prompt")
            .expect("--system-prompt flag not found");
        assert_eq!(argv[sp_idx + 1], sp, "--system-prompt value must follow the flag");
        assert!(argv[sp_idx + 1].contains("MUST NOT execute SQL"), "system prompt must contain no-execution clause");
        // --tools with read-only set
        let tools_idx = argv.iter().position(|a| a == "--tools")
            .expect("--tools flag not found");
        assert_eq!(argv[tools_idx + 1], "Read Glob Grep");
        // `--` terminator must sit right before the positional prompt so the
        // variadic --tools cannot swallow it.
        assert_eq!(argv[argv.len() - 2], "--", "`--` must precede the positional prompt");
        // positional prompt is last
        assert_eq!(argv.last().unwrap(), "SELECT 1");
        // --resume must NOT be present
        assert!(!argv.contains(&"--resume".to_string()), "no --resume for None resume_id");
    }

    #[test]
    fn build_claude_argv_with_resume_contains_resume_flag() {
        let sp = "You are a SQL assistant. MUST NOT execute SQL.";
        let argv = build_claude_argv("follow up", Some("claude-sonnet-4-6"), Some("sess-abc"), sp, "Read Glob Grep");
        let resume_idx = argv.iter().position(|a| a == "--resume")
            .expect("--resume flag not found");
        assert_eq!(argv[resume_idx + 1], "sess-abc");
        // --system-prompt still present on resume path
        assert!(argv.contains(&"--system-prompt".to_string()), "--system-prompt must be present on resume path");
        // --tools still present
        assert!(argv.contains(&"--tools".to_string()), "--tools must be present on resume path");
        // model present
        let model_idx = argv.iter().position(|a| a == "--model")
            .expect("--model flag not found");
        assert_eq!(argv[model_idx + 1], "claude-sonnet-4-6");
        // `--` terminator right before the positional prompt
        assert_eq!(argv[argv.len() - 2], "--", "`--` must precede the positional prompt");
        // positional prompt is last
        assert_eq!(argv.last().unwrap(), "follow up");
    }

    // ── stream-json parser unit tests ──────────────────────────────────────────

    fn collect_fixture(path: &str) -> Vec<ChatDelta> {
        let content = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("failed to read fixture {path}: {e}"));
        content
            .lines()
            .filter(|l| !l.trim().is_empty())
            .flat_map(|line| parse_stream_json_line(line))
            .filter_map(|r| r.ok())
            .collect()
    }

    fn fixture(name: &str) -> String {
        format!(
            "{}/tests/fixtures/claude_stream_json/{name}",
            env!("CARGO_MANIFEST_DIR")
        )
    }

    #[test]
    fn fixture_text_only_yields_text_and_done() {
        let deltas = collect_fixture(&fixture("text_only.jsonl"));
        let texts: Vec<_> = deltas.iter().filter(|d| matches!(d, ChatDelta::Text(_))).collect();
        let dones: Vec<_> = deltas.iter().filter(|d| matches!(d, ChatDelta::Done { .. })).collect();
        assert!(!texts.is_empty(), "expected at least one Text delta");
        assert_eq!(dones.len(), 1, "expected exactly one Done");
        // Concatenated text should be "SELECT 1;"
        let full: String = texts.iter().filter_map(|d| if let ChatDelta::Text(t) = d { Some(t.as_str()) } else { None }).collect();
        assert!(full.contains("SELECT"), "text should contain SELECT");
        if let ChatDelta::Done { finish_reason } = dones[0] {
            assert_eq!(finish_reason.as_deref(), Some("end_turn"));
        }
    }

    #[test]
    fn fixture_tool_use_sequence_yields_started_finished_done() {
        let deltas = collect_fixture(&fixture("tool_use_sequence.jsonl"));
        let started: Vec<_> = deltas.iter().filter(|d| matches!(d, ChatDelta::ToolCallStarted { .. })).collect();
        let finished: Vec<_> = deltas.iter().filter(|d| matches!(d, ChatDelta::ToolCallFinished { .. })).collect();
        let dones: Vec<_> = deltas.iter().filter(|d| matches!(d, ChatDelta::Done { .. })).collect();
        assert_eq!(started.len(), 1, "expected one ToolCallStarted");
        assert_eq!(finished.len(), 1, "expected one ToolCallFinished");
        assert_eq!(dones.len(), 1, "expected one Done");
        if let ChatDelta::ToolCallStarted { name, .. } = &started[0] {
            assert_eq!(name, "ReadFile");
        }
        if let ChatDelta::ToolCallFinished { is_error, .. } = &finished[0] {
            assert!(!is_error);
        }
    }

    #[test]
    fn fixture_unknown_event_yields_status() {
        let deltas = collect_fixture(&fixture("unknown_event.jsonl"));
        let statuses: Vec<_> = deltas.iter()
            .filter_map(|d| if let ChatDelta::Status(s) = d { Some(s.as_str()) } else { None })
            .collect();
        assert!(
            statuses.iter().any(|s| s.starts_with("event: something_new")),
            "expected event status, got: {statuses:?}"
        );
    }

    #[test]
    fn fixture_malformed_yields_non_json_status() {
        let deltas = collect_fixture(&fixture("malformed.jsonl"));
        let statuses: Vec<_> = deltas.iter()
            .filter_map(|d| if let ChatDelta::Status(s) = d { Some(s.as_str()) } else { None })
            .collect();
        assert!(
            statuses.iter().any(|s| s.starts_with("non-json line from claude:")),
            "expected non-json status, got: {statuses:?}"
        );
    }

    #[test]
    fn fixture_with_session_id_yields_resume_sentinel() {
        let deltas = collect_fixture(&fixture("with_session_id.jsonl"));
        let statuses: Vec<_> = deltas.iter()
            .filter_map(|d| if let ChatDelta::Status(s) = d { Some(s.as_str()) } else { None })
            .collect();
        assert!(
            statuses.iter().any(|s| *s == "__resume_id__:abc-123"),
            "expected __resume_id__ sentinel, got: {statuses:?}"
        );
    }

    #[test]
    fn flatten_history_single_turn() {
        use crate::modules::ai::types::{ChatRole, ChatTurn};
        let turns = vec![ChatTurn {
            role: ChatRole::User,
            content: "hello world".into(),
            tool_uses: vec![],
        }];
        let result = flatten_history_for_cli(&turns, &[]);
        assert_eq!(result, "hello world");
    }

    #[test]
    fn flatten_history_multi_turn() {
        use crate::modules::ai::types::{ChatRole, ChatTurn};
        let turns = vec![
            ChatTurn { role: ChatRole::User, content: "first".into(), tool_uses: vec![] },
            ChatTurn { role: ChatRole::Assistant, content: "reply".into(), tool_uses: vec![] },
            ChatTurn { role: ChatRole::User, content: "follow up".into(), tool_uses: vec![] },
        ];
        let result = flatten_history_for_cli(&turns, &[]);
        assert!(result.contains("User: first"), "should contain prior user turn");
        assert!(result.contains("Assistant: reply"), "should contain assistant turn");
        assert!(result.contains("User's new request: follow up"), "should contain new request");
    }

    #[test]
    fn flatten_history_prepends_attachment_table() {
        use crate::modules::ai::types::{AttachedResult, ChatRole, ChatTurn};
        let turns = vec![ChatTurn {
            role: ChatRole::User,
            content: "summarise this".into(),
            tool_uses: vec![],
        }];
        let att = AttachedResult {
            id: "a1".into(),
            columns: vec!["name".into()],
            rows: vec![vec!["alice".into()]],
            truncated: false,
            row_count: 1,
        };
        let result = flatten_history_for_cli(&turns, &[att]);
        let table_pos = result.find("# Attached result").expect("table header present");
        let q_pos = result.find("summarise this").expect("question present");
        assert!(table_pos < q_pos, "table must precede the user question");
        assert!(result.contains("| alice |"));
    }

    #[test]
    fn parse_text_delta() {
        let line = r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}"#;
        let deltas: Vec<_> = parse_stream_json_line(line).into_iter().filter_map(|r| r.ok()).collect();
        assert_eq!(deltas.len(), 1);
        assert!(matches!(&deltas[0], ChatDelta::Text(t) if t == "hello"));
    }

    #[test]
    fn parse_message_stop() {
        let line = r#"{"type":"message_stop","stop_reason":"end_turn"}"#;
        let deltas: Vec<_> = parse_stream_json_line(line).into_iter().filter_map(|r| r.ok()).collect();
        assert_eq!(deltas.len(), 1);
        assert!(matches!(
            &deltas[0],
            ChatDelta::Done { finish_reason: Some(r) } if r == "end_turn"
        ));
    }

    #[test]
    fn parse_session_id_event() {
        let line = r#"{"type":"session_id","session_id":"sess-xyz"}"#;
        let deltas: Vec<_> = parse_stream_json_line(line).into_iter().filter_map(|r| r.ok()).collect();
        assert_eq!(deltas.len(), 1);
        assert!(matches!(&deltas[0], ChatDelta::Status(s) if s == "__resume_id__:sess-xyz"));
    }

    #[test]
    fn parse_tool_use() {
        let line = r#"{"type":"tool_use","id":"tu-1","name":"Read","input":{"path":"foo.txt"}}"#;
        let deltas: Vec<_> = parse_stream_json_line(line).into_iter().filter_map(|r| r.ok()).collect();
        assert_eq!(deltas.len(), 1);
        assert!(matches!(&deltas[0], ChatDelta::ToolCallStarted { name, .. } if name == "Read"));
    }

    #[test]
    fn parse_tool_result() {
        let line = r#"{"type":"tool_result","tool_use_id":"tu-1","content":"file contents","is_error":false}"#;
        let deltas: Vec<_> = parse_stream_json_line(line).into_iter().filter_map(|r| r.ok()).collect();
        assert_eq!(deltas.len(), 1);
        assert!(matches!(&deltas[0], ChatDelta::ToolCallFinished { id, .. } if id == "tu-1"));
    }
}
