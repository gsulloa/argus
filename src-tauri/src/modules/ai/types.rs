use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::pin::Pin;
use futures::Stream;
use serde_json::Value as JsonValue;

use crate::error::AppResult;
use crate::modules::context::types::AiPayload;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderId {
    ClaudeCli,
    CodexCli,
    AnthropicApi,
    OpenAiApi,
}

impl ProviderId {
    pub const ALL: [ProviderId; 4] = [
        ProviderId::ClaudeCli,
        ProviderId::CodexCli,
        ProviderId::AnthropicApi,
        ProviderId::OpenAiApi,
    ];

    pub fn as_kebab(self) -> &'static str {
        match self {
            ProviderId::ClaudeCli => "claude-cli",
            ProviderId::CodexCli => "codex-cli",
            ProviderId::AnthropicApi => "anthropic-api",
            ProviderId::OpenAiApi => "openai-api",
        }
    }

    pub fn from_kebab(s: &str) -> Option<Self> {
        match s {
            "claude-cli" => Some(ProviderId::ClaudeCli),
            "codex-cli" => Some(ProviderId::CodexCli),
            "anthropic-api" => Some(ProviderId::AnthropicApi),
            "openai-api" => Some(ProviderId::OpenAiApi),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Capabilities {
    pub can_read_files: bool,
    pub supports_streaming: bool,
    pub requires_api_key: bool,
    pub default_model: &'static str,
    pub available_models: &'static [&'static str],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "PascalCase")]
pub enum ValidationResult {
    Ready,
    Missing { hint: String },
    Misconfigured { reason: String },
}

#[derive(Debug, Clone)]
pub struct GenerateRequest {
    pub prompt: String,
    pub context_path: Option<PathBuf>,
    pub context_payload: AiPayload,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "PascalCase")]
pub enum GenerateDelta {
    Text(String),
    Done { finish_reason: Option<String> },
}

pub type GenerateStream = Pin<Box<dyn Stream<Item = AppResult<GenerateDelta>> + Send>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum ChatRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolUseRecord {
    pub id: String,
    pub name: String,
    pub input: JsonValue,
    pub output: Option<String>,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatTurn {
    pub role: ChatRole,
    pub content: String,
    pub tool_uses: Vec<ToolUseRecord>,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub turns: Vec<ChatTurn>,
    pub context_path: Option<PathBuf>,
    pub context_payload: AiPayload,
    pub model: Option<String>,
    pub session_id: String,
    /// Opaque per-session provider scratch state threaded through from ChatSession.
    /// Not serialised — purely Rust-internal. Providers read keys they care about
    /// (e.g. "resume_id" for claude-cli) and return sentinels to update them.
    pub provider_state: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "PascalCase")]
pub enum ChatDelta {
    Text(String),
    ToolCallStarted {
        id: String,
        name: String,
        input: JsonValue,
    },
    ToolCallFinished {
        id: String,
        output: String,
        is_error: bool,
    },
    Status(String),
    Done {
        finish_reason: Option<String>,
    },
    Error(String),
}

pub type ChatStream = Pin<Box<dyn Stream<Item = AppResult<ChatDelta>> + Send>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSettingsView {
    pub default_provider: Option<ProviderId>,
    pub claude_cli_model: Option<String>,
    pub codex_cli_model: Option<String>,
    pub anthropic_api_model: Option<String>,
    pub openai_api_model: Option<String>,
    pub overrides: Vec<AiConnectionOverrideView>,
    pub key_present: KeyPresence,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConnectionOverrideView {
    pub connection_id: String,
    pub provider_id: ProviderId,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KeyPresence {
    pub anthropic: bool,
    pub openai: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderListEntry {
    pub id: ProviderId,
    pub capabilities: Capabilities,
    pub validation: ValidationResult,
}

/// Build the system prompt for API providers, embedding the context payload as JSON.
/// Shared by `anthropic_api` and `openai_api` to avoid duplication.
pub fn build_system_prompt(payload: &AiPayload) -> crate::error::AppResult<String> {
    let payload_json = serde_json::to_string_pretty(payload)
        .map_err(|e| crate::error::AppError::Internal(format!("payload serialise failed: {e}")))?;
    Ok(format!(
        "Generate SQL for the user's request. Respond with only a SQL block in a fenced ```sql code block, no prose.\n\n# Database context\n```json\n{payload_json}\n```"
    ))
}

/// Helper used by API providers: extract the first fenced code block from the model's reply.
/// If no fenced block is found, returns the raw input trimmed.
pub fn extract_fenced_block(text: &str) -> String {
    // Match ```optional-lang\n...\n``` (multi-line). Use a simple state machine, not regex,
    // to avoid pulling in `regex` if it's not already a dep.
    if let Some(start) = text.find("```") {
        let after_open = &text[start + 3..];
        // Skip the optional language tag up to the first newline.
        let body_start = after_open.find('\n').map(|i| i + 1).unwrap_or(0);
        let body = &after_open[body_start..];
        if let Some(end) = body.find("```") {
            return body[..end].trim().to_string();
        }
    }
    text.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_id_serialises_as_kebab() {
        let s = serde_json::to_string(&ProviderId::ClaudeCli).unwrap();
        assert_eq!(s, "\"claude-cli\"");
        let back: ProviderId = serde_json::from_str("\"claude-cli\"").unwrap();
        assert_eq!(back, ProviderId::ClaudeCli);
    }

    #[test]
    fn provider_id_all_round_trips() {
        for id in ProviderId::ALL {
            let s = serde_json::to_string(&id).unwrap();
            let back: ProviderId = serde_json::from_str(&s).unwrap();
            assert_eq!(id, back);
            assert_eq!(ProviderId::from_kebab(id.as_kebab()), Some(id));
        }
    }

    #[test]
    fn extract_fenced_block_with_sql_lang() {
        let s = "Here is:\n\n```sql\nSELECT 1;\n```\n";
        assert_eq!(extract_fenced_block(s), "SELECT 1;");
    }

    #[test]
    fn extract_fenced_block_without_lang() {
        let s = "```\nSELECT 1;\n```";
        assert_eq!(extract_fenced_block(s), "SELECT 1;");
    }

    #[test]
    fn extract_fenced_block_falls_back_to_raw() {
        assert_eq!(extract_fenced_block("SELECT 1;"), "SELECT 1;");
        assert_eq!(extract_fenced_block("  SELECT 1;  "), "SELECT 1;");
    }

    #[test]
    fn validation_result_round_trips() {
        let r = ValidationResult::Missing { hint: "install".into() };
        let s = serde_json::to_string(&r).unwrap();
        let back: ValidationResult = serde_json::from_str(&s).unwrap();
        match back {
            ValidationResult::Missing { hint } => assert_eq!(hint, "install"),
            _ => panic!(),
        }
    }

    #[test]
    fn chat_delta_round_trips_all_variants() {
        let variants: Vec<ChatDelta> = vec![
            ChatDelta::Text("hello".into()),
            ChatDelta::ToolCallStarted {
                id: "tool-1".into(),
                name: "run_query".into(),
                input: serde_json::json!({"sql": "SELECT 1"}),
            },
            ChatDelta::ToolCallFinished {
                id: "tool-1".into(),
                output: "1 row".into(),
                is_error: false,
            },
            ChatDelta::Status("Thinking...".into()),
            ChatDelta::Done { finish_reason: Some("end_turn".into()) },
            ChatDelta::Done { finish_reason: None },
            ChatDelta::Error("something went wrong".into()),
        ];
        for variant in variants {
            let s = serde_json::to_string(&variant).unwrap();
            let back: ChatDelta = serde_json::from_str(&s).unwrap();
            // Re-serialise and compare JSON strings for equality.
            assert_eq!(
                serde_json::to_string(&back).unwrap(),
                s,
                "round-trip mismatch for: {s}"
            );
        }
    }
}
