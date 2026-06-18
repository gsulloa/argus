## ADDED Requirements

### Requirement: Generate SQL modal in the Postgres SQL editor

The frontend MUST expose a "✨ Generate SQL" affordance in the Postgres `QueryEditor` toolbar (file `src/modules/postgres/sql/QueryEditor.tsx`). Clicking it MUST open a modal component `GenerateModal` (in `src/modules/ai/`) containing:

1. A multi-line textarea for the natural-language prompt (autofocus on open).
2. A "Provider" dropdown listing every provider that validated as `Ready`, with the connection's resolved provider preselected.
3. A "Model" dropdown listing the selected provider's `available_models`, with the configured-or-default model preselected.
4. A primary action button labelled "Generate" — disabled while the prompt is empty.
5. A secondary "Cancel" button.

While the generation is in progress, the modal MUST replace "Generate" with a spinner + "Cancel" button that aborts the in-flight request. After successful generation the modal MUST display the returned SQL in a read-only code block above three buttons: "Insert into editor", "Replace editor contents", "Cancel". After an error the modal MUST display the error message and a "Retry" button.

#### Scenario: Toolbar button opens modal

- **WHEN** the user clicks the "✨" button in the Postgres `QueryEditor` toolbar
- **THEN** `GenerateModal` is rendered as a modal overlay
- **AND** the textarea has focus

#### Scenario: Generate disabled while prompt empty

- **GIVEN** the modal is open and the textarea is empty (only whitespace)
- **WHEN** the user examines the "Generate" button
- **THEN** the button is disabled

#### Scenario: Insert appends to editor content

- **GIVEN** the editor currently contains `"SELECT 1;"` and the modal has produced `"SELECT 2;"`
- **WHEN** the user clicks "Insert into editor"
- **THEN** the editor contains `"SELECT 1;\n\nSELECT 2;"` (newline-separated; existing trailing whitespace normalised)
- **AND** the modal closes

#### Scenario: Replace overwrites editor content

- **GIVEN** the editor currently contains `"SELECT 1;"` and the modal has produced `"SELECT 2;"`
- **WHEN** the user clicks "Replace editor contents"
- **THEN** the editor contains exactly `"SELECT 2;"`
- **AND** the modal closes

#### Scenario: Cancel aborts in-flight request

- **GIVEN** the modal is in the "generating" state with an in-flight Tauri call
- **WHEN** the user clicks "Cancel"
- **THEN** the Tauri call's promise is abandoned (the modal does not act on its eventual response)
- **AND** the modal returns to the "idle" state with the original prompt intact

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

### Requirement: Modal forwards context payload built from the active connection

When the user clicks "Generate", the modal MUST call `ai_generate_sql` with:
- `prompt`: the textarea contents (trimmed).
- `connection_id`: the active connection's id.
- `context_path`: the connection's `context_path` (may be `null`).
- `payload`: the result of `context_ai_payload(connection_id, include_full_bodies: false)`.
- `model`: the dropdown selection (only sent when the user changed it from the configured default; otherwise `null`).

#### Scenario: Payload reflects current context folder

- **GIVEN** the active connection has `context_path = "/Users/me/billing-ctx"` and the folder contains 5 objects
- **WHEN** the user clicks "Generate"
- **THEN** the `payload` argument to `ai_generate_sql` contains exactly those 5 objects
- **AND** the `context_path` argument is `"/Users/me/billing-ctx"`

#### Scenario: Unlinked connection still generates

- **GIVEN** the active connection has `context_path = null`
- **WHEN** the user clicks "Generate"
- **THEN** the call succeeds with an empty `payload`
- **AND** the `context_path` argument is `null`
- **AND** CLI providers fall back to the system temp directory as `current_dir` (per the ai-providers spec)

### Requirement: Frontend module mirrors the backend trait

A new module `src/modules/ai/` MUST exist with:
- `api.ts` — wrappers for every Tauri command listed in `ai-providers` (`listProviders`, `validateProvider`, `getSettings`, `setSettings`, `setApiKey`, `deleteApiKey`, `generateSql`).
- `types.ts` — TypeScript mirrors of `ProviderId`, `Capabilities`, `ValidationResult`, `AiSettingsView`, `AiSettingsInput`, `GenerateRequest` (frontend-shape).
- `store.tsx` — a React context exposing the cached `ai_list_providers` result, with revalidation on `ai-settings-changed` and on document focus.
- `components/GenerateModal.tsx` — the modal described above.
- `components/SettingsPanel.tsx` — covered by `ai-settings-panel`.

#### Scenario: api.ts wraps every Tauri command

- **WHEN** `src/modules/ai/api.ts` is imported
- **THEN** the module exports functions named `listProviders`, `validateProvider`, `getSettings`, `setSettings`, `setApiKey`, `deleteApiKey`, `generateSql`
- **AND** each function calls the matching Tauri command name (`ai_list_providers`, etc.)

#### Scenario: Store revalidates on settings change

- **GIVEN** the store is mounted and has cached an `ai_list_providers` result
- **WHEN** an `ai-settings-changed` Tauri event fires
- **THEN** the store re-fetches `ai_list_providers` and updates subscribers
