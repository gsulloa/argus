import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "@/platform/errors/AppError";

import type {
  AiSettingsInput,
  AiSettingsView,
  ChatTurn,
  ProviderId,
  ProviderListEntry,
  ValidationResult,
} from "./types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export const aiApi = {
  /** List all four providers with capabilities and validation status. */
  listProviders: () => call<ProviderListEntry[]>("ai_list_providers"),

  /**
   * Force-revalidate a single provider (bypasses cache).
   * Tauri auto-camelCases outer params; `id` stays `id` (no underscore).
   */
  validateProvider: (id: ProviderId) =>
    call<ValidationResult>("ai_validate_provider", { id }),

  /** Fetch current AI settings including per-connection overrides and key presence. */
  getSettings: () => call<AiSettingsView>("ai_get_settings"),

  /**
   * Persist AI settings.
   * Backend command signature: ai_set_settings(input: AiSettingsCommandInput, ...)
   * so the TS call wraps the payload under the key "input".
   */
  setSettings: (input: AiSettingsInput) =>
    call<void>("ai_set_settings", { input }),

  /**
   * Store an API key for an API-backed provider.
   * Backend: ai_set_api_key(provider: ProviderId, key: String, ...)
   */
  setApiKey: (provider: ProviderId, key: string) =>
    call<void>("ai_set_api_key", { provider, key }),

  /**
   * Delete the stored API key for an API-backed provider (idempotent).
   * Backend: ai_delete_api_key(provider: ProviderId, ...)
   */
  deleteApiKey: (provider: ProviderId) =>
    call<void>("ai_delete_api_key", { provider }),

  /**
   * Send a chat prompt for the given session.
   * Backend: ai_chat_send(session_id, prompt, connection_id, ...)
   * Tauri auto-camelCases: session_id → sessionId, connection_id → connectionId.
   * Emits ChatDelta events on channel `ai-chat-delta:<sessionId>`.
   */
  chatSend: (args: {
    sessionId: string;
    prompt: string;
    connectionId: string | null;
  }) => call<void>("ai_chat_send", args),

  /**
   * Cancel the in-flight request for the session (idempotent).
   * Backend emits a final ChatDelta::Error("cancelled") event.
   */
  chatCancel: (sessionId: string) =>
    call<void>("ai_chat_cancel", { sessionId }),

  /**
   * Close the session and free backend resources.
   */
  chatClose: (sessionId: string) =>
    call<void>("ai_chat_close", { sessionId }),

  /**
   * Return the full turn history for a session. Returns [] if session unknown.
   */
  chatHistory: (sessionId: string) =>
    call<ChatTurn[]>("ai_chat_history", { sessionId }),
};
