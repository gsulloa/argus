use crate::error::AppResult;
use crate::modules::ai::anthropic_api::AnthropicApi;
use crate::modules::ai::claude_cli::ClaudeCli;
use crate::modules::ai::codex_cli::CodexCli;
use crate::modules::ai::openai_api::OpenAiApi;
use crate::modules::ai::provider::AiProvider;
use crate::modules::ai::settings::{AiSettings, AiSettingsRow};
use crate::modules::ai::types::ProviderId;
use crate::platform::DbState;

/// Build a provider with the model column from the current `ai_settings` row.
/// API keys are read by each provider at call time directly from the keyring,
/// so the factory does NOT inject them — this matches the spec's
/// "API key read fresh per call" scenario.
pub fn build(db: &DbState, id: ProviderId) -> AppResult<Box<dyn AiProvider>> {
    let (row, _overrides) = AiSettings::get(db)?;
    let model = configured_model(&row, id);
    Ok(match id {
        ProviderId::ClaudeCli => Box::new(ClaudeCli::new(model)),
        ProviderId::CodexCli => Box::new(CodexCli::new(model)),
        ProviderId::AnthropicApi => Box::new(AnthropicApi::new(model)),
        ProviderId::OpenAiApi => Box::new(OpenAiApi::new(model)),
    })
}

fn configured_model(row: &AiSettingsRow, id: ProviderId) -> Option<String> {
    match id {
        ProviderId::ClaudeCli => row.claude_cli_model.clone(),
        ProviderId::CodexCli => row.codex_cli_model.clone(),
        ProviderId::AnthropicApi => row.anthropic_api_model.clone(),
        ProviderId::OpenAiApi => row.openai_api_model.clone(),
    }
}
