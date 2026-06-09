# text-input-hygiene Specification

## Purpose

The `text-input-hygiene` capability ensures that every text-entry surface in Argus — native `<input>`/`<textarea>` elements and CodeMirror editors alike — disables browser/OS text-mutation features (auto-capitalize, autocorrect, autocomplete, spellcheck) so that identifiers, queries, credentials, and free text are preserved exactly as typed, across all engines.

## Requirements

### Requirement: Native text inputs disable text-mutation features
Every native `<input>` and `<textarea>` used for entering data, identifiers, queries, filters, search terms, names, credentials, or free text in Argus SHALL disable browser/OS text-mutation features by setting `autoCapitalize="off"`, `autoCorrect="off"`, `autoComplete="off"`, and `spellCheck={false}`. This applies regardless of column type (text, JSON, numeric) and regardless of engine (Postgres, MySQL, MSSQL, DynamoDB, Athena).

#### Scenario: Typing an identifier in a cell editor
- **WHEN** a user types a mixed-case identifier such as `userId` into any inline cell editor or inspector field
- **THEN** the text is preserved exactly with no auto-capitalization, autocorrection, or spellcheck markup applied

#### Scenario: Typing a value in a connection form or search field
- **WHEN** a user types into any connection form field, filter value, column picker search, schema/table search, saved-query name, or the AI chat composer
- **THEN** the input has `autoCapitalize`, `autoCorrect`, `autoComplete` set to `off` and `spellCheck` disabled, and the typed text is not altered

### Requirement: CodeMirror editors disable text-mutation features
Every CodeMirror 6 editor in Argus (the Postgres, MySQL, MSSQL, and Athena SQL editors, and the DynamoDB JSON inspector editor) SHALL disable auto-capitalize, autocorrect, autocomplete, and spellcheck on its underlying editable surface by applying the corresponding attributes through `EditorView.contentAttributes`.

#### Scenario: Typing SQL keywords
- **WHEN** a user types `select` or an unquoted identifier into any SQL editor
- **THEN** the text is not auto-capitalized or autocorrected, and no spellcheck markup is rendered on the editor content

#### Scenario: Editing JSON in the Dynamo inspector
- **WHEN** a user edits a value in the DynamoDB JSON inspector CodeMirror editor
- **THEN** the editor's content surface carries `autocapitalize="off"`, `autocorrect="off"`, `autocomplete="off"`, and `spellcheck="false"`, and the JSON text is preserved exactly

### Requirement: Shared default-on mechanism for native inputs
The codebase SHALL provide a single shared mechanism (a reusable props bundle or helper) that applies the four text-mutation-disabling attributes, so native inputs receive these defaults consistently and new inputs can adopt them without redefining each attribute.

#### Scenario: Adding a new native input
- **WHEN** a developer adds a new native `<input>` or `<textarea>` and applies the shared mechanism
- **THEN** the input automatically has `autoCapitalize="off"`, `autoCorrect="off"`, `autoComplete="off"`, and `spellCheck={false}` without per-attribute repetition
