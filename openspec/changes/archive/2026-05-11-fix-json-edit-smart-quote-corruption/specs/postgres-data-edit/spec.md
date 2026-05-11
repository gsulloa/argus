## ADDED Requirements

### Requirement: JSON/JSONB cell editor disables native autocorrect

When the inline cell editor (in the data grid OR in the row inspector) is mounted for a column whose `data_type` matches `looksLikeJson(t)` — currently `json`, `jsonb`, anything ending in `[]`, or anything starting with `_` — the underlying `<textarea>` MUST render with the following attributes:

- `autoCorrect="off"`
- `autoCapitalize="off"`
- `spellCheck={false}`
- `autoComplete="off"`

The purpose is to prevent the host OS (notably macOS) from rewriting typed characters (smart quotes, em-dashes, capitalization) before React receives them. These attributes are NOT required for non-JSON column types (text columns may legitimately want autocorrect for prose).

#### Scenario: Typing a straight quote in a jsonb cell produces a straight quote

- **WHEN** the user double-clicks a `jsonb` cell on macOS with the system "Smart Quotes" preference enabled
- **AND** types the character `"`
- **THEN** the textarea's value contains the ASCII character `"` (U+0022), NOT a curly quote (`"` U+201C or `"` U+201D)

#### Scenario: Pasting smart-quoted JSON into a jsonb cell is preserved as-typed

- **WHEN** the user pastes the literal string `{"foo":"bar"}` (with U+201C / U+201D as the outer quotes) into a `jsonb` cell editor
- **THEN** the textarea displays the pasted string with the smart quotes intact (the OS does not auto-rewrite them but it also does not strip them — that's the next requirement's job)

#### Scenario: Text columns are unaffected

- **WHEN** the user opens an inline editor for a `text` or `varchar` column
- **THEN** the textarea does NOT have `autoCorrect="off"` (autocorrect remains enabled per the OS default)

### Requirement: JSON/JSONB edits validate as strict JSON on commit

When the user commits a json/jsonb cell edit (Tab / Enter / clicking outside the cell / `<textarea>` blur in the row inspector), the frontend MUST validate the textarea contents by:

1. Trimming leading and trailing whitespace.
2. If the trimmed value is empty (`""`), treat the commit as a NULL write (existing behavior) — no parse is attempted.
3. Otherwise, attempt `JSON.parse(trimmed)`:
   - If parsing succeeds, the value sent to the edit buffer (and ultimately to the backend as `EditOp.update.changes[col]`) MUST be `JSON.stringify(parsed)` — the canonical re-serialization. The user-visible cell value MUST be the canonical form (so the displayed cell after commit reflects exactly what was sent).
   - If parsing fails, the commit MUST be rejected: the textarea MUST remain open in edit mode (no commit, no exit), its border MUST become `var(--danger)`, and an inline error message MUST be rendered immediately below the textarea showing the parser's error message (e.g. `Unexpected token } in JSON at position 47`). The error MUST be in `font-family: var(--font-mono); color: var(--danger); font-size: 11px`. Pressing Escape MUST still cancel the edit normally.

This applies identically in the grid cell editor (`EditableCell.tsx`) and the row inspector (`Inspector.tsx`).

#### Scenario: Valid JSON commits with canonical re-serialization

- **WHEN** the user types `{ "foo": "bar"  }  \n` (with extra whitespace) into a `jsonb` cell and presses Tab
- **THEN** the edit buffer receives the canonical string `{"foo":"bar"}` for that column
- **AND** the cell exits edit mode and renders the canonical form

#### Scenario: Invalid JSON keeps the editor open with an inline error

- **WHEN** the user types `{ "foo": "bar"` (missing closing brace) into a `jsonb` cell and presses Tab
- **THEN** the textarea stays mounted in edit mode
- **AND** its border is `var(--danger)`
- **AND** a one-line error message below the textarea shows the `JSON.parse` error text
- **AND** the edit buffer is NOT mutated for that column
- **AND** pressing Escape exits edit mode without committing

#### Scenario: Empty input commits as NULL

- **WHEN** the user clears a `jsonb` cell to empty (or whitespace only) and presses Tab
- **THEN** the edit buffer records a `null` write for that column (existing behavior)
- **AND** no parse error is shown

#### Scenario: Pasted smart-quote JSON is rejected at commit

- **WHEN** the user pastes `{"foo":"bar"}` (with smart quotes as outer delimiters) into a `jsonb` cell and presses Tab
- **THEN** `JSON.parse` fails with a syntax error
- **AND** the textarea stays open with the danger-border + inline error UI
- **AND** nothing is committed to the buffer or the backend

#### Scenario: Row inspector uses the same validation

- **WHEN** the user types invalid JSON into a `jsonb` field in the row inspector and tabs out
- **THEN** the same danger-border + inline error UI is rendered around the inspector field
- **AND** no commit reaches the buffer

### Requirement: Smart-quote warning chip on JSON edits

After a json/jsonb edit successfully passes `JSON.parse` validation, the frontend MUST scan the canonical (re-stringified) value for the presence of any of the following Unicode code points: U+201C (`"`), U+201D (`"`), U+2018 (`'`), U+2019 (`'`). If any are present, the frontend MUST render a small chip `⚠ Contains smart quotes` directly below the textarea while the editor is still mounted. The chip MUST be informational only — it MUST NOT block the commit, the commit MUST proceed normally, and the chip disappears when the editor closes (no persistent indicator on the dirty cell).

The chip MUST use `font-size: 11px`, `color: var(--warning)`, and a leading warning icon (Lucide `AlertTriangle` or equivalent at 11px).

#### Scenario: Smart quotes inside string content trigger a warning but commit succeeds

- **WHEN** the user pastes the string `{"name":"John “Doe” Smith"}` (smart quotes inside the string value, JSON itself is valid) into a `jsonb` cell and presses Tab
- **THEN** `JSON.parse` succeeds
- **AND** the canonical value sent to the buffer is `{"name":"John "Doe" Smith"}` (smart quotes preserved as valid string content)
- **AND** the smart-quote warning chip is shown below the textarea before commit
- **AND** the commit proceeds normally on Tab (chip is informational)

#### Scenario: Pure ASCII JSON shows no warning

- **WHEN** the user types `{"foo":"bar"}` (all ASCII quotes) into a `jsonb` cell
- **THEN** no smart-quote warning chip is rendered before or after commit
