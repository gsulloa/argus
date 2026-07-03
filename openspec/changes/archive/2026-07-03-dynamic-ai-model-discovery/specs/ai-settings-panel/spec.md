## MODIFIED Requirements

### Requirement: Per-provider configuration sub-sections

For each provider, the panel MUST render a sub-section showing:
- The provider's name and current validation status.
- A model dropdown sourced from the provider entry's **effective** model list
  (`ProviderListEntry.models.models`, dynamic when available, curated fallback
  otherwise), preselected to the configured model when that model is present in the
  effective list, otherwise preselected to the provider's `default_model`. The
  dropdown MUST NOT render a selected entry that is absent from the effective list.
- A discreet **model source indicator** reflecting `ProviderListEntry.models.source`:
  it MUST distinguish "from provider" (with a relative "last refreshed" time derived
  from `refreshed_at`), "from cache", and "local fallback". When
  `ProviderListEntry.models.error` is present, its text MUST be surfaced discreetly
  (e.g. tooltip or subtext) so the user understands why the fallback is shown.
- A **refresh affordance** (e.g. a small refresh button) that calls `ai_refresh_models`
  for that provider and updates the dropdown and source indicator with the result.
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

- **GIVEN** `ai_settings.openai_api_model = "gpt-5.1-mini"` and it is present in the effective list
- **WHEN** the panel opens
- **THEN** the OpenAI model dropdown shows `"gpt-5.1-mini"` selected

#### Scenario: Dropdown falls back to default when stored model absent

- **GIVEN** `ai_settings.openai_api_model = "gpt-4o-mini"` and `gpt-4o-mini` is not in the effective model list
- **WHEN** the panel opens
- **THEN** the OpenAI model dropdown shows the provider `default_model` selected
- **AND** no option for `"gpt-4o-mini"` is rendered

#### Scenario: CLI provider sub-section omits API key input

- **WHEN** the panel renders the `ClaudeCli` sub-section
- **THEN** no API key input is present

#### Scenario: Source indicator reflects dynamic provider list

- **GIVEN** `ai_list_providers` returned `AnthropicApi` with `models.source = "provider"` and a `refreshed_at` timestamp
- **WHEN** the panel renders the Anthropic sub-section
- **THEN** the source indicator shows the list came from the provider with a relative "last refreshed" time
- **AND** the dropdown lists the dynamically discovered models

#### Scenario: Source indicator reflects fallback with error

- **GIVEN** `ai_list_providers` returned `OpenAiApi` with `models.source = "fallback"` and an `error`
- **WHEN** the panel renders the OpenAI sub-section
- **THEN** the source indicator shows the list is a local fallback
- **AND** the error reason is surfaced discreetly

#### Scenario: Refresh button updates the list

- **GIVEN** the OpenAI sub-section shows a fallback list
- **WHEN** the user clicks the refresh affordance and a valid key now returns a live list
- **THEN** `ai_refresh_models("openai-api")` is called
- **AND** the dropdown and source indicator update to reflect `source = "provider"`
