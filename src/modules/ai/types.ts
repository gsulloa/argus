// ---------------------------------------------------------------------------
// Raw types — mirror Rust serde shapes exactly (snake_case).
// Convention confirmed by src/modules/context/types.ts which uses snake_case
// throughout (primary_key, last_synced, body_summary, etc.).
// Capabilities has no rename_all in Rust, so its fields are snake_case in JSON.
// ---------------------------------------------------------------------------

export type ProviderId =
  | "claude-cli"
  | "codex-cli"
  | "anthropic-api"
  | "openai-api";

export const PROVIDER_IDS: ProviderId[] = [
  "claude-cli",
  "codex-cli",
  "anthropic-api",
  "openai-api",
];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  "claude-cli": "Claude CLI",
  "codex-cli": "Codex CLI",
  "anthropic-api": "Anthropic API",
  "openai-api": "OpenAI API",
};

export interface Capabilities {
  can_read_files: boolean;
  supports_streaming: boolean;
  requires_api_key: boolean;
  default_model: string;
  available_models: string[];
}

/** Discriminated union mirroring Rust's serde(tag = "kind", rename_all = "PascalCase"). */
export type ValidationResult =
  | { kind: "Ready" }
  | { kind: "Missing"; hint: string }
  | { kind: "Misconfigured"; reason: string };

export interface ProviderListEntry {
  id: ProviderId;
  capabilities: Capabilities;
  validation: ValidationResult;
}

export interface KeyPresence {
  anthropic: boolean;
  openai: boolean;
}

export interface AiConnectionOverrideView {
  connection_id: string;
  provider_id: ProviderId;
  model: string | null;
}

export interface AiSettingsView {
  default_provider: ProviderId | null;
  claude_cli_model: string | null;
  codex_cli_model: string | null;
  anthropic_api_model: string | null;
  openai_api_model: string | null;
  overrides: AiConnectionOverrideView[];
  key_present: KeyPresence;
}

/** Input override row sent inside AiSettingsInput. */
export interface AiConnectionOverrideInput {
  connection_id: string;
  provider_id: ProviderId;
  model: string | null;
}

/**
 * Input shape sent to ai_set_settings.
 * The Rust AiSettingsCommandInput struct has no rename_all, so field keys must
 * be snake_case in the JSON body. The Tauri envelope wraps this as { input: ... }.
 */
export interface AiSettingsInput {
  default_provider: ProviderId | null;
  claude_cli_model: string | null;
  codex_cli_model: string | null;
  anthropic_api_model: string | null;
  openai_api_model: string | null;
  overrides: AiConnectionOverrideInput[];
}

// Re-export AiPayload from context to avoid duplication.
export type { AiPayload } from "@/modules/context/types";

// ---------------------------------------------------------------------------
// Chat types — mirror Rust serde shapes exactly.
// ChatDelta uses #[serde(tag = "kind", content = "data", rename_all = "PascalCase")]
// (adjacently tagged). Wire examples:
//   Text(String)    → { "kind": "Text", "data": "hello" }
//   Status(String)  → { "kind": "Status", "data": "Thinking..." }
//   Error(String)   → { "kind": "Error", "data": "something went wrong" }
//   Struct variants → { "kind": "ToolCallStarted", "data": { "id": ..., "name": ..., "input": ... } }
// ChatRole uses #[serde(rename_all = "PascalCase")] → "User" | "Assistant"
// ---------------------------------------------------------------------------

export type ChatRole = "User" | "Assistant";

export interface ToolUseRecord {
  id: string;
  name: string;
  input: unknown;
  output: string | null;
  is_error: boolean;
}

export interface ChatTurn {
  role: ChatRole;
  content: string;
  tool_uses: ToolUseRecord[];
}

export type ChatDelta =
  | { kind: "Text"; data: string }
  | { kind: "ToolCallStarted"; data: { id: string; name: string; input: unknown } }
  | { kind: "ToolCallFinished"; data: { id: string; output: string; is_error: boolean } }
  | { kind: "Status"; data: string }
  | { kind: "Done"; data: { finish_reason: string | null } }
  | { kind: "Error"; data: string };
