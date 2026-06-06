use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
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
    /// Executed-query results the user attached as context for THIS message only.
    /// Not persisted in the session registry — transient per request. Default empty.
    pub attached_results: Vec<AttachedResult>,
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

/// One cross-provider wire shape for an attached executed-query result.
/// Cells are stringified at the frontend boundary (CellValue → String, NULL → "NULL"),
/// so the Rust side only ever carries `Vec<Vec<String>>` and never re-derives types.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachedResult {
    pub id: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub truncated: bool,
    pub row_count: usize,
}

/// Escape a cell value for a markdown table cell: pipes escaped, newlines collapsed.
fn escape_md_cell(cell: &str) -> String {
    cell.replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace(['\n', '\r'], " ")
}

/// Render a single attached result as a markdown table preceded by an identifying
/// `# Attached result (N rows)` header. Truncated results are explicitly marked.
/// Shared by API providers (system-prompt section) and CLI providers (prepended to
/// the latest user turn).
pub fn render_attached_result(att: &AttachedResult) -> String {
    let mut out = String::new();
    out.push_str(&format!("# Attached result ({} rows)\n", att.row_count));
    if att.truncated {
        out.push_str(&format!(
            "(truncated — showing first {} of {} rows)\n",
            att.rows.len(),
            att.row_count
        ));
    }
    out.push('\n');
    out.push_str("| ");
    out.push_str(&att.columns.join(" | "));
    out.push_str(" |\n");
    out.push_str("| ");
    out.push_str(&att.columns.iter().map(|_| "---").collect::<Vec<_>>().join(" | "));
    out.push_str(" |\n");
    for row in &att.rows {
        out.push_str("| ");
        out.push_str(&row.iter().map(|c| escape_md_cell(c)).collect::<Vec<_>>().join(" | "));
        out.push_str(" |\n");
    }
    out
}

/// Render the `# Attached results` section appended to the API system prompt.
/// One section, sub-headed per attachment (stable single delimiter).
fn render_attachments_section(attachments: &[AttachedResult]) -> String {
    let tables: Vec<String> = attachments.iter().map(render_attached_result).collect();
    format!(
        "# Attached results\n\
The user has attached the following executed query result(s) as additional context. \
Treat them as data the user is asking about.\n\n{}",
        tables.join("\n\n")
    )
}

/// Prefix string (with trailing blank line) used by CLI providers to prepend the
/// rendered attachment table(s) to the latest user turn. Empty when no attachments.
pub fn render_attachments_prefix(attachments: &[AttachedResult]) -> String {
    if attachments.is_empty() {
        return String::new();
    }
    let tables: Vec<String> = attachments.iter().map(render_attached_result).collect();
    format!("{}\n\n", tables.join("\n\n"))
}

/// Oldest-first attachment eviction for API providers. Drops attachments from the
/// front (oldest) until the composed system prompt (context + remaining attachments)
/// plus the conversation history fits within `threshold` tokens (chars/4 heuristic).
/// Runs BEFORE per-turn trimming. Returns the number of attachments evicted.
pub fn evict_attachments_oldest_first(
    attachments: &mut Vec<AttachedResult>,
    payload: &AiPayload,
    turn_chars: usize,
    threshold: usize,
) -> AppResult<usize> {
    let mut evicted = 0usize;
    while !attachments.is_empty() {
        let system = build_api_system_prompt(payload, attachments)?;
        let est = (system.len() + turn_chars) / 4;
        if est <= threshold {
            break;
        }
        attachments.remove(0);
        evicted += 1;
    }
    Ok(evicted)
}

/// Build the system prompt for API providers (Anthropic API, OpenAI API).
///
/// Assembles output from an ordered Vec<String> of delimited sections joined at the end.
/// Fixed section order (MUST NOT be reordered — change #62 depends on this):
///   1. Role + hard SQL-only / no-execution restrictions  ← this change
///   2. Database context (serialised AiPayload)           ← this change
///   3. Attached query results (when present)             ← #62 (AttachedResult)
///
/// API providers have NO disk access; this prompt deliberately contains no filesystem
/// or directory-read language.
pub fn build_api_system_prompt(
    payload: &AiPayload,
    attachments: &[AttachedResult],
) -> AppResult<String> {
    let mut sections: Vec<String> = Vec::new();

    // ── Section 1: Role + hard restrictions ─────────────────────────────────
    // MUST be the first section. Contains the SQL-only mandate, the single-fenced-
    // block output format, and an explicit prohibition on self-execution via any
    // shell, Bash, MCP, or database CLI tool.
    sections.push(
        "# Role and restrictions\n\
You are a SQL generation assistant embedded in Argus, a database inspection tool.\n\
\n\
**Your only job is to generate SQL.** Respond with a single fenced ```sql code block \
containing the SQL query that answers the user's request. Do not include any prose, \
explanation, or commentary outside that block.\n\
\n\
**You MUST NOT execute SQL yourself.** You are strictly forbidden from running SQL or \
interacting with databases via any mechanism, including but not limited to:\n\
- Shell or Bash commands\n\
- MCP tools\n\
- Database CLIs: `psql`, `mysql`, `mariadb`, `sqlcmd`, `aws dynamodb`, `aws logs`, or any equivalent\n\
\n\
Argus will execute the SQL you emit. Your role ends at generation."
            .to_string(),
    );

    // ── Section 2: Database context (serialised AiPayload) ──────────────────
    // MUST follow section 1. This is the authoritative source of schema information
    // for API providers. The payload is the serialised context folder content.
    let payload_json = serde_json::to_string_pretty(payload)
        .map_err(|e| crate::error::AppError::Internal(format!("payload serialise failed: {e}")))?;
    sections.push(format!(
        "# Database context\n\
The following JSON contains the authoritative schema and documentation for the database \
you are generating SQL for. Use it as your primary information source.\n\
\n\
```json\n{payload_json}\n```"
    ));

    // ── Section 3: Attached query results (when present) ────────────────────
    // Filled by change `attach-query-results-to-chat`. Always LAST so the data
    // the user is asking about sits closest to their current question. When the
    // attachments slice is empty nothing is pushed and the output is byte-identical
    // to the prior two-section prompt.
    if !attachments.is_empty() {
        sections.push(render_attachments_section(attachments));
    }

    Ok(sections.join("\n\n---\n\n"))
}

/// Build the system prompt for CLI providers (claude-cli, codex-cli).
///
/// CLI providers run with `cwd` set to the connection's context folder, so
/// this prompt names that folder as the primary information source and the
/// parent directory (`../`) as secondary.
///
/// Verified flags (claude CLI 2.1.152, 2026-06-06):
///   --system-prompt <prompt>   replaces the session system prompt
///   --tools <list>             restricts available built-in tools
///
/// NOTE: This prompt deliberately avoids embedding the full AiPayload JSON —
/// the agent reads it from disk. Do NOT add payload serialisation here.
pub fn build_cli_system_prompt(context_path: &Path) -> String {
    let path_display = context_path.display();
    format!(
        "# Role and restrictions\n\
You are a SQL generation assistant embedded in Argus, a database inspection tool.\n\
\n\
**Your only job is to generate SQL.** Respond with a single fenced ```sql code block \
containing the SQL query that answers the user's request. Do not include any prose, \
explanation, or commentary outside that block.\n\
\n\
**You MUST NOT execute SQL yourself.** You are strictly forbidden from running SQL or \
interacting with databases via any mechanism, including but not limited to:\n\
- Shell or Bash commands\n\
- MCP tools\n\
- Database CLIs: `psql`, `mysql`, `mariadb`, `sqlcmd`, `aws dynamodb`, `aws logs`, or any equivalent\n\
\n\
Argus will execute the SQL you emit. Your role ends at generation.\n\
\n\
---\n\
\n\
# Information sources\n\
\n\
## Primary source — context folder\n\
Your current working directory is the context folder for this connection: `{path_display}`\n\
\n\
Read these files **first** before answering any question:\n\
- `manifest.json`  — connection metadata and source configuration\n\
- `overview.md`    — human-written description of the database and its purpose\n\
- `glossary.md`    — domain-specific terminology and abbreviations\n\
- `objects/`       — per-object documentation (tables, views, functions, etc.)\n\
- `queries/`       — prefab queries and examples for this connection\n\
\n\
## Secondary source — project / cross-connection docs\n\
The parent directory (`../`) may contain cross-connection skills, shared glossaries, \
and project-level documentation that applies to multiple connections. Consult it when \
the context folder alone is insufficient."
    )
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
    use crate::modules::context::types::AiPayload;

    fn empty_payload() -> AiPayload {
        AiPayload {
            manifest: None,
            overview: None,
            glossary: None,
            objects: vec![],
            queries: vec![],
        }
    }

    // ── build_api_system_prompt tests ─────────────────────────────────────────

    #[test]
    fn api_prompt_contains_sql_only_clause() {
        let prompt = build_api_system_prompt(&empty_payload(), &[]).unwrap();
        assert!(
            prompt.contains("```sql"),
            "expected fenced sql block instruction, got:\n{prompt}"
        );
        assert!(
            prompt.contains("Your only job is to generate SQL")
                || prompt.contains("only job is to generate SQL"),
            "expected SQL-only clause"
        );
    }

    #[test]
    fn api_prompt_contains_no_execution_clause() {
        let prompt = build_api_system_prompt(&empty_payload(), &[]).unwrap();
        assert!(
            prompt.contains("MUST NOT execute SQL"),
            "expected no-execution clause"
        );
        assert!(
            prompt.contains("psql") && prompt.contains("mysql") && prompt.contains("sqlcmd"),
            "expected database CLI prohibition list"
        );
    }

    #[test]
    fn api_prompt_contains_no_filesystem_language() {
        let prompt = build_api_system_prompt(&empty_payload(), &[]).unwrap();
        // API providers have no disk access; the prompt must not instruct them to read files.
        let lower = prompt.to_lowercase();
        assert!(
            !lower.contains("read file") && !lower.contains("read the file"),
            "API prompt must not contain 'read file' language: {lower}"
        );
        // "directory" may appear inside JSON payload field names — check for instructional phrasing
        assert!(
            !lower.contains("your current working directory"),
            "API prompt must not reference working directory: {lower}"
        );
        assert!(
            !lower.contains("context folder"),
            "API prompt must not reference 'context folder' (disk concept): {lower}"
        );
    }

    #[test]
    fn api_prompt_role_section_precedes_context_section() {
        let prompt = build_api_system_prompt(&empty_payload(), &[]).unwrap();
        let role_pos = prompt
            .find("# Role and restrictions")
            .expect("role section header not found");
        let context_pos = prompt
            .find("# Database context")
            .expect("context section header not found");
        assert!(
            role_pos < context_pos,
            "role section (index {role_pos}) must precede context section (index {context_pos})"
        );
    }

    // ── build_cli_system_prompt tests ─────────────────────────────────────────

    #[test]
    fn cli_prompt_contains_sql_only_clause() {
        let path = std::path::Path::new("/tmp/my-context");
        let prompt = build_cli_system_prompt(path);
        assert!(
            prompt.contains("```sql"),
            "expected fenced sql block instruction"
        );
        assert!(
            prompt.contains("only job is to generate SQL"),
            "expected SQL-only clause"
        );
    }

    #[test]
    fn cli_prompt_contains_no_execution_clause() {
        let path = std::path::Path::new("/tmp/my-context");
        let prompt = build_cli_system_prompt(path);
        assert!(
            prompt.contains("MUST NOT execute SQL"),
            "expected no-execution clause"
        );
        assert!(
            prompt.contains("psql") && prompt.contains("mysql") && prompt.contains("sqlcmd"),
            "expected database CLI prohibition list"
        );
    }

    #[test]
    fn cli_prompt_references_context_folder() {
        let path = std::path::Path::new("/tmp/my-context");
        let prompt = build_cli_system_prompt(path);
        assert!(
            prompt.contains("/tmp/my-context"),
            "expected context path in prompt"
        );
        assert!(
            prompt.contains("manifest.json")
                && prompt.contains("overview.md")
                && prompt.contains("glossary.md")
                && prompt.contains("objects/")
                && prompt.contains("queries/"),
            "expected all context folder artifacts named"
        );
    }

    #[test]
    fn cli_prompt_references_parent_directory() {
        let path = std::path::Path::new("/tmp/my-context");
        let prompt = build_cli_system_prompt(path);
        assert!(
            prompt.contains("../"),
            "expected parent directory reference (../)"
        );
        assert!(
            prompt.contains("cross-connection") || prompt.contains("secondary source"),
            "expected parent directory described as secondary/cross-connection source"
        );
    }

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

    fn sample_attachment(id: &str) -> AttachedResult {
        AttachedResult {
            id: id.to_string(),
            columns: vec!["name".into(), "count".into()],
            rows: vec![
                vec!["alice".into(), "3".into()],
                vec!["bob".into(), "5".into()],
            ],
            truncated: false,
            row_count: 2,
        }
    }

    #[test]
    fn api_prompt_no_attachments_is_byte_identical() {
        // The two-arg call with an empty slice must equal the prior two-section output.
        let with_empty = build_api_system_prompt(&empty_payload(), &[]).unwrap();
        // Reconstruct expected: role + context only, no trailing attachments section.
        assert!(!with_empty.contains("# Attached result"));
        assert!(with_empty.contains("# Role and restrictions"));
        assert!(with_empty.contains("# Database context"));
        // Exactly one delimiter between the two sections.
        assert_eq!(with_empty.matches("\n\n---\n\n").count(), 1);
    }

    #[test]
    fn api_prompt_appends_attachments_as_trailing_section() {
        let atts = vec![sample_attachment("a1")];
        let prompt = build_api_system_prompt(&empty_payload(), &atts).unwrap();
        let ctx_pos = prompt.find("# Database context").unwrap();
        let att_pos = prompt.find("# Attached results").unwrap();
        assert!(att_pos > ctx_pos, "attachments section must be last");
        assert!(prompt.contains("| name | count |"));
        assert!(prompt.contains("| alice | 3 |"));
    }

    #[test]
    fn api_prompt_marks_truncated_attachment() {
        let mut att = sample_attachment("a1");
        att.truncated = true;
        att.row_count = 9999;
        let prompt = build_api_system_prompt(&empty_payload(), &[att]).unwrap();
        assert!(prompt.contains("# Attached result (9999 rows)"));
        assert!(prompt.contains("truncated"));
    }

    #[test]
    fn evict_drops_oldest_until_fits() {
        // Build several large attachments so the section blows the budget.
        let big_row = vec!["x".repeat(2000), "y".repeat(2000)];
        let make = |id: &str| AttachedResult {
            id: id.to_string(),
            columns: vec!["a".into(), "b".into()],
            rows: vec![big_row.clone(); 50],
            truncated: false,
            row_count: 50,
        };
        let mut atts = vec![make("oldest"), make("middle"), make("newest")];
        // Tiny threshold forces eviction; turn_chars=0.
        let evicted = evict_attachments_oldest_first(&mut atts, &empty_payload(), 0, 100).unwrap();
        assert!(evicted >= 1, "expected at least one eviction");
        // The newest attachment is the one most likely to survive; oldest dropped first.
        if let Some(first) = atts.first() {
            assert_ne!(first.id, "oldest", "oldest should be evicted before newer ones");
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
