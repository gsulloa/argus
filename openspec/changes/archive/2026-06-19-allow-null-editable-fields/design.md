## Context

Argus's relational data viewers (Postgres, MySQL, MSSQL) let users edit cell values inline in the grid and via a right-hand Inspector panel. Edits accumulate in a frontend edit buffer and flush to the DB via the engine's `*_apply_table_edits` command, which binds each value as a typed parameter. A `null` value already flows end-to-end: `bind_edit_value` in each engine maps `JsonValue::Null` to a typed `Option::<T>::None`, so writing `NULL` works the moment the frontend puts `null` in the buffer.

The gap is entirely in the **Postgres frontend**. In `EditableCell.tsx`, `CellEditor` keeps a `nullToggle` boolean, but it is only ever set to `true` inside the boolean `<select>` branch (and enums use an empty-string `(NULL)` option). The three remaining editor branches — plain text `<input>`, long-text/JSON `<textarea>`, and the numeric `<input>` — never expose a way to set it. So:

- `text`/`varchar`: clearing the field commits `""`, never `null`.
- `date`/`timestamp`/`uuid` (rendered as text inputs): no way to clear to `null` at all.
- `numeric`: empty input implicitly becomes `null`, but there is no explicit, discoverable control.
- `json`/`jsonb`: empty textarea implicitly becomes `null`, again with no explicit control.

The Postgres `Inspector` (`InspectorEditableField` single-row, `InspectorBulkField` bulk) has the same omission for these field types.

The MySQL and MSSQL editors already solved this: their `TextEditor` renders a `nullable && <button title="Set NULL">NULL</button>` toggle that flips an `isNull` state, disables the input, and commits `null`. This change ports that solved pattern to Postgres.

## Goals / Non-Goals

**Goals:**

- A user can explicitly assign `NULL` to any nullable `text`, `date`, `timestamp`, `numeric`, `uuid`, `json`, or `jsonb` column from the Postgres inline grid editor.
- The same is possible from the Postgres Inspector (single-row live-commit and bulk-edit modes).
- The empty string `""` and `NULL` remain distinct for `text`/`varchar` columns.
- The affordance is gated on `column.is_nullable === true`, consistent with the existing boolean/enum NULL options.
- Visual and interaction parity with the MySQL/MSSQL "Set NULL" toggle; no new `DESIGN.md` tokens.

**Non-Goals:**

- No changes to MySQL, MSSQL, DynamoDB, or Athena editors (MySQL/MSSQL already have the toggle; DynamoDB/Athena editing is out of scope of this bug).
- No backend changes — `bind_edit_value` and the edit-SQL builders already handle `JsonValue::Null`.
- No change to boolean/enum NULL handling (already correct via their selects).
- No change to the bulk-inspector Apply/Cancel gate or the single-row live-commit timing rules; the NULL toggle plugs into those existing flows.

## Decisions

### Decision: Reuse the MySQL/MSSQL "Set NULL" toggle-button pattern in Postgres

The MySQL/MSSQL `TextEditor` shows a small `NULL` button beside nullable inputs that toggles an `isNull` state; while active the input is disabled, rendered with a muted/`--accent` treatment, and `commit` sends `null`. Postgres already has the `nullToggle` state — the work is wiring a control to it and applying the same disabled/active styling.

- **Why:** Three relational engines should behave identically; the pattern is already shipped and tested for two of them. Porting it minimizes design surface and review risk.
- **Alternatives considered:**
  - A keyboard-only shortcut (e.g. `Cmd+Backspace`) to set NULL. Rejected as a primary affordance: not discoverable, and inconsistent with MySQL/MSSQL which use a visible button. (A shortcut could be added later as an accelerator on top of the button.)
  - Treating empty `text` input as `null` (like numeric does). Rejected: it destroys the empty-string vs NULL distinction the issue explicitly calls out.

### Decision: Apply the toggle to the text input, textarea, and numeric branches only

The boolean and enum branches already commit `null` correctly through their `<select>` options, so they are untouched. The toggle is added to the three `CellEditor` branches that lack it (plain text input, long-text/JSON textarea, numeric input) and to the equivalent Inspector field branches.

- **Why:** Smallest change that closes the gap without disturbing working paths.

### Decision: NULL toggle drives the existing commit path; empty string stays distinct

When `nullToggle` (Postgres) / `isNull` is active, `commit` sends `null` regardless of the text buffer; the input is disabled to signal the value is now NULL, not editable text. Any subsequent keystroke (or clicking the toggle off) clears `nullToggle`, re-enabling the input with its prior text. For `text`/`varchar` an empty, non-null input continues to commit `""`.

- **Why:** Mirrors MySQL/MSSQL exactly and keeps `""` ≠ `NULL`. The JSON/numeric implicit-empty-to-null behaviors are left as-is so existing scenarios don't regress; the explicit toggle is an additional, unambiguous path.

### Decision: Inspector reuses the same control within its existing commit semantics

In single-row mode the toggle commits `null` to the buffer immediately (per the live-commit rule). In bulk-edit mode the toggle sets the field's pending value to `null` within the touched/pristine model, applied on Apply (per the existing bulk gate). PK columns and truncated/binary cells remain read-only and never show the toggle.

- **Why:** The Inspector is an equal editing surface; a user clearing `delivery_date` may use either. Plugging into existing semantics avoids new timing rules.

## Risks / Trade-offs

- **[Adding a button changes the editor's layout/width inside a narrow grid cell]** → Match the MySQL/MSSQL flex layout (`input { flex: 1 }` + small fixed-width button); the button is compact and only renders for nullable columns. Verify against the grid's effective cell width during QA.
- **[Users may confuse an empty text field with NULL]** → The NULL state visually differs (disabled input, active `NULL` button, `NULL` shown in the grid cell with the dirty marker), so the two states are distinguishable; this is the same affordance MySQL/MSSQL users already rely on.
- **[Inspector live-commit vs bulk-apply divergence]** → The toggle does not introduce a new code path for timing; it sets the same value the existing onChange/Apply logic already commits, so the established scenarios continue to govern.
- **[Postgres editor and MySQL/MSSQL editors drift over time]** → Mitigated by deliberately mirroring the existing implementation; a shared component is out of scope but noted as a future cleanup.

## Open Questions

- Should a `Cmd+Backspace` (or similar) keyboard accelerator be added on top of the button for parity-plus? Defaulting to **no** for this change to stay scoped to the reported bug and to MySQL/MSSQL parity; can be a follow-up.
