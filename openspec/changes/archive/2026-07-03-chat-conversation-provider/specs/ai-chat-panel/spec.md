## MODIFIED Requirements

### Requirement: Provider/model badge and runtime mismatch handling

The panel header MUST display the active provider name and selected model as an **interactive, session-scoped selector** (replacing the read-only badge). The selector MUST allow the user to change the provider — and its model — for the current chat session only. Changing the selector MUST NOT write `default_provider` in `ai_settings` nor any row in `ai_connection_overrides`; the choice lives solely in the session's frontend state and the `provider_id`/`model` sent on the next `ai_chat_send`.

When a chat is opened, the selector MUST initialize its value from the current resolution: the per-connection override if one exists, otherwise the global default provider/model (unchanged initial behavior).

The selector MUST offer only providers reported `Ready` by `ai_list_providers` as selectable. Providers reported `Missing` or `Misconfigured` MUST appear disabled (or clearly marked as needing setup) with a short hint and an affordance to open AI settings to configure them.

Switching the provider mid-conversation MUST keep the existing turn history and use the newly chosen provider for subsequent turns (no forced new conversation). Provider-specific resume state MAY be reset on switch; conversation history MUST be preserved.

When the user changes the global default provider via the AI settings panel mid-chat AND the user has NOT explicitly overridden the provider for this session, the active chat session MUST continue using its bound provider and a small inline notice MUST appear: `"Settings changed — new chats will use <new provider>. This chat continues with <bound provider>."` Once the user has explicitly chosen a provider for the session via the selector, that settings-change notice MUST be suppressed for this session (the user has taken manual control).

#### Scenario: Selector switches provider for the current session only

- **GIVEN** the chat is using `claude-cli` with 3 turns of history
- **WHEN** the user opens the header selector and picks `anthropic-api` (a Ready provider)
- **THEN** the header shows `anthropic-api` and its model
- **AND** the existing 3 turns remain visible
- **AND** the next submitted prompt is answered by `anthropic-api`
- **AND** `ai_settings.default_provider` and `ai_connection_overrides` are unchanged

#### Scenario: New chat initializes from current resolution

- **GIVEN** the active connection has a per-connection override of `codex-cli`
- **WHEN** the user opens a fresh chat in that connection's query tab
- **THEN** the selector shows `codex-cli` as the initial provider
- **AND** no explicit user override has been recorded yet for the session

#### Scenario: Unready provider is not directly selectable

- **GIVEN** `openai-api` is reported `Missing { hint }` by `ai_list_providers`
- **WHEN** the user opens the selector
- **THEN** `openai-api` appears disabled with its hint
- **AND** an affordance is offered to open AI settings to configure it
- **AND** selecting it does not change the session provider

#### Scenario: Explicit override suppresses the settings-change notice

- **GIVEN** the user has explicitly selected `anthropic-api` for this session via the selector
- **WHEN** the user changes the global default to `openai-api` in the AI settings panel and returns to the chat
- **THEN** the chat continues with `anthropic-api`
- **AND** no "Settings changed — new chats will use …" notice is shown for this session

#### Scenario: Bound provider is unchanged by mid-chat settings change (no explicit override)

- **GIVEN** the chat is bound to `claude-cli` with 3 turns of history and the user has not used the selector
- **WHEN** the user opens the AI settings panel and changes the default to `anthropic-api`
- **AND** returns to the chat tab
- **THEN** the chat header still reads `claude-cli`
- **AND** an inline notice mentions the change and that new chats will use the new provider
