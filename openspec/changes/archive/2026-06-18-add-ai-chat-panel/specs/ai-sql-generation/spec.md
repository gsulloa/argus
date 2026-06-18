## REMOVED Requirements

### Requirement: Generate SQL modal in the Postgres SQL editor

**Reason**: Replaced by the docked chat panel from the new `ai-chat-panel` capability. The modal collapsed the AI's streaming output into a single string and forced a per-request close/reopen loop that broke iteration. The chat panel exposes the streaming events the user wanted (especially CLI tool calls) and supports multi-turn naturally.

**Migration**: The "✨" toolbar button in `src/modules/postgres/sql/QueryTab.tsx` now toggles the chat panel. All previous modal entry points are removed; no other consumers existed. `GenerateModal.tsx` and its CSS module + tests are deleted in this change.

### Requirement: Modal forwards context payload built from the active connection

**Reason**: Superseded — the chat panel constructs the context payload once per turn via `contextApi.aiPayload(connectionId, false)` and passes it to `ai_chat_send`. CLI providers continue to ignore the payload and rely on `current_dir`. The contract is preserved; the modal-specific scenarios no longer apply.

**Migration**: See `ai-chat-panel` capability's "Multi-turn conversation lifecycle" and `ai-providers` capability's "API providers send full message history per turn" requirements.

## MODIFIED Requirements

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
