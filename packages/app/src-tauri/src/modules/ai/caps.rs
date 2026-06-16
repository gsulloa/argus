// Default models and curated lists per Decision 8 of design.md.

pub const CLAUDE_CLI_DEFAULT_MODEL: &str = "claude-opus-4-7";
pub const CLAUDE_CLI_MODELS: &[&str] = &["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"];

pub const CODEX_CLI_DEFAULT_MODEL: &str = "gpt-5.1";
pub const CODEX_CLI_MODELS: &[&str] = &["gpt-5.1", "o3-mini"];

pub const ANTHROPIC_API_DEFAULT_MODEL: &str = "claude-opus-4-7";
pub const ANTHROPIC_API_MODELS: &[&str] = &["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"];

pub const OPENAI_API_DEFAULT_MODEL: &str = "gpt-4o";
pub const OPENAI_API_MODELS: &[&str] = &["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"];

/// Context window size in tokens for a given model identifier.
/// Used by API providers to trim conversation history before exceeding 80% capacity.
/// Conservative defaults are used for unknown models.
pub fn context_window(model: &str) -> usize {
    match model {
        // Anthropic Claude models — 200k context
        "claude-opus-4-7" | "claude-sonnet-4-6" | "claude-haiku-4-5" => 200_000,
        // OpenAI GPT-4o family — 128k context
        "gpt-4o" | "gpt-4o-mini" | "gpt-4-turbo" => 128_000,
        // OpenAI newer models — approximate 200k
        "gpt-5.1" | "o3-mini" => 200_000,
        // Safe conservative default for any unknown model.
        _ => 100_000,
    }
}
