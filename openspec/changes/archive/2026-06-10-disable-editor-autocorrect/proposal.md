## Why

Argus is a database client: text-editing surfaces carry identifiers, SQL, JSON, and raw column values where any silent mutation is a correctness bug. Today the OS/browser engine auto-capitalizes, autocorrects, autocompletes, and spellchecks most inputs — corrupting `userId` into `UserId`, `SELECT` into `Select`, or quietly "fixing" a value before it reaches the database. Coverage is inconsistent: only Postgres JSON cells disable these behaviors; CodeMirror editors, all connection forms, filters, searches, saved-query dialogs, the AI chat composer, and MySQL/MSSQL/DynamoDB cell editors do not.

## What Changes

- Disable `autoCapitalize`, `autoCorrect`, `autoComplete`, and `spellCheck` on **every** text-editing surface in the app.
- Introduce a single shared mechanism (a props bundle/helper) so native `<input>`/`<textarea>` elements get these attributes by default and new inputs can opt in trivially — preventing regressions.
- Apply the attributes to CodeMirror 6 editors via `EditorView.contentAttributes` (the internal `contentEditable` is not reachable through React props), covering all SQL editors and the Dynamo JSON inspector editor.
- Backfill native inputs that are currently uncovered: Postgres non-JSON cells/inspector, MySQL/MSSQL cell editors, DynamoDB inline S/N editors, all connection forms (postgres/mysql/mssql/athena/dynamo), filter bar (`ValueInput`, `ColumnPicker`), searches (`SchemaSearch`, `TableSearchInput`), saved queries (`SavedQueriesPanel`, `SaveAsModal`), and the AI `ChatPanel` composer.

## Capabilities

### New Capabilities
- `text-input-hygiene`: Cross-engine requirement that all text-editing surfaces (native inputs/textareas and CodeMirror editors) disable auto-capitalize, autocorrect, autocomplete, and spellcheck, backed by a shared default-on mechanism for native inputs and a CodeMirror extension for editors.

### Modified Capabilities
<!-- No existing spec's REQUIREMENTS change; this adds a new cross-cutting behavior. -->

## Impact

- **New shared code**: a props helper for native inputs and a CodeMirror extension (e.g. under `src/modules/shared/`).
- **Frontend only** (TypeScript/React + CodeMirror 6); no Rust, schema, or API changes.
- **Touched files**: 4 SQL `QueryEditor.tsx` (postgres/mysql/mssql/athena), `dynamo/.../InspectorJsonEditor.tsx`, Postgres `EditableCell.tsx`/`Inspector.tsx`, MySQL/MSSQL `EditableCell.tsx`, Dynamo `InlineCellEditor.tsx`, 5 `ConnectionForm.tsx`, `filter-bar/ValueInput.tsx` + `ColumnPicker.tsx`, `SchemaSearch.tsx`, `TableSearchInput.tsx`, `SavedQueriesPanel.tsx`, `SaveAsModal.tsx`, `ai/components/ChatPanel.tsx`.
- **No behavioral risk** beyond removing unwanted text mutation; no breaking changes.
