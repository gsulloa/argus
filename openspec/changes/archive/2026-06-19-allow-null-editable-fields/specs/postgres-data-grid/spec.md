## ADDED Requirements

### Requirement: Explicit NULL assignment for nullable non-select columns

The Postgres data viewer SHALL let the user explicitly assign `NULL` to a nullable column that is edited through a free-form editor — a plain text `<input>`, a long-text / JSON-or-JSONB `<textarea>`, or a numeric `<input>` — in both the inline grid cell editor (`CellEditor`) and the Inspector panel editable fields. The committed value MUST be a JSON `null`, carried into the edit buffer exactly like any other edited value and bound by the backend as a typed SQL `NULL` (no new backend path is introduced).

The NULL affordance MUST be a visible control (a `NULL` toggle button, matching the MySQL/MSSQL editors' pattern and using existing `DESIGN.md` tokens — no new tokens). The control MUST be rendered ONLY when the column's `is_nullable` is `true`, consistent with the existing boolean/enum NULL options. When the control is active:

- the free-form input MUST be visually marked as holding `NULL` (e.g. disabled input with a muted treatment and the toggle shown in its active state), and
- committing the editor (Enter / Tab / blur for the grid editor, or the live-commit / Apply path for the Inspector) MUST write `null` to the buffer regardless of any prior typed text.

When the control is inactive, committing follows the existing rules for that column type. In particular, the empty string `""` and `NULL` MUST remain distinct values for `text` / `varchar` columns: an empty, non-NULL text input MUST commit `""`, never `null`. Toggling the control off (or typing into the input) MUST clear the NULL state and restore normal editing.

Boolean and enum columns are NOT affected by this requirement — they already expose a NULL choice through their `<select>` options.

This requirement does NOT alter the Inspector's single-row live-commit timing rules or the bulk-edit Apply/Cancel gate; the NULL control plugs into whichever commit flow is already in force. PK columns of existing rows and truncated/binary cells MUST NOT render the control (they remain read-only).

#### Scenario: Setting a nullable date cell to NULL in the inline grid editor

- **WHEN** the user opens the inline editor on a nullable `date` column such as `delivery_date` (rendered as a text input) and activates the `NULL` toggle, then commits
- **THEN** the buffer records `null` for that cell
- **AND** the grid cell re-renders showing `NULL` with the dirty marker
- **AND** flushing the buffer issues an `UPDATE` that sets the column to SQL `NULL`

#### Scenario: NULL toggle is hidden for non-nullable columns

- **WHEN** the user opens the inline editor on a `NOT NULL` `text` column
- **THEN** no `NULL` toggle is rendered
- **AND** the editor behaves exactly as before this change

#### Scenario: Empty text input stays an empty string, not NULL

- **WHEN** the user opens the inline editor on a nullable `text` column, clears the field to `""`, leaves the `NULL` toggle inactive, and commits
- **THEN** the buffer records the empty string `""` (not `null`)
- **AND** the grid cell shows an empty value rather than `NULL`

#### Scenario: Toggling NULL on then off restores the typed text

- **WHEN** the user has typed `hello` into a nullable `text` editor, activates the `NULL` toggle (the input becomes disabled and shows the NULL state), then deactivates the toggle
- **THEN** the input is re-enabled showing `hello`
- **AND** committing records `hello` in the buffer

#### Scenario: Setting a nullable text field to NULL from the single-row Inspector

- **WHEN** the user selects a single row and activates the `NULL` toggle on a nullable `text` field in the Inspector
- **THEN** the buffer immediately records `null` for that cell (per the single-row live-commit rule)
- **AND** the corresponding grid cell re-renders showing `NULL` with the dirty marker
- **AND** no SQL is dispatched until the user runs `⌘S`

#### Scenario: Setting a column to NULL for many rows from the bulk Inspector

- **WHEN** the user selects 2 or more rows and activates the `NULL` toggle on a nullable column field in the bulk Inspector, then clicks Apply
- **THEN** the buffer records `null` for that column on every selected row
- **AND** the Apply/Cancel gate behavior from the `postgres-data-edit` capability is unchanged (nothing is committed until Apply)

#### Scenario: NULL control is absent on read-only fields

- **WHEN** the Inspector renders a PK field of an existing row, or a truncated/binary cell
- **THEN** no `NULL` toggle is rendered and the field remains read-only
