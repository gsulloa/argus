## ADDED Requirements

### Requirement: Filter value inputs never silently discard typed characters

The filter bar value input for a single-value operator (`=`, `!=`, `<`, `<=`, `>`, `>=`, and each side of `BETWEEN`) on a numeric or date/timestamp column MUST NOT use `<input type="number">` or `<input type="date">` in a way that causes the browser to report an empty string when the in-progress text is not yet a valid number/date. These inputs SHALL render as `type="text"` with an appropriate `inputMode` hint (`numeric` for integer categories, `decimal` for fractional numeric categories) so every typed character is preserved in the field.

While editing, the displayed value MUST reflect exactly what the user typed (including in-progress text such as `31001,`). The value MUST be coerced to a JavaScript number only when the typed text parses as a finite number; otherwise the raw string MUST be retained as the draft scalar. This MUST NOT change the wire contract — the backend already accepts numeric filter values as JSON strings and range-checks them per "Type-aware structured filter parameter binding".

#### Scenario: Typing a comma into an integer column's value field keeps the text

- **WHEN** the user has an `=` filter row on an `int4` column and types `31001, 31002` into the value input
- **THEN** the value input displays `31001, 31002` verbatim
- **AND** the previously typed digits are not cleared or replaced when the comma is entered

#### Scenario: A complete numeric value still binds as a number

- **WHEN** the user types `31001` into an integer column's `=` value input and applies the filter
- **THEN** the compiled filter carries the value `31001` and the query succeeds
- **AND** no `error serializing parameter` is raised

#### Scenario: BETWEEN inputs preserve in-progress text on numeric columns

- **WHEN** the user types into either the min or max input of a `BETWEEN` row on a numeric column
- **THEN** each character typed is preserved in the field
- **AND** neither side is blanked while the in-progress text is not yet a valid number

### Requirement: In/NotIn chip input splits comma- and whitespace-separated values

The `In` / `NotIn` operator chip input SHALL split a single typed or pasted entry containing multiple values into individual chips. The split MUST occur on commas, newlines, and runs of whitespace; empty fragments MUST be discarded; each resulting fragment MUST be committed as its own chip via the existing per-category scalar parsing. This applies both to keyboard commit (a delimiter key or blur) and to paste events, so that pasting `31001, 31002, 31003` yields three chips rather than one combined chip.

#### Scenario: Pasting a comma-separated list yields one chip per value

- **WHEN** the user selects the `In` operator on an integer column and pastes `31001, 31002, 31003` into the chip input
- **THEN** three chips are created: `31001`, `31002`, `31003`
- **AND** the draft input is left empty

#### Scenario: Typing a delimited list commits multiple chips

- **WHEN** the user types `31001 31002,31003` and triggers a commit (Enter, comma, or blur)
- **THEN** chips `31001`, `31002`, and `31003` are created
- **AND** empty fragments between delimiters produce no chips

#### Scenario: A single value still commits as one chip

- **WHEN** the user types `31001` and presses Enter
- **THEN** exactly one chip `31001` is created
