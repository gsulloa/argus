use std::sync::Arc;
use std::time::Duration;

use futures::future::join_all;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::ai::caps;
use crate::modules::ai::chat_session::ChatSessionRegistry;
use crate::modules::ai::factory;
use crate::modules::ai::keys::{self, ACCOUNT_ANTHROPIC, ACCOUNT_OPENAI};
use crate::modules::ai::settings::{
    AiSettings, ConnectionOverrideRow,
    AiSettingsInput as RawAiSettingsInput,
};
use crate::modules::ai::types::{
    AiConnectionOverrideView, AiSettingsView, AttachedResult, ChatDelta, ChatRequest, ChatStream,
    ChatTurn, GenerateDelta, InspectDelta, InspectRequest, KeyPresence, ProviderId,
    ProviderListEntry, ToolUseRecord, ValidationResult,
};
use crate::modules::dynamo::client::DynamoClientRegistry;
use crate::modules::ai::validation_cache::ValidationCache;
use crate::modules::context::registry::ContextRegistry;
use crate::modules::context::types::AiPayload;
use crate::platform::DbState;

const SETTINGS_CHANGED_EVENT: &str = "ai-settings-changed";
const VALIDATE_TIMEOUT: Duration = Duration::from_secs(3);

// ---- 5.1: ai_list_providers ----

#[tauri::command]
pub async fn ai_list_providers(
    db: State<'_, DbState>,
    cache: State<'_, ValidationCache>,
) -> AppResult<Vec<ProviderListEntry>> {
    // Build all four providers (sync, cheap).
    let providers: Vec<(ProviderId, Box<dyn crate::modules::ai::provider::AiProvider>)> =
        ProviderId::ALL
            .iter()
            .map(|id| factory::build(&db, *id).map(|p| (*id, p)))
            .collect::<AppResult<Vec<_>>>()?;

    // For each provider: check cache, else probe (with 3 s timeout), else fall back to Misconfigured.
    let futures = providers.into_iter().map(|(id, provider)| {
        let cache_ref = &cache;
        async move {
            let validation = if let Some(cached) = cache_ref.peek(id) {
                cached
            } else {
                let result = match tokio::time::timeout(VALIDATE_TIMEOUT, provider.validate()).await
                {
                    Ok(v) => v,
                    Err(_) => ValidationResult::Misconfigured {
                        reason: format!("{} validation timed out", id.as_kebab()),
                    },
                };
                cache_ref.insert(id, result.clone());
                result
            };
            ProviderListEntry {
                id,
                capabilities: provider.capabilities(),
                validation,
            }
        }
    });

    Ok(join_all(futures).await)
}

// ---- 5.2: ai_validate_provider ----

#[tauri::command]
pub async fn ai_validate_provider(
    id: ProviderId,
    db: State<'_, DbState>,
    cache: State<'_, ValidationCache>,
) -> AppResult<ValidationResult> {
    cache.invalidate(id);
    let provider = factory::build(&db, id)?;
    let result = match tokio::time::timeout(VALIDATE_TIMEOUT, provider.validate()).await {
        Ok(v) => v,
        Err(_) => ValidationResult::Misconfigured {
            reason: format!("{} validation timed out", id.as_kebab()),
        },
    };
    cache.insert(id, result.clone());
    Ok(result)
}

// ---- 5.3: ai_get_settings ----

#[tauri::command]
pub fn ai_get_settings(db: State<'_, DbState>) -> AppResult<AiSettingsView> {
    let (row, overrides) = AiSettings::get(&db)?;
    let default_provider = row.default_provider.as_deref().and_then(ProviderId::from_kebab);
    let overrides_view = overrides
        .into_iter()
        .filter_map(|o| {
            ProviderId::from_kebab(&o.provider_id).map(|pid| AiConnectionOverrideView {
                connection_id: o.connection_id,
                provider_id: pid,
                model: o.model,
            })
        })
        .collect();
    let key_present = KeyPresence {
        anthropic: keys::get(ACCOUNT_ANTHROPIC).ok().flatten().is_some(),
        openai: keys::get(ACCOUNT_OPENAI).ok().flatten().is_some(),
    };
    Ok(AiSettingsView {
        default_provider,
        claude_cli_model: row.claude_cli_model,
        codex_cli_model: row.codex_cli_model,
        anthropic_api_model: row.anthropic_api_model,
        openai_api_model: row.openai_api_model,
        overrides: overrides_view,
        key_present,
    })
}

// ---- 5.4: ai_set_settings ----

#[derive(serde::Deserialize)]
pub struct AiSettingsCommandInput {
    pub default_provider: Option<ProviderId>,
    pub claude_cli_model: Option<String>,
    pub codex_cli_model: Option<String>,
    pub anthropic_api_model: Option<String>,
    pub openai_api_model: Option<String>,
    pub overrides: Vec<AiConnectionOverrideViewInput>,
}

#[derive(serde::Deserialize)]
pub struct AiConnectionOverrideViewInput {
    pub connection_id: String,
    pub provider_id: ProviderId,
    pub model: Option<String>,
}

#[tauri::command]
pub fn ai_set_settings(
    input: AiSettingsCommandInput,
    db: State<'_, DbState>,
    cache: State<'_, ValidationCache>,
    app: AppHandle,
) -> AppResult<()> {
    fn validate_model(val: &Option<String>, list: &[&str]) -> AppResult<()> {
        if let Some(m) = val {
            if !list.iter().any(|x| *x == m) {
                return Err(AppError::Validation(format!("unsupported model: {m}")));
            }
        }
        Ok(())
    }
    validate_model(&input.claude_cli_model, caps::CLAUDE_CLI_MODELS)?;
    validate_model(&input.codex_cli_model, caps::CODEX_CLI_MODELS)?;
    validate_model(&input.anthropic_api_model, caps::ANTHROPIC_API_MODELS)?;
    validate_model(&input.openai_api_model, caps::OPENAI_API_MODELS)?;

    let raw = RawAiSettingsInput {
        default_provider: input.default_provider.map(|p| p.as_kebab().to_string()),
        claude_cli_model: input.claude_cli_model,
        codex_cli_model: input.codex_cli_model,
        anthropic_api_model: input.anthropic_api_model,
        openai_api_model: input.openai_api_model,
        overrides: input
            .overrides
            .into_iter()
            .map(|o| ConnectionOverrideRow {
                connection_id: o.connection_id,
                provider_id: o.provider_id.as_kebab().to_string(),
                model: o.model,
            })
            .collect(),
    };
    AiSettings::set(&db, &raw)?;
    cache.invalidate_all();
    let _ = app.emit(SETTINGS_CHANGED_EVENT, ());
    Ok(())
}

// ---- 5.5: ai_set_api_key ----

#[tauri::command]
pub fn ai_set_api_key(
    provider: ProviderId,
    key: String,
    cache: State<'_, ValidationCache>,
    app: AppHandle,
) -> AppResult<()> {
    let account = match provider {
        ProviderId::AnthropicApi => ACCOUNT_ANTHROPIC,
        ProviderId::OpenAiApi => ACCOUNT_OPENAI,
        ProviderId::ClaudeCli | ProviderId::CodexCli => {
            return Err(AppError::Validation(format!(
                "{} does not accept an API key (CLI provider)",
                provider.as_kebab()
            )))
        }
    };
    keys::set(account, &key)?;
    cache.invalidate(provider);
    let _ = app.emit(SETTINGS_CHANGED_EVENT, ());
    Ok(())
}

// ---- 5.6: ai_delete_api_key ----

#[tauri::command]
pub fn ai_delete_api_key(
    provider: ProviderId,
    cache: State<'_, ValidationCache>,
    app: AppHandle,
) -> AppResult<()> {
    let account = match provider {
        ProviderId::AnthropicApi => ACCOUNT_ANTHROPIC,
        ProviderId::OpenAiApi => ACCOUNT_OPENAI,
        ProviderId::ClaudeCli | ProviderId::CodexCli => {
            return Err(AppError::Validation(format!(
                "{} does not accept an API key (CLI provider)",
                provider.as_kebab()
            )))
        }
    };
    keys::delete(account)?;
    cache.invalidate(provider);
    let _ = app.emit(SETTINGS_CHANGED_EVENT, ());
    Ok(())
}

// ---- 5.7: ai_generate_sql ----
// TODO: deprecate after add-ai-chat-panel UI ships and confirms no remaining callers.

#[tauri::command]
pub async fn ai_generate_sql(
    prompt: String,
    context_path: Option<String>,
    payload: AiPayload,
    connection_id: Option<String>,
    model: Option<String>,
    db: State<'_, DbState>,
) -> AppResult<String> {
    let conn_uuid = match connection_id {
        Some(s) => Some(
            Uuid::parse_str(&s)
                .map_err(|e| AppError::Validation(format!("invalid connection id: {e}")))?,
        ),
        None => None,
    };
    let resolved = AiSettings::resolve(&db, conn_uuid)?;
    let provider_id = ProviderId::from_kebab(&resolved.provider_id).ok_or_else(|| {
        AppError::Internal(format!(
            "unknown provider in settings: {}",
            resolved.provider_id
        ))
    })?;
    let provider = factory::build(&db, provider_id)?;

    let req = crate::modules::ai::types::GenerateRequest {
        prompt,
        context_path: context_path.map(std::path::PathBuf::from),
        context_payload: payload,
        model,
    };
    let stream = provider.generate_sql(req).await?;
    collect_stream(stream).await
}

pub async fn collect_stream(
    stream: crate::modules::ai::types::GenerateStream,
) -> AppResult<String> {
    use futures::StreamExt;
    futures::pin_mut!(stream);
    let mut out = String::new();
    while let Some(item) = stream.next().await {
        match item? {
            GenerateDelta::Text(t) => {
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(&t);
            }
            GenerateDelta::Done { .. } => break,
        }
    }
    Ok(out)
}

// ---- 6.x: ai_chat_* commands ----

/// Build a context payload for the given connection using the ContextRegistry.
/// Falls back to an empty payload if no context folder is linked or registry
/// has no entry for this connection.
fn build_context_payload(
    _db: &State<'_, DbState>,
    registry: &Arc<ContextRegistry>,
    conn_id: Option<Uuid>,
) -> AppResult<AiPayload> {
    use crate::modules::context::ai::{build_empty_payload, build_payload};

    let Some(id) = conn_id else {
        return Ok(build_empty_payload());
    };

    match registry.get(id) {
        Ok(Some(parsed)) => Ok(build_payload(&parsed, false)),
        _ => Ok(build_empty_payload()),
    }
}

/// Drive a `ChatStream` to completion, emitting `ChatDelta` events on `channel`.
/// Intercepts provider sentinels (`__resume_id__:…`, `__codex_warning_shown__`)
/// and writes them into session provider_state — they are never forwarded to the
/// frontend.
async fn drive_stream(
    mut stream: ChatStream,
    channel: &str,
    session_id: &str,
    app: &AppHandle,
    registry: &ChatSessionRegistry,
) {
    use futures::StreamExt;

    let mut accumulated_text = String::new();
    let mut tool_uses: Vec<ToolUseRecord> = Vec::new();
    // (id, name, input) accumulator for in-progress tool call.
    let mut current_tool: Option<(String, String, serde_json::Value)> = None;
    let mut errored = false;

    while let Some(item) = stream.next().await {
        match item {
            Ok(delta) => {
                // Intercept internal sentinels before forwarding.
                if let ChatDelta::Status(ref s) = delta {
                    if let Some(resume_id) = s.strip_prefix("__resume_id__:") {
                        let _ = registry.set_provider_state(session_id, "resume_id", resume_id.to_string());
                        continue;
                    }
                    if s == "__codex_warning_shown__" {
                        let _ = registry.set_provider_state(session_id, "codex_warning_shown", "1".to_string());
                        continue;
                    }
                }

                // Accumulate for persistence.
                match &delta {
                    ChatDelta::Text(t) => accumulated_text.push_str(t),
                    ChatDelta::ToolCallStarted { id, name, input } => {
                        current_tool = Some((id.clone(), name.clone(), input.clone()));
                    }
                    ChatDelta::ToolCallFinished { id, output, is_error } => {
                        if let Some((tid, tname, tinput)) = current_tool.take() {
                            if tid == *id {
                                tool_uses.push(ToolUseRecord {
                                    id: tid,
                                    name: tname,
                                    input: tinput,
                                    output: Some(output.clone()),
                                    is_error: *is_error,
                                });
                            }
                        }
                    }
                    ChatDelta::Error(_) => errored = true,
                    _ => {}
                }

                let _ = app.emit(channel, delta);
            }
            Err(e) => {
                let _ = app.emit(channel, ChatDelta::Error(format!("{e:?}")));
                errored = true;
                break;
            }
        }
    }

    // Persist the assistant turn if the stream completed cleanly.
    if !errored {
        let _ = registry.append_assistant(session_id, accumulated_text, tool_uses);
    }
    // Guarantee the frontend always receives a Done event on error paths.
    if errored {
        let _ = app.emit(channel, ChatDelta::Done { finish_reason: None });
    }
}

// ---- 6.1: ai_chat_send ----

#[tauri::command]
pub async fn ai_chat_send(
    session_id: String,
    prompt: String,
    connection_id: Option<String>,
    attached_results: Vec<AttachedResult>,
    db: State<'_, DbState>,
    registry: State<'_, ChatSessionRegistry>,
    app: AppHandle,
) -> AppResult<()> {
    // Parse optional connection id.
    let conn_uuid = match connection_id.as_deref() {
        Some(s) => Some(
            Uuid::parse_str(s)
                .map_err(|e| AppError::Validation(format!("invalid connection id: {e}")))?,
        ),
        None => None,
    };

    // Resolve provider via AiSettings (honours per-connection overrides).
    let resolved = AiSettings::resolve(&db, conn_uuid)?;
    let provider_id = ProviderId::from_kebab(&resolved.provider_id).ok_or_else(|| {
        AppError::Internal(format!(
            "unknown provider in settings: {}",
            resolved.provider_id
        ))
    })?;

    // Fetch context_path and engine kind from the connection row (if linked).
    let (context_path, context_engine) = if let Some(id) = conn_uuid {
        match crate::modules::context::commands::get_conn_kind_and_path(&db, id) {
            Ok((kind, path)) => {
                let engine = crate::modules::context::engine::EngineKind::from_connection_kind(&kind);
                let path_buf = path.map(std::path::PathBuf::from);
                (path_buf, engine)
            }
            Err(_) => (None, None),
        }
    } else {
        (None, None)
    };

    // Load the Dynamo table-match rule for Dynamo connections (None for all others).
    let dynamo_table_match = if let (Some(id), Some(crate::modules::context::engine::EngineKind::Dynamo)) = (conn_uuid, context_engine) {
        crate::modules::context::commands::load_table_match(&db, id)
            .unwrap_or(None)
    } else {
        None
    };

    // Open or get session — existing sessions keep their bound provider.
    registry.open_or_get(&session_id, provider_id, conn_uuid, context_path.clone())?;

    // Append the user turn.
    registry.append_user(&session_id, prompt)?;

    // Snapshot turns and provider_state for the request.
    let turns = registry.snapshot_turns(&session_id)?;
    let provider_state = {
        // Build a HashMap from the individual keys we care about.
        let mut map = std::collections::HashMap::new();
        if let Ok(Some(v)) = registry.get_provider_state(&session_id, "resume_id") {
            map.insert("resume_id".to_string(), v);
        }
        if let Ok(Some(v)) = registry.get_provider_state(&session_id, "codex_warning_shown") {
            map.insert("codex_warning_shown".to_string(), v);
        }
        map
    };

    // Build context payload from the ContextRegistry.
    let context_registry = app.state::<Arc<ContextRegistry>>();
    let context_payload = build_context_payload(&db, &context_registry, conn_uuid)?;

    let req = ChatRequest {
        turns,
        context_path,
        context_payload,
        model: None,
        session_id: session_id.clone(),
        provider_state,
        attached_results,
        context_engine,
        dynamo_table_match,
    };

    let provider = factory::build(&db, provider_id)?;
    let channel = format!("ai-chat-delta:{session_id}");
    let session_id_clone = session_id.clone();
    let app_clone = app.clone();

    // Spawn the streaming task. The registry is accessed via app.state() inside
    // the task to avoid moving the short-lived State reference into an async block.
    let handle = tokio::spawn(async move {
        let registry = app_clone.state::<ChatSessionRegistry>();
        match provider.chat(req).await {
            Ok(stream) => {
                drive_stream(stream, &channel, &session_id_clone, &app_clone, &registry).await;
            }
            Err(e) => {
                let _ = app_clone.emit(&channel, ChatDelta::Error(format!("{e:?}")));
                let _ = app_clone.emit(&channel, ChatDelta::Done { finish_reason: None });
            }
        }
    });

    registry.set_in_flight(&session_id, Some(handle))?;
    Ok(())
}

// ---- 6.2: ai_chat_cancel ----

#[tauri::command]
pub fn ai_chat_cancel(
    session_id: String,
    registry: State<'_, ChatSessionRegistry>,
    app: AppHandle,
) -> AppResult<()> {
    registry.abort(&session_id)?;
    let channel = format!("ai-chat-delta:{session_id}");
    let _ = app.emit(&channel, ChatDelta::Error("cancelled".into()));
    let _ = app.emit(&channel, ChatDelta::Done { finish_reason: Some("cancelled".into()) });
    Ok(())
}

// ---- 6.3: ai_chat_close ----

#[tauri::command]
pub fn ai_chat_close(
    session_id: String,
    registry: State<'_, ChatSessionRegistry>,
) -> AppResult<()> {
    registry.close(&session_id)?;
    Ok(())
}

// ---- 6.4: ai_chat_history ----

#[tauri::command]
pub fn ai_chat_history(
    session_id: String,
    registry: State<'_, ChatSessionRegistry>,
) -> AppResult<Vec<ChatTurn>> {
    registry.snapshot_turns(&session_id)
}

// ---- 7.x: ai_inspect_models ----

/// Drive an inspect stream without session persistence. Collects all text, parses
/// the trailing JSON block, and emits proposals (or an error) followed by Done.
async fn drive_inspect_stream(mut stream: ChatStream, channel: &str, app: &AppHandle) {
    use futures::StreamExt;
    let mut text = String::new();
    let mut errored = false;
    while let Some(item) = stream.next().await {
        match item {
            Ok(ChatDelta::Text(t)) => text.push_str(&t),
            Ok(ChatDelta::Status(s)) => {
                if !s.starts_with("__") {
                    let _ = app.emit(channel, InspectDelta::Status(s));
                }
            }
            Ok(ChatDelta::ToolCallStarted { name, .. }) => {
                let _ = app.emit(channel, InspectDelta::Status(format!("Reading repo ({name})…")));
            }
            Ok(ChatDelta::Error(e)) => {
                errored = true;
                let _ = app.emit(channel, InspectDelta::Error(e));
            }
            Ok(_) => {} // ToolCallFinished, Done — ignore; we parse on stream end
            Err(e) => {
                errored = true;
                let _ = app.emit(channel, InspectDelta::Error(format!("{e:?}")));
            }
        }
    }
    if errored {
        let _ = app.emit(channel, InspectDelta::Done);
        return;
    }
    match crate::modules::ai::types::parse_proposals(&text) {
        Ok(models) => {
            let _ = app.emit(channel, InspectDelta::Proposals(models));
        }
        Err(e) => {
            let _ = app.emit(channel, InspectDelta::Error(format!("{e:?}")));
        }
    }
    let _ = app.emit(channel, InspectDelta::Done);
}

#[tauri::command]
pub async fn ai_inspect_models(
    session_id: String,
    connection_id: String,
    table: String,
    db: State<'_, DbState>,
    dynamo_registry: State<'_, DynamoClientRegistry>,
    app: AppHandle,
) -> AppResult<()> {
    // 1. Parse connection_id.
    let conn_uuid = Uuid::parse_str(&connection_id)
        .map_err(|e| AppError::Validation(format!("invalid connection id: {e}")))?;

    // 2. Resolve provider.
    let resolved = crate::modules::ai::settings::AiSettings::resolve(&db, Some(conn_uuid))?;
    let provider_id = ProviderId::from_kebab(&resolved.provider_id).ok_or_else(|| {
        AppError::Internal(format!(
            "unknown provider in settings: {}",
            resolved.provider_id
        ))
    })?;
    let provider = factory::build(&db, provider_id)?;

    // 3. Gate: provider must be able to read files.
    if !provider.capabilities().can_read_files {
        return Err(AppError::Validation(format!(
            "the active provider ({}) cannot read files; switch to a CLI provider (Claude Code or Codex) to generate models with AI",
            provider_id.as_kebab()
        )));
    }

    // 4. Resolve project source path. Generated models are saved into the
    //    linked context folder, so a folder is still required; the source path
    //    itself is now local per-connection state (migrated out of context.yaml
    //    on first resolve).
    let (_kind, context_path) =
        crate::modules::context::commands::get_conn_kind_and_path(&db, conn_uuid)?;
    if context_path.is_none() {
        return Err(AppError::Validation(
            "connection has no linked context folder".into(),
        ));
    }
    let project_source_path_str =
        crate::modules::context::commands::resolve_project_source_path(&db, conn_uuid)?
            .ok_or_else(|| {
                AppError::Validation(
                    "project source path is not configured for this context folder".into(),
                )
            })?;

    // 5. Fetch the table description.
    let client = dynamo_registry.acquire(&conn_uuid).await?;
    let desc = crate::modules::dynamo::tables::describe::describe_table(&client, &table).await?;
    let table_description_json = serde_json::to_string(&desc)
        .map_err(|e| AppError::Internal(format!("serialise table description: {e}")))?;

    // 6. Build InspectRequest.
    let req = InspectRequest {
        project_source_path: std::path::PathBuf::from(project_source_path_str),
        table_description_json,
        model: None,
    };

    // 7. Spawn the streaming task.
    let channel = format!("ai-inspect-delta:{session_id}");
    let app_clone = app.clone();
    tokio::spawn(async move {
        match provider.inspect(req).await {
            Ok(stream) => {
                drive_inspect_stream(stream, &channel, &app_clone).await;
            }
            Err(e) => {
                let _ = app_clone.emit(&channel, InspectDelta::Error(format!("{e:?}")));
                let _ = app_clone.emit(&channel, InspectDelta::Done);
            }
        }
    });

    Ok(())
}
