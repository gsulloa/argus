## MODIFIED Requirements

### Requirement: Per-provider configuration sub-sections

For each provider, the panel MUST render a sub-section showing:
- The provider's name and current validation status.
- A model dropdown sourced from `capabilities.available_models`, preselected to the
  configured model when that model is present in `available_models`, otherwise
  preselected to the provider's `default_model`. The dropdown MUST NOT render a
  selected entry that is absent from `available_models`.
- For providers whose `requires_api_key` is `true`: an API key input field
  (password-masked) with a "Save" button, a "Clear" button, and an indicator of
  whether a key is currently stored (`key present` / `no key`).
- For providers whose `requires_api_key` is `false`: a short hint explaining how to
  install the CLI (e.g., links to the official install page).

The API key input MUST submit via `ai_set_api_key` and trigger an immediate
re-validation. The "Clear" button MUST call `ai_delete_api_key` and trigger an
immediate re-validation.

#### Scenario: Saving a key triggers revalidation

- **GIVEN** `AnthropicApi` is `Missing` and no key is stored
- **WHEN** the user enters a key into the Anthropic input and clicks "Save"
- **THEN** `ai_set_api_key(AnthropicApi, key)` is called
- **AND** the validation cache is invalidated (per ai-providers spec)
- **AND** the panel re-fetches `ai_list_providers` and updates the visible status within 3 seconds

#### Scenario: Model dropdown preselects configured model

- **GIVEN** `ai_settings.openai_api_model = "gpt-5.1-mini"`
- **WHEN** the panel opens
- **THEN** the OpenAI model dropdown shows `"gpt-5.1-mini"` selected

#### Scenario: Dropdown falls back to default when stored model retired

- **GIVEN** `ai_settings.openai_api_model = "gpt-4o-mini"` and `gpt-4o-mini` is not in `available_models`
- **WHEN** the panel opens
- **THEN** the OpenAI model dropdown shows the provider `default_model` (`"gpt-5.1"`) selected
- **AND** no option for `"gpt-4o-mini"` is rendered

#### Scenario: CLI provider sub-section omits API key input

- **WHEN** the panel renders the `ClaudeCli` sub-section
- **THEN** no API key input is present
- **AND** an install hint with a link is displayed
