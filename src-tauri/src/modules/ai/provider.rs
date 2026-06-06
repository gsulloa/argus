use async_trait::async_trait;

use crate::error::{AppError, AppResult};
use crate::modules::ai::types::{
    Capabilities, ChatDelta, ChatRequest, ChatStream, ChatRole, ChatTurn,
    GenerateDelta, GenerateRequest, GenerateStream, ProviderId, ValidationResult,
};

#[async_trait]
pub trait AiProvider: Send + Sync {
    fn id(&self) -> ProviderId;
    fn capabilities(&self) -> Capabilities;
    async fn validate(&self) -> ValidationResult;

    /// Multi-turn chat with rich event stream. Primary method going forward.
    async fn chat(&self, req: ChatRequest) -> AppResult<ChatStream>;

    /// Convenience wrapper for single-turn SQL generation. Retained for the
    /// `ai_generate_sql` Tauri command which has no remaining frontend caller.
    /// Default impl wraps `chat()` and collects text-only deltas.
    async fn generate_sql(&self, req: GenerateRequest) -> AppResult<GenerateStream> {
        default_generate_via_chat(self, req).await
    }
}

/// Default `generate_sql` implementation: convert the single prompt into a
/// one-turn chat, drive `chat()`, collect Text deltas, emit `GenerateDelta::Text(joined)`
/// + `Done`. Implemented as a free function so providers that want to override
/// `generate_sql` can do so without re-implementing this.
async fn default_generate_via_chat<P: AiProvider + ?Sized>(
    provider: &P,
    req: GenerateRequest,
) -> AppResult<GenerateStream> {
    use futures::StreamExt;
    let chat_req = ChatRequest {
        turns: vec![ChatTurn {
            role: ChatRole::User,
            content: req.prompt,
            tool_uses: vec![],
        }],
        context_path: req.context_path,
        context_payload: req.context_payload,
        model: req.model,
        session_id: format!("legacy-generate-{}", uuid::Uuid::new_v4()),
        provider_state: std::collections::HashMap::new(),
        attached_results: vec![],
    };
    let mut stream = provider.chat(chat_req).await?;
    let mut text = String::new();
    let mut finish: Option<String> = None;
    while let Some(item) = stream.next().await {
        match item? {
            ChatDelta::Text(t) => text.push_str(&t),
            ChatDelta::Done { finish_reason } => { finish = finish_reason; break; }
            ChatDelta::Error(e) => return Err(AppError::Internal(e)),
            // Ignore tool-call and status events in the legacy path.
            _ => {}
        }
    }
    let s = futures::stream::iter(vec![
        Ok(GenerateDelta::Text(text)),
        Ok(GenerateDelta::Done { finish_reason: finish }),
    ]);
    Ok(Box::pin(s))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn _assert_object_safe(_: Box<dyn AiProvider>) {}
}
