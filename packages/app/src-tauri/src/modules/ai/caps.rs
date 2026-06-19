// Default models and curated lists per Decision 8 of design.md.

pub const CLAUDE_CLI_DEFAULT_MODEL: &str = "claude-opus-4-8";
pub const CLAUDE_CLI_MODELS: &[&str] = &["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"];

pub const CODEX_CLI_DEFAULT_MODEL: &str = "gpt-5.1";
pub const CODEX_CLI_MODELS: &[&str] = &["gpt-5.1", "gpt-5.1-codex"];

pub const ANTHROPIC_API_DEFAULT_MODEL: &str = "claude-opus-4-8";
pub const ANTHROPIC_API_MODELS: &[&str] = &["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"];

pub const OPENAI_API_DEFAULT_MODEL: &str = "gpt-5.1";
pub const OPENAI_API_MODELS: &[&str] = &["gpt-5.1", "gpt-5.1-mini", "gpt-4o"];

/// Context window size in tokens for a given model identifier.
/// Used by API providers to trim conversation history before exceeding 80% capacity.
/// Conservative defaults are used for unknown models.
pub fn context_window(model: &str) -> usize {
    match model {
        // Anthropic Claude models — 200k context
        "claude-opus-4-8" | "claude-sonnet-4-6" | "claude-haiku-4-5" => 200_000,
        // OpenAI gpt-5.1 family — 200k context
        "gpt-5.1" | "gpt-5.1-mini" | "gpt-5.1-codex" => 200_000,
        // OpenAI gpt-4o — 128k context
        "gpt-4o" => 128_000,
        // Safe conservative default for any unknown model.
        _ => 100_000,
    }
}

/// Available models for a kebab-case provider id, or empty if unknown.
pub fn available_models_for(provider_kebab: &str) -> &'static [&'static str] {
    match provider_kebab {
        "claude-cli" => CLAUDE_CLI_MODELS,
        "codex-cli" => CODEX_CLI_MODELS,
        "anthropic-api" => ANTHROPIC_API_MODELS,
        "openai-api" => OPENAI_API_MODELS,
        _ => &[],
    }
}

/// Drop a stored model id the provider no longer advertises so callers fall back
/// to the provider default. Returns None when the model is unset or retired.
pub fn sanitize_model(provider_kebab: &str, model: Option<String>) -> Option<String> {
    match model {
        Some(m) if available_models_for(provider_kebab).contains(&m.as_str()) => Some(m),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_cli_default_and_list() {
        assert_eq!(CLAUDE_CLI_DEFAULT_MODEL, "claude-opus-4-8");
        assert_eq!(CLAUDE_CLI_MODELS, &["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]);
        assert!(CLAUDE_CLI_MODELS.contains(&CLAUDE_CLI_DEFAULT_MODEL));
    }

    #[test]
    fn anthropic_api_default_and_list() {
        assert_eq!(ANTHROPIC_API_DEFAULT_MODEL, "claude-opus-4-8");
        assert_eq!(ANTHROPIC_API_MODELS, &["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]);
        assert!(ANTHROPIC_API_MODELS.contains(&ANTHROPIC_API_DEFAULT_MODEL));
    }

    #[test]
    fn codex_cli_default_and_list() {
        assert_eq!(CODEX_CLI_DEFAULT_MODEL, "gpt-5.1");
        assert_eq!(CODEX_CLI_MODELS, &["gpt-5.1", "gpt-5.1-codex"]);
        assert!(CODEX_CLI_MODELS.contains(&CODEX_CLI_DEFAULT_MODEL));
    }

    #[test]
    fn openai_api_default_and_list() {
        assert_eq!(OPENAI_API_DEFAULT_MODEL, "gpt-5.1");
        assert_eq!(OPENAI_API_MODELS, &["gpt-5.1", "gpt-5.1-mini", "gpt-4o"]);
        assert!(OPENAI_API_MODELS.contains(&OPENAI_API_DEFAULT_MODEL));
    }

    #[test]
    fn context_window_claude_models() {
        assert_eq!(context_window("claude-opus-4-8"), 200_000);
        assert_eq!(context_window("claude-sonnet-4-6"), 200_000);
        assert_eq!(context_window("claude-haiku-4-5"), 200_000);
    }

    #[test]
    fn context_window_gpt51_family() {
        assert_eq!(context_window("gpt-5.1"), 200_000);
        assert_eq!(context_window("gpt-5.1-mini"), 200_000);
        assert_eq!(context_window("gpt-5.1-codex"), 200_000);
    }

    #[test]
    fn context_window_gpt4o() {
        assert_eq!(context_window("gpt-4o"), 128_000);
    }

    #[test]
    fn context_window_unknown() {
        assert_eq!(context_window("some-future-model"), 100_000);
        assert_eq!(context_window(""), 100_000);
    }

    #[test]
    fn sanitize_model_retired_returns_none() {
        assert_eq!(sanitize_model("openai-api", Some("gpt-4o-mini".into())), None);
    }

    #[test]
    fn sanitize_model_valid_returns_some() {
        assert_eq!(
            sanitize_model("anthropic-api", Some("claude-sonnet-4-6".into())),
            Some("claude-sonnet-4-6".to_string())
        );
    }

    #[test]
    fn sanitize_model_none_input_returns_none() {
        assert_eq!(sanitize_model("openai-api", None), None);
    }

    #[test]
    fn sanitize_model_unknown_provider_returns_none() {
        // Unknown provider has empty model list, so any model is "retired".
        assert_eq!(sanitize_model("unknown-provider", Some("gpt-5.1".into())), None);
    }

    #[test]
    fn retired_ids_not_in_any_list() {
        let retired = ["claude-opus-4-7", "gpt-4o-mini", "gpt-4-turbo", "o3-mini"];
        for id in &retired {
            assert!(!CLAUDE_CLI_MODELS.contains(id), "{id} should not be in CLAUDE_CLI_MODELS");
            assert!(!CODEX_CLI_MODELS.contains(id), "{id} should not be in CODEX_CLI_MODELS");
            assert!(!ANTHROPIC_API_MODELS.contains(id), "{id} should not be in ANTHROPIC_API_MODELS");
            assert!(!OPENAI_API_MODELS.contains(id), "{id} should not be in OPENAI_API_MODELS");
        }
    }
}
