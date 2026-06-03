use std::time::Duration;

use async_trait::async_trait;
use futures::stream;
use reqwest::Client;
use serde_json::json;

use crate::error::{AppError, AppResult};
use crate::modules::ai::caps::{context_window, ANTHROPIC_API_DEFAULT_MODEL, ANTHROPIC_API_MODELS};
use crate::modules::ai::keys::{self, ACCOUNT_ANTHROPIC};
use crate::modules::ai::provider::AiProvider;
use crate::modules::ai::types::{
    build_system_prompt, extract_fenced_block, Capabilities, ChatDelta, ChatRequest, ChatRole,
    ChatStream, GenerateDelta, GenerateRequest, GenerateStream, ProviderId, ValidationResult,
};

const VALIDATION_TIMEOUT: Duration = Duration::from_secs(3);
const GENERATE_TIMEOUT: Duration = Duration::from_secs(60);
const ANTHROPIC_VERSION: &str = "2023-06-01";

pub struct AnthropicApi {
    pub configured_model: Option<String>,
    /// Override the API base URL — used by tests with wiremock.
    pub base_url: Option<String>,
}

impl AnthropicApi {
    pub fn new(configured_model: Option<String>) -> Self {
        Self {
            configured_model,
            base_url: None,
        }
    }

    pub fn with_base_url(configured_model: Option<String>, base_url: String) -> Self {
        Self {
            configured_model,
            base_url: Some(base_url),
        }
    }

    fn messages_url(&self) -> String {
        let base = self
            .base_url
            .as_deref()
            .unwrap_or("https://api.anthropic.com");
        format!("{base}/v1/messages")
    }
}

#[async_trait]
impl AiProvider for AnthropicApi {
    fn id(&self) -> ProviderId {
        ProviderId::AnthropicApi
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            can_read_files: false,
            supports_streaming: true,
            requires_api_key: true,
            default_model: ANTHROPIC_API_DEFAULT_MODEL,
            available_models: ANTHROPIC_API_MODELS,
        }
    }

    async fn validate(&self) -> ValidationResult {
        let key = match keys::get(ACCOUNT_ANTHROPIC) {
            Ok(Some(k)) => k,
            Ok(None) => {
                return ValidationResult::Missing {
                    hint: "Enter an Anthropic API key in the AI settings panel".into(),
                }
            }
            Err(e) => {
                return ValidationResult::Misconfigured {
                    reason: format!("keyring read failed: {e}"),
                }
            }
        };

        let body = json!({
            "model": self.configured_model.as_deref().unwrap_or(ANTHROPIC_API_DEFAULT_MODEL),
            "max_tokens": 1,
            "messages": [{ "role": "user", "content": "hi" }],
        });

        let client = match Client::builder().timeout(VALIDATION_TIMEOUT).build() {
            Ok(c) => c,
            Err(e) => {
                return ValidationResult::Misconfigured {
                    reason: format!("http client init failed: {e}"),
                }
            }
        };

        match client
            .post(self.messages_url())
            .header("x-api-key", &key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    ValidationResult::Ready
                } else if status == reqwest::StatusCode::UNAUTHORIZED
                    || status == reqwest::StatusCode::FORBIDDEN
                {
                    ValidationResult::Misconfigured {
                        reason: "API key rejected".into(),
                    }
                } else {
                    ValidationResult::Misconfigured {
                        reason: format!("unexpected status {status}"),
                    }
                }
            }
            Err(e) if e.is_timeout() => ValidationResult::Misconfigured {
                reason: "request timed out".into(),
            },
            Err(e) => ValidationResult::Misconfigured {
                reason: format!("network unreachable: {e}"),
            },
        }
    }

    async fn generate_sql(&self, req: GenerateRequest) -> AppResult<GenerateStream> {
        if let Some(m) = &req.model {
            if !ANTHROPIC_API_MODELS.iter().any(|x| *x == m) {
                return Err(AppError::Validation(format!("unsupported model: {m}")));
            }
        }
        let model = req
            .model
            .clone()
            .or_else(|| self.configured_model.clone())
            .unwrap_or_else(|| ANTHROPIC_API_DEFAULT_MODEL.to_string());

        let key = keys::get(ACCOUNT_ANTHROPIC)
            .map_err(|e| AppError::Keychain(format!("read anthropic key: {e}")))?
            .ok_or_else(|| AppError::Validation("Anthropic API key not configured".into()))?;

        let system_prompt = build_system_prompt(&req.context_payload)?;
        let body = json!({
            "model": model,
            "max_tokens": 4096,
            "system": system_prompt,
            "messages": [{ "role": "user", "content": req.prompt }],
        });

        let client = Client::builder()
            .timeout(GENERATE_TIMEOUT)
            .build()
            .map_err(|e| AppError::Internal(format!("http client init failed: {e}")))?;

        let resp = client
            .post(self.messages_url())
            .header("x-api-key", &key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("anthropic request failed: {e}")))?;

        let status = resp.status();
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(format!("anthropic response not json: {e}")))?;

        if !status.is_success() {
            return Err(AppError::Internal(format!(
                "anthropic returned {status}: {}",
                json.get("error")
                    .map(|e| e.to_string())
                    .unwrap_or_default()
            )));
        }

        let text = json
            .get("content")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default();

        let finish_reason = json
            .get("stop_reason")
            .and_then(|s| s.as_str())
            .map(String::from);
        let extracted = extract_fenced_block(&text);

        let s = stream::iter(vec![
            Ok(GenerateDelta::Text(extracted)),
            Ok(GenerateDelta::Done { finish_reason }),
        ]);
        Ok(Box::pin(s))
    }

    async fn chat(&self, req: ChatRequest) -> AppResult<ChatStream> {
        // 1. Validate model before any work.
        if let Some(m) = &req.model {
            if !ANTHROPIC_API_MODELS.iter().any(|x| *x == m) {
                return Err(AppError::Validation(format!("unsupported model: {m}")));
            }
        }
        let model = req
            .model
            .clone()
            .or_else(|| self.configured_model.clone())
            .unwrap_or_else(|| ANTHROPIC_API_DEFAULT_MODEL.to_string());

        // 2. Read API key.
        let key = keys::get(ACCOUNT_ANTHROPIC)
            .map_err(|e| AppError::Keychain(format!("read anthropic key: {e}")))?
            .ok_or_else(|| AppError::Validation("Anthropic API key not configured".into()))?;

        // 3. Build system prompt.
        let system_prompt = build_system_prompt(&req.context_payload)?;

        // 4. Context-window trimming.
        let window = context_window(&model);
        let threshold = (window as f64 * 0.8) as usize;

        let mut turns = req.turns.clone();
        // Estimate tokens for all turns + system prompt.
        let system_chars = system_prompt.len();
        let trim_status = trim_turns_to_fit(&mut turns, system_chars, threshold);

        // 5. Build messages array 1:1 from turns.
        let messages: Vec<serde_json::Value> = turns
            .iter()
            .map(|t| {
                let role = match t.role {
                    ChatRole::User => "user",
                    ChatRole::Assistant => "assistant",
                };
                json!({ "role": role, "content": t.content })
            })
            .collect();

        let body = json!({
            "model": model,
            "max_tokens": 4096,
            "system": system_prompt,
            "messages": messages,
        });

        let client = Client::builder()
            .timeout(GENERATE_TIMEOUT)
            .build()
            .map_err(|e| AppError::Internal(format!("http client init failed: {e}")))?;

        let resp = client
            .post(self.messages_url())
            .header("x-api-key", &key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    AppError::Internal("anthropic request timed out".into())
                } else {
                    AppError::Internal(format!("anthropic request failed: {e}"))
                }
            })?;

        let status = resp.status();
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(format!("anthropic response not json: {e}")))?;

        if !status.is_success() {
            return Err(AppError::Internal(format!(
                "anthropic returned {status}: {}",
                json.get("error")
                    .map(|e| e.to_string())
                    .unwrap_or_default()
            )));
        }

        let text = json
            .get("content")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default();

        let finish_reason = json
            .get("stop_reason")
            .and_then(|s| s.as_str())
            .map(String::from);
        let extracted = extract_fenced_block(&text);

        // Build stream: optionally prepend trim notice, then text + done.
        let mut items: Vec<AppResult<ChatDelta>> = Vec::new();
        if let Some(n) = trim_status {
            items.push(Ok(ChatDelta::Status(format!(
                "trimmed {n} old turns to fit context window"
            ))));
        }
        items.push(Ok(ChatDelta::Text(extracted)));
        items.push(Ok(ChatDelta::Done { finish_reason }));

        Ok(Box::pin(stream::iter(items)))
    }
}

/// Estimate total token count (chars / 4 heuristic).
fn estimate_tokens(turns: &[crate::modules::ai::types::ChatTurn], system_chars: usize) -> usize {
    let turn_chars: usize = turns.iter().map(|t| t.content.len()).sum();
    (system_chars + turn_chars) / 4
}

/// Trim oldest non-last turns until estimated tokens fit within threshold.
/// Returns Some(count_trimmed) if any were removed, None otherwise.
/// Always preserves the most recent User turn (the last entry).
fn trim_turns_to_fit(
    turns: &mut Vec<crate::modules::ai::types::ChatTurn>,
    system_chars: usize,
    threshold: usize,
) -> Option<usize> {
    let mut trimmed = 0usize;
    while turns.len() > 1 && estimate_tokens(turns, system_chars) > threshold {
        turns.remove(0);
        trimmed += 1;
    }
    if trimmed > 0 { Some(trimmed) } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::ai::keys;
    use crate::modules::ai::types::{ChatRole, ChatTurn};
    use crate::modules::context::types::AiPayload;
    use futures::StreamExt;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn empty_payload() -> AiPayload {
        AiPayload {
            manifest: None,
            overview: None,
            glossary: None,
            objects: vec![],
            queries: vec![],
        }
    }

    async fn collect_text(stream: GenerateStream) -> (Vec<String>, Option<String>) {
        let mut texts = Vec::new();
        let mut finish = None;
        futures::pin_mut!(stream);
        while let Some(item) = stream.next().await {
            match item.unwrap() {
                GenerateDelta::Text(t) => texts.push(t),
                GenerateDelta::Done { finish_reason } => finish = finish_reason,
            }
        }
        (texts, finish)
    }

    async fn collect_chat(stream: ChatStream) -> Vec<ChatDelta> {
        futures::pin_mut!(stream);
        let mut out = Vec::new();
        while let Some(item) = stream.next().await {
            out.push(item.unwrap());
        }
        out
    }

    fn make_chat_req(turns: Vec<ChatTurn>, base_url: &str) -> (AnthropicApi, ChatRequest) {
        let provider = AnthropicApi::with_base_url(None, base_url.to_string());
        let req = ChatRequest {
            turns,
            context_path: None,
            context_payload: empty_payload(),
            model: None,
            session_id: "test-session".into(),
            provider_state: Default::default(),
        };
        (provider, req)
    }

    #[tokio::test]
    async fn validate_returns_ready_on_200() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "content": [{"type": "text", "text": "hi"}],
                "stop_reason": "end_turn"
            })))
            .mount(&server)
            .await;

        // Use a unique account key per test to avoid cross-test contamination.
        let account = format!("ai:anthropic-test-200-{}", uuid::Uuid::new_v4());
        keys::set(&account, "test-key-200").unwrap();

        // Construct a provider that reads from our test account.
        // Since keys::get uses ACCOUNT_ANTHROPIC constant, we plant directly there.
        keys::set(ACCOUNT_ANTHROPIC, "test-key-200").unwrap();

        let provider = AnthropicApi::with_base_url(None, server.uri());
        assert!(matches!(provider.validate().await, ValidationResult::Ready));
    }

    #[tokio::test]
    async fn validate_returns_misconfigured_on_401() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "error": { "type": "authentication_error", "message": "invalid x-api-key" }
            })))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_ANTHROPIC, "bad-key").unwrap();
        let provider = AnthropicApi::with_base_url(None, server.uri());
        let result = provider.validate().await;
        assert!(matches!(
            result,
            ValidationResult::Misconfigured { reason } if reason == "API key rejected"
        ));
    }

    #[tokio::test]
    async fn validate_returns_misconfigured_on_403() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_ANTHROPIC, "forbidden-key").unwrap();
        let provider = AnthropicApi::with_base_url(None, server.uri());
        let result = provider.validate().await;
        assert!(matches!(
            result,
            ValidationResult::Misconfigured { reason } if reason == "API key rejected"
        ));
    }

    #[tokio::test]
    async fn validate_returns_missing_when_no_key() {
        // Delete any existing key for this test.
        let _ = keys::delete(ACCOUNT_ANTHROPIC);
        // Plant None by not setting anything.

        // We need a fresh provider pointed at a server that won't be called.
        let server = MockServer::start().await;
        let provider = AnthropicApi::with_base_url(None, server.uri());
        let result = provider.validate().await;
        assert!(matches!(result, ValidationResult::Missing { .. }));
    }

    #[tokio::test]
    async fn generate_sql_extracts_fenced_block() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "content": [{"type": "text", "text": "Here:\n\n```sql\nSELECT 1;\n```\n"}],
                "stop_reason": "end_turn"
            })))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_ANTHROPIC, "gen-key").unwrap();
        let provider = AnthropicApi::with_base_url(None, server.uri());
        let req = GenerateRequest {
            prompt: "count users".into(),
            context_path: None,
            context_payload: empty_payload(),
            model: None,
        };
        let stream = provider.generate_sql(req).await.unwrap();
        let (texts, finish) = collect_text(stream).await;
        assert_eq!(texts, vec!["SELECT 1;"]);
        assert_eq!(finish, Some("end_turn".to_string()));
    }

    #[tokio::test]
    async fn generate_sql_falls_back_to_raw_when_no_fence() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "content": [{"type": "text", "text": "  SELECT 1;  "}],
                "stop_reason": "end_turn"
            })))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_ANTHROPIC, "gen-key-raw").unwrap();
        let provider = AnthropicApi::with_base_url(None, server.uri());
        let req = GenerateRequest {
            prompt: "count users".into(),
            context_path: None,
            context_payload: empty_payload(),
            model: None,
        };
        let stream = provider.generate_sql(req).await.unwrap();
        let (texts, _) = collect_text(stream).await;
        assert_eq!(texts, vec!["SELECT 1;"]);
    }

    #[tokio::test]
    async fn generate_sql_rejects_unknown_model_before_http() {
        // No server mock — any HTTP call would panic.
        keys::set(ACCOUNT_ANTHROPIC, "key").unwrap();
        let provider = AnthropicApi::with_base_url(None, "http://127.0.0.1:1".into());
        let req = GenerateRequest {
            prompt: "x".into(),
            context_path: None,
            context_payload: empty_payload(),
            model: Some("gpt-9000".into()),
        };
        let result = provider.generate_sql(req).await;
        assert!(matches!(result, Err(AppError::Validation(_))));
    }

    #[tokio::test]
    async fn validate_sends_correct_headers() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .and(header("x-api-key", "my-test-key"))
            .and(header("anthropic-version", "2023-06-01"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "content": [{"type": "text", "text": "ok"}],
                "stop_reason": "end_turn"
            })))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_ANTHROPIC, "my-test-key").unwrap();
        let provider = AnthropicApi::with_base_url(None, server.uri());
        assert!(matches!(provider.validate().await, ValidationResult::Ready));
    }

    // ── chat() tests ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn chat_multi_turn_body_includes_all_turns() {
        let server = MockServer::start().await;

        // Capture the request body to assert message count.
        let request_body = std::sync::Arc::new(std::sync::Mutex::new(
            serde_json::Value::Null,
        ));
        let rb_clone = request_body.clone();

        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "content": [{"type": "text", "text": "SELECT 1;"}],
                "stop_reason": "end_turn"
            })))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_ANTHROPIC, "multi-turn-key").unwrap();
        let turns = vec![
            ChatTurn { role: ChatRole::User, content: "hello".into(), tool_uses: vec![] },
            ChatTurn { role: ChatRole::Assistant, content: "hi".into(), tool_uses: vec![] },
            ChatTurn { role: ChatRole::User, content: "list tables".into(), tool_uses: vec![] },
        ];
        let (provider, req) = make_chat_req(turns, &server.uri());
        let stream = provider.chat(req).await.unwrap();
        let deltas = collect_chat(stream).await;

        let texts: Vec<_> = deltas.iter().filter(|d| matches!(d, ChatDelta::Text(_))).collect();
        let dones: Vec<_> = deltas.iter().filter(|d| matches!(d, ChatDelta::Done { .. })).collect();
        assert!(!texts.is_empty(), "expected Text delta");
        assert_eq!(dones.len(), 1, "expected one Done");
        // No tool events ever.
        assert!(!deltas.iter().any(|d| matches!(d, ChatDelta::ToolCallStarted { .. })));
        assert!(!deltas.iter().any(|d| matches!(d, ChatDelta::ToolCallFinished { .. })));
        let _ = rb_clone; // suppress unused warning
    }

    #[tokio::test]
    async fn chat_success_emits_text_then_done() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "content": [{"type": "text", "text": "```sql\nSELECT 42;\n```"}],
                "stop_reason": "end_turn"
            })))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_ANTHROPIC, "success-key").unwrap();
        let turns = vec![ChatTurn { role: ChatRole::User, content: "select 42".into(), tool_uses: vec![] }];
        let (provider, req) = make_chat_req(turns, &server.uri());
        let deltas = collect_chat(provider.chat(req).await.unwrap()).await;

        assert!(matches!(&deltas[0], ChatDelta::Text(t) if t == "SELECT 42;"));
        assert!(matches!(&deltas[1], ChatDelta::Done { finish_reason: Some(r) } if r == "end_turn"));
    }

    #[tokio::test]
    async fn chat_unsupported_model_rejected_before_http() {
        // No mock server — any HTTP would fail.
        keys::set(ACCOUNT_ANTHROPIC, "key").unwrap();
        let provider = AnthropicApi::with_base_url(None, "http://127.0.0.1:1".into());
        let req = ChatRequest {
            turns: vec![ChatTurn { role: ChatRole::User, content: "x".into(), tool_uses: vec![] }],
            context_path: None,
            context_payload: empty_payload(),
            model: Some("gpt-9000".into()),
            session_id: "s".into(),
            provider_state: Default::default(),
        };
        let result = provider.chat(req).await;
        assert!(matches!(result, Err(AppError::Validation(_))));
    }

    #[tokio::test]
    async fn chat_trimming_emits_status_prefix() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "content": [{"type": "text", "text": "SELECT 1;"}],
                "stop_reason": "end_turn"
            })))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_ANTHROPIC, "trim-key").unwrap();

        // Create 200 turns of 4000 chars each — massively exceeds 80% of 200k token window.
        let long_content = "x".repeat(4000);
        let mut turns: Vec<ChatTurn> = (0..199)
            .map(|i| ChatTurn {
                role: if i % 2 == 0 { ChatRole::User } else { ChatRole::Assistant },
                content: long_content.clone(),
                tool_uses: vec![],
            })
            .collect();
        // Final turn must be User.
        turns.push(ChatTurn { role: ChatRole::User, content: long_content.clone(), tool_uses: vec![] });

        let (provider, req) = make_chat_req(turns, &server.uri());
        let deltas = collect_chat(provider.chat(req).await.unwrap()).await;

        let first = &deltas[0];
        assert!(
            matches!(first, ChatDelta::Status(s) if s.contains("trimmed")),
            "expected trimming Status as first delta, got: {first:?}"
        );
        // Last should be Done.
        assert!(matches!(deltas.last(), Some(ChatDelta::Done { .. })));
    }

    #[test]
    fn trim_turns_to_fit_removes_oldest() {
        use crate::modules::ai::types::{ChatRole, ChatTurn};

        let mut turns: Vec<ChatTurn> = (0..10)
            .map(|i| ChatTurn {
                role: if i % 2 == 0 { ChatRole::User } else { ChatRole::Assistant },
                content: "x".repeat(1000),
                tool_uses: vec![],
            })
            .collect();
        // Last must be User.
        turns.push(ChatTurn { role: ChatRole::User, content: "x".repeat(1000), tool_uses: vec![] });

        let original_last = turns.last().unwrap().content.clone();
        // Set threshold very low to force trimming.
        let count = trim_turns_to_fit(&mut turns, 0, 100);
        assert!(count.is_some(), "expected some trimming");
        assert!(turns.len() >= 1, "must always have at least one turn");
        assert_eq!(turns.last().unwrap().content, original_last, "last turn preserved");
    }
}
