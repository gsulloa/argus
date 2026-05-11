## 1. Extract shared validation helper

- [x] 1.1 Create `src/modules/postgres/data/jsonEditValidation.ts` exporting `validateJsonInput(raw: string): { ok: true; canonical: string } | { ok: false; error: string }` per the algorithm in `design.md` (trim → empty short-circuit → `JSON.parse` → `JSON.stringify`).
- [x] 1.2 In the same module, export `hasSmartQuotes(s: string): boolean` that returns true if `s` contains any of U+201C, U+201D, U+2018, U+2019. Implementation: a single regex test, e.g. `/[“”’’]/.test(s)`.
- [x] 1.3 Add `src/modules/postgres/data/__tests__/jsonEditValidation.test.ts` (vitest) covering:
  - valid object, valid array, valid scalar (`"hello"`, `42`, `true`, `null`) → `ok: true`, canonical matches `JSON.stringify(JSON.parse(input))`.
  - empty string and whitespace-only → `ok: true`, canonical is `""`.
  - invalid JSON (missing brace, smart-quoted outer delimiters, pasted HTML) → `ok: false` with a non-empty error message.
  - smart quotes inside string content (`{"k":"a“b”c"}`) → `ok: true`, canonical preserves the smart quotes; `hasSmartQuotes` returns true on the canonical.
  - ASCII-only JSON → `hasSmartQuotes` returns false.

## 2. Grid cell editor — autocorrect-off + validation

- [x] 2.1 In `src/modules/postgres/data/EditableCell.tsx`, locate the textarea rendered for json/jsonb (~line 290 inside `CellEditor`) and add `autoCorrect="off"`, `autoCapitalize="off"`, `spellCheck={false}`, `autoComplete="off"`. Gate on `looksLikeJson(column.data_type)` so non-JSON text columns are unaffected.
- [x] 2.2 Replace the json branch of `parseInputValue` (lines 81–84) with a call to `validateJsonInput`. Reshape the function's return type to surface validation errors — concretely, change the call site in `CellEditor`'s commit path to:
  - On `ok: true`: send the canonical string to `onCommit` (or `null` if `canonical === ""`).
  - On `ok: false`: do NOT call `onCommit`; instead set local state `setJsonError(result.error)` so the textarea stays open.
- [x] 2.3 Add a `jsonError: string | null` local state in the cell editor. When non-null, render an inline `<div className={styles.jsonError}>` below the textarea showing the error message, and apply `styles.jsonErrorBorder` to the textarea. Clear `jsonError` on every keystroke (so the user sees fresh state as they edit).
- [x] 2.4 Add a `jsonWarning: boolean` local state. After a successful `validateJsonInput` (but before commit happens via Tab/Enter/blur), compute `hasSmartQuotes(canonical)` and set the state. Render the warning chip `⚠ Contains smart quotes` below the textarea when true. Reset on every keystroke.
- [x] 2.5 Add the corresponding CSS classes to `EditableCell.module.css`:
  - `.jsonErrorBorder { border-color: var(--danger); }`
  - `.jsonError { font-family: var(--font-mono); color: var(--danger); font-size: 11px; padding-top: 4px; }`
  - `.jsonWarning { display: inline-flex; gap: 4px; align-items: center; font-size: 11px; color: var(--warning); padding-top: 4px; }`
- [x] 2.6 Verify Escape still cancels cleanly regardless of `jsonError` state (no stale error state leaks across edit sessions).

## 3. Row inspector — autocorrect-off + validation

- [x] 3.1 In `src/modules/postgres/data/Inspector.tsx`, locate the textarea for json/jsonb in `InspectorEditableField` (~lines 231–240) and add the same four attributes (`autoCorrect`, `autoCapitalize`, `spellCheck`, `autoComplete`). Gate on the same `looksLikeJson` predicate.
- [x] 3.2 Replace the onBlur (~line 237) for json/jsonb fields with the `validateJsonInput` flow: on `ok: true`, call `onChange(canonical || null)`; on `ok: false`, set local `jsonError` state and keep the field open with the danger-border UI.
- [x] 3.3 Add the same `jsonError` and `jsonWarning` local state and rendering as task 2.3 / 2.4. If `Inspector.module.css` already exists, mirror the three classes from task 2.5 into it; otherwise reuse a shared `jsonEdit.module.css` imported by both surfaces.
- [x] 3.4 Confirm the row inspector also handles the empty → null case identically (no parse, no error, just commit `null`).

## 4. Component tests

- [x] 4.1 Add a vitest + React Testing Library test for `EditableCell` covering: (a) autocorrect attrs are present on the json/jsonb textarea; (b) committing invalid JSON keeps the cell in edit mode with the error message visible; (c) committing valid JSON exits edit mode and `onCommit` receives the canonical string; (d) pasting smart-quote JSON shows the warning chip and still commits on Tab.
- [x] 4.2 Add the mirror test for `Inspector` covering the same four cases.
- [x] 4.3 Run `pnpm test` (or whichever the project uses) and confirm the new tests pass alongside the existing suite.

## 5. Manual verification in the dev app

- [ ] 5.1 Run `pnpm tauri dev` on macOS with system "Smart Quotes" preference ON (System Settings → Keyboard → Text Input → Edit → Use smart quotes).
- [ ] 5.2 Open a table with a `jsonb` column, double-click a cell, type `{"foo":"bar"}` from the keyboard, and confirm the textarea shows ASCII `"` characters throughout — no autocorrect to `"` / `"`.
- [ ] 5.3 Paste `{"foo":"bar"}` (with smart quotes as the outer delimiters — copy from the proposal's "Why" section). Press Tab. Confirm the cell stays in edit mode with a `var(--danger)` border and a JSON.parse error message under the textarea.
- [ ] 5.4 Paste `{"name":"John "Doe" Smith"}` (with smart quotes inside the string content — valid JSON). Confirm the warning chip `⚠ Contains smart quotes` appears below the textarea before commit, then pressing Tab commits the canonical value and exits edit mode.
- [ ] 5.5 Repeat 5.2–5.4 in the row inspector instead of the grid cell.
- [ ] 5.6 Commit a buffer of mixed edits (one valid json edit, one invalid that's been corrected, one untouched cell) via the Apply button and confirm the backend write succeeds with the canonical JSON in Postgres.

## 6. Ship

- [ ] 6.1 Capture before/after screenshots of: (a) the grid cell editor with smart-quote autocorrect happening in real time on `master`; (b) the same input on this branch with autocorrect off; (c) the inline error UI on invalid paste; (d) the smart-quote warning chip on valid-but-smart-quoted paste.
- [ ] 6.2 Open a PR against `origin/gsulloa/beta-release` titled `Fix smart-quote corruption in json/jsonb cell edits`. Body: short summary, the screenshots from 6.1, and a checklist mirroring the scenarios in `specs/postgres-data-edit/spec.md`.
