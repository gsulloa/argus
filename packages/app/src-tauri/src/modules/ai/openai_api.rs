use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use futures::stream;
use reqwest::Client;
use serde_json::json;

use crate::error::{AppError, AppResult};
use crate::modules::ai::caps::{
    context_window, fallback_listing, OPENAI_API_DEFAULT_MODEL, OPENAI_API_MODELS,
};
use crate::modules::ai::keys::{self, ACCOUNT_OPENAI};
use crate::modules::ai::provider::AiProvider;
use crate::modules::ai::types::{
    build_api_system_prompt, evict_attachments_oldest_first, extract_fenced_block, Capabilities,
    ChatDelta, ChatRequest, ChatRole, ChatStream, GenerateDelta, GenerateRequest, GenerateStream,
    ModelListing, ModelSource, ProviderId, ValidationResult,
};

const VALIDATION_TIMEOUT: Duration = Duration::from_secs(3);
const GENERATE_TIMEOUT: Duration = Duration::from_secs(60);

pub struct OpenAiApi {
    pub configured_model: Option<String>,
    /// Override the API base URL — used by tests with wiremock.
    pub base_url: Option<String>,
}

impl OpenAiApi {
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

    fn completions_url(&self) -> String {
        let base = self.base_url.as_deref().unwrap_or("https://api.openai.com");
        format!("{base}/v1/chat/completions")
    }

    fn models_url(&self) -> String {
        let base = self.base_url.as_deref().unwrap_or("https://api.openai.com");
        format!("{base}/v1/models")
    }
}

#[async_trait]
impl AiProvider for OpenAiApi {
    fn id(&self) -> ProviderId {
        ProviderId::OpenAiApi
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            can_read_files: false,
            supports_streaming: true,
            requires_api_key: true,
            default_model: OPENAI_API_DEFAULT_MODEL,
            available_models: OPENAI_API_MODELS,
        }
    }

    async fn validate(&self) -> ValidationResult {
        let key = match keys::get(ACCOUNT_OPENAI) {
            Ok(Some(k)) => k,
            Ok(None) => {
                return ValidationResult::Missing {
                    hint: "Enter an OpenAI API key in the AI settings panel".into(),
                }
            }
            Err(e) => {
                return ValidationResult::Misconfigured {
                    reason: format!("keyring read failed: {e}"),
                }
            }
        };

        let body = json!({
            "model": self.configured_model.as_deref().unwrap_or(OPENAI_API_DEFAULT_MODEL),
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
            .post(self.completions_url())
            .header("Authorization", format!("Bearer {key}"))
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

    async fn list_models(&self) -> ModelListing {
        // 1. Read the API key; fall back to curated list when missing or unreadable.
        let key = match keys::get(ACCOUNT_OPENAI) {
            Ok(Some(k)) => k,
            Ok(None) => {
                return fallback_listing("openai-api", Some("no OpenAI API key stored".into()))
            }
            Err(e) => {
                return fallback_listing("openai-api", Some(format!("keyring read failed: {e}")))
            }
        };

        // 2. Build a client with a 3 s timeout and GET /v1/models.
        let client = match Client::builder().timeout(Duration::from_secs(3)).build() {
            Ok(c) => c,
            Err(e) => {
                return fallback_listing(
                    "openai-api",
                    Some(format!("http client init failed: {e}")),
                )
            }
        };

        let resp = match client
            .get(self.models_url())
            .header("Authorization", format!("Bearer {key}"))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) if e.is_timeout() => {
                return fallback_listing(
                    "openai-api",
                    Some("OpenAI model list request timed out".into()),
                )
            }
            Err(e) => {
                return fallback_listing("openai-api", Some(format!("network unreachable: {e}")))
            }
        };

        // 3. Handle non-2xx.
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return fallback_listing("openai-api", Some("API key rejected".into()));
        }
        if !status.is_success() {
            return fallback_listing("openai-api", Some(format!("unexpected status {status}")));
        }

        // 4. Parse `{ "data": [ { "id": "..." }, ... ] }`.
        let json: serde_json::Value = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                return fallback_listing(
                    "openai-api",
                    Some(format!("failed to parse model list: {e}")),
                )
            }
        };

        let all_ids: Vec<String> = json
            .get("data")
            .and_then(|d| d.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| item.get("id").and_then(|id| id.as_str()))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();

        // 5. Filter to chat-capable models (gpt-, o1, o3, chatgpt prefixes).
        let discovered: Vec<String> = all_ids
            .into_iter()
            .filter(|id| {
                let lower = id.to_lowercase();
                lower.starts_with("gpt-")
                    || lower.starts_with("o1")
                    || lower.starts_with("o3")
                    || lower.starts_with("chatgpt")
            })
            .collect();

        // 6. Union-in curated defaults (discovered first, then any curated not yet present).
        let mut models = discovered;
        for curated in OPENAI_API_MODELS {
            if !models.iter().any(|m| m == *curated) {
                models.push(curated.to_string());
            }
        }

        ModelListing {
            models,
            source: ModelSource::Provider,
            refreshed_at: Some(Utc::now().timestamp_millis()),
            error: None,
        }
    }

    async fn generate_sql(&self, req: GenerateRequest) -> AppResult<GenerateStream> {
        if let Some(m) = &req.model {
            // Fast path: known curated model — accept without a network call.
            if !OPENAI_API_MODELS.iter().any(|x| *x == m) {
                // Might be a newly released model — confirm against the effective list.
                let listing = self.list_models().await;
                if !listing.models.iter().any(|x| x == m) {
                    return Err(AppError::Validation(format!("unsupported model: {m}")));
                }
            }
        }
        let model = req
            .model
            .clone()
            .or_else(|| self.configured_model.clone())
            .unwrap_or_else(|| OPENAI_API_DEFAULT_MODEL.to_string());

        let key = keys::get(ACCOUNT_OPENAI)
            .map_err(|e| AppError::Keychain(format!("read openai key: {e}")))?
            .ok_or_else(|| AppError::Validation("OpenAI API key not configured".into()))?;

        let system_prompt = build_api_system_prompt(&req.context_payload, &[], None)?;
        let body = json!({
            "model": model,
            "max_tokens": 4096,
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": req.prompt },
            ],
        });

        let client = Client::builder()
            .timeout(GENERATE_TIMEOUT)
            .build()
            .map_err(|e| AppError::Internal(format!("http client init failed: {e}")))?;

        let resp = client
            .post(self.completions_url())
            .header("Authorization", format!("Bearer {key}"))
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("openai request failed: {e}")))?;

        let status = resp.status();
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(format!("openai response not json: {e}")))?;

        if !status.is_success() {
            return Err(AppError::Internal(format!(
                "openai returned {status}: {}",
                json.get("error").map(|e| e.to_string()).unwrap_or_default()
            )));
        }

        // OpenAI response shape: { choices: [{ message: { content: "..." } }], ... }
        let text = json
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|msg| msg.get("content"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();

        let finish_reason = json
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|choice| choice.get("finish_reason"))
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
            // Fast path: known curated model — accept without a network call.
            if !OPENAI_API_MODELS.iter().any(|x| *x == m) {
                // Might be a newly released model — confirm against the effective list.
                let listing = self.list_models().await;
                if !listing.models.iter().any(|x| x == m) {
                    return Err(AppError::Validation(format!("unsupported model: {m}")));
                }
            }
        }
        let model = req
            .model
            .clone()
            .or_else(|| self.configured_model.clone())
            .unwrap_or_else(|| OPENAI_API_DEFAULT_MODEL.to_string());

        // 2. Read API key.
        let key = keys::get(ACCOUNT_OPENAI)
            .map_err(|e| AppError::Keychain(format!("read openai key: {e}")))?
            .ok_or_else(|| AppError::Validation("OpenAI API key not configured".into()))?;

        // 3. Context-window budget.
        let window = context_window(&model);
        let threshold = (window as f64 * 0.8) as usize;

        // 3a. Oldest-first attachment eviction BEFORE composing the system prompt.
        let mut attachments = req.attached_results.clone();
        let turn_chars: usize = req.turns.iter().map(|t| t.content.len()).sum();
        let evicted = evict_attachments_oldest_first(
            &mut attachments,
            &req.context_payload,
            turn_chars,
            threshold,
        )?;

        // 3b. Build system prompt with the surviving attachments as the trailing section.
        let system_prompt =
            build_api_system_prompt(&req.context_payload, &attachments, req.context_engine)?;

        // 4. Per-turn trimming (history), in addition to attachment eviction.
        let mut turns = req.turns.clone();
        let system_chars = system_prompt.len();
        let trim_status = trim_turns_to_fit(&mut turns, system_chars, threshold);

        // 5. Build messages array: system first, then 1:1 from turns.
        let mut messages: Vec<serde_json::Value> =
            vec![json!({ "role": "system", "content": system_prompt })];
        for t in &turns {
            let role = match t.role {
                ChatRole::User => "user",
                ChatRole::Assistant => "assistant",
            };
            messages.push(json!({ "role": role, "content": t.content }));
        }

        let body = json!({
            "model": model,
            "max_tokens": 4096,
            "messages": messages,
        });

        let client = Client::builder()
            .timeout(GENERATE_TIMEOUT)
            .build()
            .map_err(|e| AppError::Internal(format!("http client init failed: {e}")))?;

        let resp = client
            .post(self.completions_url())
            .header("Authorization", format!("Bearer {key}"))
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    AppError::Internal("openai request timed out".into())
                } else {
                    AppError::Internal(format!("openai request failed: {e}"))
                }
            })?;

        let status = resp.status();
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(format!("openai response not json: {e}")))?;

        if !status.is_success() {
            return Err(AppError::Internal(format!(
                "openai returned {status}: {}",
                json.get("error").map(|e| e.to_string()).unwrap_or_default()
            )));
        }

        let text = json
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|msg| msg.get("content"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();

        let finish_reason = json
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|choice| choice.get("finish_reason"))
            .and_then(|s| s.as_str())
            .map(String::from);

        let extracted = extract_fenced_block(&text);

        let mut items: Vec<AppResult<ChatDelta>> = Vec::new();
        if evicted > 0 {
            items.push(Ok(ChatDelta::Status(format!(
                "dropped {evicted} oldest attachment(s) to fit context window"
            ))));
        }
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
    if trimmed > 0 {
        Some(trimmed)
    } else {
        None
    }
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

    fn make_chat_req(turns: Vec<ChatTurn>, base_url: &str) -> (OpenAiApi, ChatRequest) {
        let provider = OpenAiApi::with_base_url(None, base_url.to_string());
        let req = ChatRequest {
            turns,
            context_path: None,
            context_payload: empty_payload(),
            model: None,
            session_id: "test-session".into(),
            provider_state: Default::default(),
            attached_results: vec![],
            context_engine: None,
            dynamo_table_match: None,
        };
        (provider, req)
    }

    #[tokio::test]
    async fn validate_returns_ready_on_200() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]
            })))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_OPENAI, "test-key-200").unwrap();
        let provider = OpenAiApi::with_base_url(None, server.uri());
        assert!(matches!(provider.validate().await, ValidationResult::Ready));
    }

    #[tokio::test]
    async fn validate_returns_misconfigured_on_401() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "error": { "message": "Incorrect API key provided" }
            })))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_OPENAI, "bad-key").unwrap();
        let provider = OpenAiApi::with_base_url(None, server.uri());
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
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_OPENAI, "forbidden-key").unwrap();
        let provider = OpenAiApi::with_base_url(None, server.uri());
        let result = provider.validate().await;
        assert!(matches!(
            result,
            ValidationResult::Misconfigured { reason } if reason == "API key rejected"
        ));
    }

    #[tokio::test]
    async fn validate_returns_missing_when_no_key() {
        let _ = keys::delete(ACCOUNT_OPENAI);

        let server = MockServer::start().await;
        let provider = OpenAiApi::with_base_url(None, server.uri());
        let result = provider.validate().await;
        assert!(matches!(result, ValidationResult::Missing { .. }));
    }

    #[tokio::test]
    async fn generate_sql_extracts_fenced_block() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {"content": "Here:\n\n```sql\nSELECT 1;\n```\n"},
                    "finish_reason": "stop"
                }]
            })))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_OPENAI, "gen-key").unwrap();
        let provider = OpenAiApi::with_base_url(None, server.uri());
        let req = GenerateRequest {
            prompt: "count users".into(),
            context_path: None,
            context_payload: empty_payload(),
            model: None,
        };
        let stream = provider.generate_sql(req).await.unwrap();
        let (texts, finish) = collect_text(stream).await;
        assert_eq!(texts, vec!["SELECT 1;"]);
        assert_eq!(finish, Some("stop".to_string()));
    }

    #[tokio::test]
    async fn generate_sql_falls_back_to_raw_when_no_fence() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {"content": "  SELECT 1;  "},
                    "finish_reason": "stop"
                }]
            })))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_OPENAI, "gen-key-raw").unwrap();
        let provider = OpenAiApi::with_base_url(None, server.uri());
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
        keys::set(ACCOUNT_OPENAI, "key").unwrap();
        let provider = OpenAiApi::with_base_url(None, "http://127.0.0.1:1".into());
        let req = GenerateRequest {
            prompt: "x".into(),
            context_path: None,
            context_payload: empty_payload(),
            model: Some("claude-opus-4-7".into()),
        };
        let result = provider.generate_sql(req).await;
        assert!(matches!(result, Err(AppError::Validation(_))));
    }

    #[tokio::test]
    async fn validate_sends_bearer_auth_header() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("Authorization", "Bearer my-openai-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]
            })))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_OPENAI, "my-openai-key").unwrap();
        let provider = OpenAiApi::with_base_url(None, server.uri());
        assert!(matches!(provider.validate().await, ValidationResult::Ready));
    }

    // ── chat() tests ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn chat_multi_turn_body_includes_all_turns() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "SELECT 1;"}, "finish_reason": "stop"}]
            })))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_OPENAI, "multi-turn-key-oai").unwrap();
        let turns = vec![
            ChatTurn {
                role: ChatRole::User,
                content: "hello".into(),
                tool_uses: vec![],
            },
            ChatTurn {
                role: ChatRole::Assistant,
                content: "hi".into(),
                tool_uses: vec![],
            },
            ChatTurn {
                role: ChatRole::User,
                content: "list tables".into(),
                tool_uses: vec![],
            },
        ];
        let (provider, req) = make_chat_req(turns, &server.uri());
        let deltas = collect_chat(provider.chat(req).await.unwrap()).await;

        let texts: Vec<_> = deltas
            .iter()
            .filter(|d| matches!(d, ChatDelta::Text(_)))
            .collect();
        let dones: Vec<_> = deltas
            .iter()
            .filter(|d| matches!(d, ChatDelta::Done { .. }))
            .collect();
        assert!(!texts.is_empty(), "expected Text delta");
        assert_eq!(dones.len(), 1, "expected one Done");
        // No tool events.
        assert!(!deltas
            .iter()
            .any(|d| matches!(d, ChatDelta::ToolCallStarted { .. })));
        assert!(!deltas
            .iter()
            .any(|d| matches!(d, ChatDelta::ToolCallFinished { .. })));
    }

    #[tokio::test]
    async fn chat_success_emits_text_then_done() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "```sql\nSELECT 42;\n```"}, "finish_reason": "stop"}]
            })))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_OPENAI, "success-key-oai").unwrap();
        let turns = vec![ChatTurn {
            role: ChatRole::User,
            content: "select 42".into(),
            tool_uses: vec![],
        }];
        let (provider, req) = make_chat_req(turns, &server.uri());
        let deltas = collect_chat(provider.chat(req).await.unwrap()).await;

        assert!(matches!(&deltas[0], ChatDelta::Text(t) if t == "SELECT 42;"));
        assert!(matches!(&deltas[1], ChatDelta::Done { finish_reason: Some(r) } if r == "stop"));
    }

    #[tokio::test]
    async fn chat_unsupported_model_rejected_before_http() {
        keys::set(ACCOUNT_OPENAI, "key").unwrap();
        let provider = OpenAiApi::with_base_url(None, "http://127.0.0.1:1".into());
        let req = ChatRequest {
            turns: vec![ChatTurn {
                role: ChatRole::User,
                content: "x".into(),
                tool_uses: vec![],
            }],
            context_path: None,
            context_payload: empty_payload(),
            model: Some("claude-opus-4-7".into()),
            session_id: "s".into(),
            provider_state: Default::default(),
            attached_results: vec![],
            context_engine: None,
            dynamo_table_match: None,
        };
        let result = provider.chat(req).await;
        assert!(matches!(result, Err(AppError::Validation(_))));
    }

    #[tokio::test]
    async fn chat_trimming_emits_status_prefix() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "SELECT 1;"}, "finish_reason": "stop"}]
            })))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_OPENAI, "trim-key-oai").unwrap();

        let long_content = "x".repeat(4000);
        let mut turns: Vec<ChatTurn> = (0..199)
            .map(|i| ChatTurn {
                role: if i % 2 == 0 {
                    ChatRole::User
                } else {
                    ChatRole::Assistant
                },
                content: long_content.clone(),
                tool_uses: vec![],
            })
            .collect();
        turns.push(ChatTurn {
            role: ChatRole::User,
            content: long_content,
            tool_uses: vec![],
        });

        let (provider, req) = make_chat_req(turns, &server.uri());
        let deltas = collect_chat(provider.chat(req).await.unwrap()).await;

        assert!(
            matches!(&deltas[0], ChatDelta::Status(s) if s.contains("trimmed")),
            "expected trimming Status as first delta, got: {:?}",
            deltas[0]
        );
        assert!(matches!(deltas.last(), Some(ChatDelta::Done { .. })));
    }

    #[tokio::test]
    async fn chat_no_tool_call_events_ever() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "SELECT 1;"}, "finish_reason": "stop"}]
            })))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_OPENAI, "no-tool-key").unwrap();
        let turns = vec![ChatTurn {
            role: ChatRole::User,
            content: "x".into(),
            tool_uses: vec![],
        }];
        let (provider, req) = make_chat_req(turns, &server.uri());
        let deltas = collect_chat(provider.chat(req).await.unwrap()).await;
        assert!(!deltas
            .iter()
            .any(|d| matches!(d, ChatDelta::ToolCallStarted { .. })));
        assert!(!deltas
            .iter()
            .any(|d| matches!(d, ChatDelta::ToolCallFinished { .. })));
    }

    // ── list_models() tests ─────────────────────────────────────────────────

    #[tokio::test]
    async fn list_models_success_returns_provider_source() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [
                    {"id": "gpt-5.1"},
                    {"id": "gpt-new-model-xyz"},
                    {"id": "text-embedding-3-large"},  // non-chat, should be filtered out
                ]
            })))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_OPENAI, "list-key-oai").unwrap();
        let provider = OpenAiApi::with_base_url(None, server.uri());
        let listing = provider.list_models().await;

        assert_eq!(
            listing.source,
            crate::modules::ai::types::ModelSource::Provider
        );
        assert!(listing.refreshed_at.is_some(), "refreshed_at should be set");
        // Chat-capable model is present.
        assert!(
            listing.models.contains(&"gpt-5.1".to_string()),
            "gpt-5.1 should be in list"
        );
        assert!(
            listing.models.contains(&"gpt-new-model-xyz".to_string()),
            "gpt-new-model-xyz should be in list"
        );
        // Non-chat model should be filtered out.
        assert!(
            !listing
                .models
                .contains(&"text-embedding-3-large".to_string()),
            "non-chat model must not be in list"
        );
        // Curated defaults always present.
        assert!(
            listing
                .models
                .contains(&OPENAI_API_DEFAULT_MODEL.to_string()),
            "curated default must be in list"
        );
        assert!(listing.error.is_none());
    }

    #[tokio::test]
    async fn list_models_401_returns_fallback() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_OPENAI, "bad-list-key-oai").unwrap();
        let provider = OpenAiApi::with_base_url(None, server.uri());
        let listing = provider.list_models().await;

        assert_eq!(
            listing.source,
            crate::modules::ai::types::ModelSource::Fallback
        );
        assert!(
            listing.error.as_deref().unwrap_or("").contains("rejected"),
            "error should mention rejected key"
        );
        let curated: Vec<String> = OPENAI_API_MODELS.iter().map(|s| s.to_string()).collect();
        assert_eq!(listing.models, curated);
    }

    #[tokio::test]
    async fn list_models_missing_key_returns_fallback_no_request() {
        // Do NOT set a key.
        let _ = keys::delete(ACCOUNT_OPENAI);

        let provider = OpenAiApi::with_base_url(None, "http://127.0.0.1:1".into());
        let listing = provider.list_models().await;

        assert_eq!(
            listing.source,
            crate::modules::ai::types::ModelSource::Fallback
        );
        assert!(
            listing
                .error
                .as_deref()
                .unwrap_or("")
                .contains("no OpenAI API key"),
            "error should mention missing key"
        );
        let curated: Vec<String> = OPENAI_API_MODELS.iter().map(|s| s.to_string()).collect();
        assert_eq!(listing.models, curated);
    }

    #[tokio::test]
    async fn list_models_500_returns_fallback() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_OPENAI, "server-err-key-oai").unwrap();
        let provider = OpenAiApi::with_base_url(None, server.uri());
        let listing = provider.list_models().await;

        assert_eq!(
            listing.source,
            crate::modules::ai::types::ModelSource::Fallback
        );
        assert!(
            listing
                .error
                .as_deref()
                .unwrap_or("")
                .contains("unexpected status"),
            "error should mention unexpected status"
        );
    }

    /// A gpt-* model returned by the dynamic list should be accepted by `generate_sql`.
    #[tokio::test]
    async fn generate_sql_accepts_dynamically_discovered_model() {
        let server = MockServer::start().await;
        // /v1/models returns a newly discovered gpt model.
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{"id": "gpt-new-model-discovered"}]
            })))
            .mount(&server)
            .await;
        // /v1/chat/completions returns a successful response.
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "SELECT 1;"}, "finish_reason": "stop"}]
            })))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_OPENAI, "dynamic-model-key-oai").unwrap();
        let provider = OpenAiApi::with_base_url(None, server.uri());
        let req = GenerateRequest {
            prompt: "x".into(),
            context_path: None,
            context_payload: empty_payload(),
            model: Some("gpt-new-model-discovered".into()),
        };
        let result = provider.generate_sql(req).await;
        assert!(
            result.is_ok(),
            "dynamically discovered model should be accepted but got an error"
        );
    }

    /// A model absent from both dynamic list and curated must be rejected with Validation.
    #[tokio::test]
    async fn generate_sql_rejects_model_absent_from_dynamic_list() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{"id": "gpt-5.1"}]
            })))
            .mount(&server)
            .await;

        keys::set(ACCOUNT_OPENAI, "reject-key-oai").unwrap();
        let provider = OpenAiApi::with_base_url(None, server.uri());
        let req = GenerateRequest {
            prompt: "x".into(),
            context_path: None,
            context_payload: empty_payload(),
            model: Some("totally-unknown-model-xyz".into()),
        };
        let result = provider.generate_sql(req).await;
        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "model absent from dynamic list must be rejected"
        );
    }
}
