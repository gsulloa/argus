## 1. Inline grid cell editor (EditableCell)

- [x] 1.1 In `packages/app/src/modules/postgres/data/EditableCell.tsx`, study the MySQL `TextEditor` NULL-toggle pattern (`packages/app/src/modules/mysql/data/EditableCell.tsx`, ~lines 281–350) as the reference implementation.
- [x] 1.2 Add a `NULL` toggle control to the plain text `<input>` branch of `CellEditor` (the final `return` in `EditableCell.tsx`), rendered only when `column.is_nullable`. Wire it to the existing `nullToggle` state: activating it sets `nullToggle = true`, shows the NULL state (cleared value + "NULL" placeholder + muted styling), and applies the active styling; typing or toggling off sets `nullToggle = false`. (Uses `onMouseDown` preventDefault to keep editor focus rather than `disabled`, which would steal focus and blur-commit.)
- [x] 1.3 Add the same `NULL` toggle to the long-text / JSON `<textarea>` branch (`useTextarea`) and the numeric `<input>` branch, gated on `column.is_nullable`.
- [x] 1.4 Confirm `commit()` already sends `null` when `nullToggle` is true (verified — it short-circuits before the JSON/parse paths) and that an inactive toggle preserves the empty-string-vs-NULL distinction for `text` columns.
- [x] 1.5 Style the toggle using existing `DESIGN.md` tokens, matching the MySQL/MSSQL button (compact `NULL` button, `--accent` active background, `--border` inactive). No new tokens.

## 2. Inspector panel (single-row + bulk)

- [x] 2.1 In `packages/app/src/modules/postgres/data/Inspector.tsx`, add the `NULL` toggle to `InspectorEditableField` text/numeric/JSON branches (single-row mode), gated on `column.is_nullable`. Activating it commits `null` to the buffer immediately, per the existing live-commit rule.
- [x] 2.2 Add the `NULL` toggle to `InspectorBulkField` text/numeric/JSON branches (bulk mode), gated on `column.is_nullable`. Activating it sets the field's pending value to `null` within the existing touched/pristine model, applied on Apply.
- [x] 2.3 Ensure PK fields of existing rows and truncated/binary cells never render the toggle (remain read-only). (Confirmed: editable field components are only rendered for non-read-only, non-PK, non-envelope cells; the read-only display path renders no editor.)
- [x] 2.4 Verify the toggle's active state shows `NULL` in the grid cell with the dirty marker, consistent with the inline editor. (Committing `null` to the buffer drives the existing dirty-cell `NULL` display path; covered by the single-row test asserting the `null` buffer commit.)

## 3. Tests

- [x] 3.1 Add/extend Postgres editor tests (mirroring the MySQL/MSSQL editor tests) covering: nullable date → NULL via toggle commits `null`; non-nullable column hides the toggle; empty `text` input commits `""` (not `null`); toggle on→off restores typed text. (Added to `EditableCell.test.tsx`.)
- [x] 3.2 Add Postgres Inspector tests covering: single-row NULL toggle commits `null` live; bulk NULL toggle applies `null` to all selected rows on Apply; PK/truncated fields render no toggle. (Added to `Inspector.test.tsx`.)

## 4. Verification

- [x] 4.1 Run the frontend test/lint/typecheck suite for the `app` package and confirm green. (Typecheck clean; 57 module tests pass; lint reports only the pre-existing `react-refresh/only-export-components` warning on the unchanged `looksLikeBytea` export.)
- [x] 4.2 Manually verify in the running app: edit a nullable `delivery_date` (or any nullable date/text/numeric/json) Postgres column to NULL from both the grid editor and the Inspector, save, and confirm the DB row holds SQL `NULL`. (Verified manually.)
- [x] 4.3 Run `openspec validate allow-null-editable-fields --strict` and confirm the change is valid.
