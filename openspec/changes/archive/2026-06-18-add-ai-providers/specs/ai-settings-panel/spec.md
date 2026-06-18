## ADDED Requirements

### Requirement: Command palette entry opens the settings modal

The command palette MUST gain a new entry: `id: "ai.configureProviders"`, label `"AI: Configure providers"`. Selecting the entry MUST open the `SettingsPanel` modal (component in `src/modules/ai/components/SettingsPanel.tsx`).

#### Scenario: Command palette lists the entry

- **WHEN** the user opens the command palette
- **THEN** an entry labelled "AI: Configure providers" is present and selectable

#### Scenario: Selecting the entry opens the modal

- **WHEN** the user selects "AI: Configure providers" from the palette
- **THEN** `SettingsPanel` renders as a modal overlay
- **AND** the modal fetches the current settings and validation results on mount

### Requirement: Default provider radio group

The `SettingsPanel` MUST render a radio group with one option per `ProviderId`. Each option MUST display the provider name, its current `ValidationResult`, and an optional remediation hint when the result is `Missing` or `Misconfigured`. Options whose validation is NOT `Ready` MUST be selectable, but selecting one MUST trigger an inline warning: `"This provider isn't ready. Generation will fail until it's configured."`

#### Scenario: Default provider preselected from settings

- **GIVEN** `ai_settings.default_provider = "claude-cli"`
- **WHEN** the panel opens
- **THEN** the `claude-cli` radio option is selected

#### Scenario: Unready selection warns inline

- **GIVEN** `AnthropicApi` is `Missing { hint: "Enter an API key below" }`
- **WHEN** the user selects the `anthropic-api` radio option
- **THEN** an inline warning appears under the radio reading `"This provider isn't ready. Generation will fail until it's configured."`
- **AND** the option's hint text is also visible

### Requirement: Per-provider configuration sub-sections

For each provider, the panel MUST render a sub-section showing:
- The provider's name and current validation status.
- A model dropdown sourced from `capabilities.available_models`, preselected to the configured model or the provider's `default_model`.
- For providers whose `requires_api_key` is `true`: an API key input field (password-masked) with a "Save" button, a "Clear" button, and an indicator of whether a key is currently stored (`key present` / `no key`).
- For providers whose `requires_api_key` is `false`: a short hint explaining how to install the CLI (e.g., links to the official install page).

The API key input MUST submit via `ai_set_api_key` and trigger an immediate re-validation. The "Clear" button MUST call `ai_delete_api_key` and trigger an immediate re-validation.

#### Scenario: Saving a key triggers revalidation

- **GIVEN** `AnthropicApi` is `Missing` and no key is stored
- **WHEN** the user enters a key into the Anthropic input and clicks "Save"
- **THEN** `ai_set_api_key(AnthropicApi, key)` is called
- **AND** the validation cache is invalidated (per ai-providers spec)
- **AND** the panel re-fetches `ai_list_providers` and updates the visible status within 3 seconds

#### Scenario: Model dropdown preselects configured model

- **GIVEN** `ai_settings.openai_api_model = "gpt-4o-mini"`
- **WHEN** the panel opens
- **THEN** the OpenAI model dropdown shows `"gpt-4o-mini"` selected

#### Scenario: CLI provider sub-section omits API key input

- **WHEN** the panel renders the `ClaudeCli` sub-section
- **THEN** no API key input is present
- **AND** an install hint with a link is displayed

### Requirement: Save persists settings atomically

The panel MUST expose a single "Save" button at the bottom that calls `ai_set_settings` with the current form state (default provider + per-provider model). Until "Save" is clicked, in-panel edits MUST NOT be persisted. The "Cancel" button MUST close the panel without persisting. The "Save" button MUST be disabled when the form state is unchanged from the loaded settings.

#### Scenario: Cancel does not persist

- **GIVEN** the panel is open with `default_provider = "claude-cli"` loaded
- **WHEN** the user changes the radio to `openai-api` and clicks "Cancel"
- **THEN** `ai_settings.default_provider` remains `"claude-cli"`

#### Scenario: Save persists changes

- **GIVEN** the panel is open and the user has changed the default provider and one model
- **WHEN** the user clicks "Save"
- **THEN** exactly one call to `ai_set_settings` is made with the new values
- **AND** the panel closes
- **AND** an `ai-settings-changed` Tauri event is emitted

### Requirement: API key entries are never displayed

The panel MUST NOT call any command that returns the raw key value. The only visible state about a stored key is the boolean `key present` / `no key`. After a key is saved the input field MUST clear (to discourage shoulder-surfing the input).

#### Scenario: Saved key is not echoed back

- **GIVEN** the user saves a key and the panel re-renders
- **WHEN** the user inspects the Anthropic input
- **THEN** the input is empty
- **AND** the indicator reads `"key present"`
