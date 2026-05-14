## 1. Inspector.tsx: live commit for single-row text input

- [x] 1.1 Open `src/modules/postgres/data/Inspector.tsx` and locate `InspectorEditableField`'s text `<input>` at the bottom of the function (currently lines ~961–983).
- [x] 1.2 In the `<input>`'s `onChange` handler (currently `(e) => setText(e.target.value)`), additionally compute the parsed value using the same logic currently inside `onBlur` (numeric coercion via `Number(text)` with `Number.isFinite`; empty string → `null`; non-numeric columns → raw text). Dispatch the parsed value via `onChange(...)` (the prop) immediately. Keep `setText(e.target.value)` so the input's local mirror still tracks the raw typed text.
- [x] 1.3 Remove the `onBlur` handler from the text `<input>` entirely (it no longer needs to commit on blur). If keeping `onBlur` for some future hook is desirable, leave it as a no-op — but prefer removing the prop to keep the surface clean.
- [x] 1.4 Verify the existing `lastSyncedValueRef` `useEffect` (Inspector.tsx:857–863) still works as described in design.md Decision 4 — no code change required.

## 2. Inspector.tsx: live commit for single-row long-text / JSON textarea

- [x] 2.1 Locate the `<textarea>` inside `InspectorEditableField` (currently lines ~915–947).
- [x] 2.2 Inside the `onChange` handler (currently `(e) => { setText(e.target.value); setJsonError(null); setJsonWarning(false); }`), additionally call `onChange(e.target.value)` (the prop) to commit the raw text to the buffer per keystroke. Do NOT run `validateJsonInput` here — it stays in `onBlur` for the UI-error-only surface.
- [x] 2.3 Modify the existing `onBlur` handler so it ONLY runs the JSON validation for the inline error / smart-quote-warning UI. Do NOT call `onChange(...)` again from `onBlur` (the value is already committed; calling again is a redundant no-op but adds noise to the undo stack). The blur path:
  - For non-JSON columns: no-op (delete the `onChange(text)` call that's there today).
  - For JSON columns: run `validateJsonInput(text)`; on failure, `setJsonError(result.error)`. On success, `setJsonError(null); setJsonWarning(hasSmartQuotes(result.canonical))`. Do NOT call the parent `onChange` (raw text is already in the buffer).

## 3. Verification

- [x] 3.1 Run `bun run typecheck`. Resolve any type errors. Expected: clean.
- [x] 3.2 Run `bun run test:run`. The existing `__tests__/Inspector.test.tsx` and surrounding suites should pass unchanged. The pre-existing Dynamo `CacheProvider` flake is unrelated.
  - Note: 3 existing JSONB blur-commit tests were updated to match the new per-change live-commit semantics; the OLD assertions described behavior that this change deliberately removes (no canonicalize-on-blur, no empty→null coercion in JSON textarea). All 8 Inspector tests now pass.
- [ ] 3.3 Manual QA — single-row, text field:
  - Select a row with a `text` column.
  - Type into the inspector's text field for that column.
  - Confirm the grid cell renders with the dirty marker and the cumulative display value on every keystroke.
  - Confirm the inspector input retains focus and the cursor position throughout typing.
- [ ] 3.4 Manual QA — single-row, numeric field:
  - Select a row with a `numeric` / `int4` / `int8` column.
  - Type `3.14` character-by-character.
  - Confirm `3` and `3.14` show as the dirty display value; `3.` displays as a string mid-typing (tolerant parse).
  - Clear the field; confirm the grid shows `NULL` with the dirty marker.
- [ ] 3.5 Manual QA — single-row, JSON / JSONB field:
  - Select a row with a `jsonb` column.
  - Type `{"a":1}` character-by-character.
  - Confirm each intermediate value (`{`, `{"`, `{"a`, …) appears as the dirty display value in the grid.
  - Confirm the inspector textarea does NOT render an inline JSON error during typing.
  - Tab out / blur with mid-typed invalid JSON (e.g. `{"a":`).
  - Confirm the inspector now renders the inline JSON error (red border + error text) but the grid cell still shows the dirty raw text.
- [ ] 3.6 Manual QA — revert to original cleans the buffer:
  - Select a row, type 5 characters in a text field, then backspace all 5.
  - Confirm the grid cell no longer renders the dirty marker after the final backspace.
- [ ] 3.7 Manual QA — external re-sync still works:
  - Select row 5. In a different cell of row 5, open the in-grid inline editor, type a new value, and press Enter.
  - Confirm the inspector's field for that cell updates to show the new value.
- [ ] 3.8 Manual QA — bulk-edit unchanged:
  - Select 3+ eligible rows.
  - Confirm the inspector enters bulk mode with the Apply/Cancel footer.
  - Type in a bulk field; confirm the grid does NOT show dirty markers on the affected rows until `Apply to <N> rows` is clicked.

## 4. Spec sync and change ready for review

- [x] 4.1 Re-run `openspec status --change "live-inspector-edits-into-grid"` and confirm all artifacts are `done`.
- [x] 4.2 Re-run `openspec validate live-inspector-edits-into-grid` and resolve any structural lint errors.
- [ ] 4.3 Once user-tested and approved, archive the change with `openspec archive live-inspector-edits-into-grid` so the modified `Inspector panel` requirement merges into `openspec/specs/postgres-data-grid/spec.md`.
