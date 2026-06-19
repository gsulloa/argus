## Why

In the Postgres data viewer, a user editing a nullable non-boolean / non-enum column — a `date` like `delivery_date`, a `text`, a `numeric`, or a `json`/`jsonb` field — has no clear way to set the value to `NULL`. The inline cell editor only offers an explicit `NULL` choice on boolean and enum columns (via their `<select>`); for the plain text / textarea / numeric editors the `nullToggle` state exists but is never reachable, so clearing a `text` field yields the empty string `""` (a different value from `NULL`) and a `date` field cannot be emptied at all. This is a Postgres-only gap: the MySQL and MSSQL editors already ship a "Set NULL" toggle button on the same field types. The backend already binds `JsonValue::Null` correctly across all engines, so this is purely a missing UI affordance.

## What Changes

- Add an explicit "Set NULL" affordance to the **Postgres inline grid cell editor** (`EditableCell` / `CellEditor`) for nullable columns that render as a plain text input, a long-text/JSON textarea, or a numeric input. Activating it marks the pending edit as `NULL`; the committed value is `null`, distinct from the empty string `""`.
- Add the same "Set NULL" affordance to the **Postgres Inspector** editable fields (single-row live-commit mode and bulk-edit mode) for the same nullable column types, so the Inspector — an equal editing surface — can also clear a value to `NULL`.
- Preserve the empty-string vs `NULL` distinction: for `text`/`varchar` columns an empty input stays `""`; only the explicit NULL action produces `null`. The existing implicit "empty numeric → null" and "empty JSON → null" behaviors are unchanged.
- The affordance MUST appear only when the column's `is_nullable` is `true` (matching the existing boolean/enum NULL-option gating).
- Match the visual pattern already shipped by the MySQL/MSSQL editors (a small `NULL` toggle button using existing `DESIGN.md` tokens), so the four relational engines behave consistently. No new design tokens.

No backend, no schema, and no cross-engine binding changes are required.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `postgres-data-grid`: the inline cell editor and the Inspector panel gain a requirement that nullable text / textarea / numeric / JSON columns expose an explicit NULL-assignment affordance and commit a true `null` (distinct from `""`) to the edit buffer.

## Impact

- **Frontend (Postgres only):**
  - `packages/app/src/modules/postgres/data/EditableCell.tsx` — `CellEditor` text input, textarea, and numeric paths.
  - `packages/app/src/modules/postgres/data/Inspector.tsx` — `InspectorEditableField` (single-row) and `InspectorBulkField` (bulk) text/numeric/JSON branches.
  - Associated CSS module(s) for the toggle styling, if a shared style is preferred over inline styles.
- **Tests:** frontend unit/interaction tests for the Postgres editor and inspector NULL paths (the MySQL/MSSQL editors already have equivalents to mirror).
- **No changes** to `src-tauri` (edit-SQL builders and `bind_edit_value` already handle `JsonValue::Null`), to the MySQL/MSSQL/DynamoDB/Athena modules, or to any spec other than `postgres-data-grid`.
