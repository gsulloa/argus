# ai-sql-generation Specification

## Purpose
TBD - created by archiving change add-ai-providers. Update Purpose after archive.
## Requirements
### Requirement: Toolbar button visibility tied to provider configuration

The "✨" button MUST be hidden when `ai_get_settings().default_provider` is `null` AND no per-connection override exists for the current connection. The button MUST appear (without page reload) within 1 second of the user saving settings that configure a default provider — implemented by re-fetching settings on a focus event or by emitting an `ai-settings-changed` Tauri event.

#### Scenario: Button hidden on first install

- **GIVEN** a fresh Argus install with no AI settings configured
- **WHEN** the user opens a Postgres query tab
- **THEN** the "✨" button is NOT present in the toolbar

#### Scenario: Button appears after configuration

- **GIVEN** the "✨" button is hidden and the AI settings panel is open
- **WHEN** the user saves a default provider of `claude-cli`
- **THEN** the "✨" button becomes visible in any open Postgres query tab within 1 second

### Requirement: Frontend module mirrors the backend trait

A new module `src/modules/ai/` MUST exist with:
- `api.ts` — wrappers for every Tauri command in the `ai-providers` capability (listProviders, validateProvider, getSettings, setSettings, setApiKey, deleteApiKey) **AND** the new chat commands (`chatSend`, `chatCancel`, `chatClose`, `chatHistory`). The legacy `generateSql` wrapper MAY remain for parity with the backend's deprecated command, but the frontend MUST NOT call it from any production code path after this change.
- `types.ts` — TypeScript mirrors of `ProviderId`, `Capabilities`, `ValidationResult`, `AiSettingsView`, `AiSettingsInput`, and the new chat types: `ChatRole`, `ChatTurn`, `ChatDelta` (discriminated union), `ChatSessionId`.
- `store.tsx` — React context exposing the cached `ai_list_providers` result, with revalidation on `ai-settings-changed` and on document focus (unchanged from v1).
- `session.ts` — a per-tab `ChatSession` class managing the streaming subscription, in-memory history, and React listener notifications via `useSyncExternalStore`.
- `components/ChatPanel.tsx` — the docked panel described in the `ai-chat-panel` capability.
- `components/SettingsPanel.tsx` — unchanged from `add-ai-providers`.

The `GenerateModal.tsx` component and its CSS/tests from `add-ai-providers` MUST be deleted in this change.

#### Scenario: api.ts exposes chat commands

- **WHEN** `src/modules/ai/api.ts` is imported
- **THEN** the module exports `chatSend`, `chatCancel`, `chatClose`, and `chatHistory` functions
- **AND** each maps to the matching Tauri command (`ai_chat_send`, etc.)

#### Scenario: Store revalidates on settings change

- **GIVEN** the store is mounted and has cached an `ai_list_providers` result
- **WHEN** an `ai-settings-changed` Tauri event fires
- **THEN** the store re-fetches `ai_list_providers` and updates subscribers

#### Scenario: GenerateModal is removed

- **WHEN** the repository is searched for `GenerateModal`
- **THEN** no source file under `src/` defines or imports a `GenerateModal` symbol
- **AND** no CSS module file `GenerateModal.module.css` remains

