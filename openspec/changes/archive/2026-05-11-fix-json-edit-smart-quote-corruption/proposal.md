## Why

A user discovered that a `market.product.metadata` (`jsonb`) column persisted via Argus contained smart-quote characters (`"` U+201C, `"` U+201D) inside JSON string values. Postgres accepted the writes silently because smart quotes are valid characters inside JSON string content — but downstream operations that text-replace quotes (`REPLACE(metadata::text, '"', '"')::jsonb`) corrupt the JSON, and the values are obviously not what the user typed.

Two upstream gaps in Argus produced this:

1. **macOS Smart Quotes autocorrect rewrites typed `"` into `"` / `"` before React sees the input.** The grid cell editor (`src/modules/postgres/data/EditableCell.tsx:290`) and the row inspector (`src/modules/postgres/data/Inspector.tsx:233`) render the json/jsonb editor as a plain `<textarea>` with **no** `autoCorrect="off"`, `spellCheck={false}`, or `autoCapitalize="off"`. On macOS (WebKit/Tauri), the system "Smart Quotes" preference is ON by default and applies to native textareas. Typing the JSON `{"key":"value"}` literally produces `{"key":"value"}` on the wire.

2. **The frontend forwards user text to the backend without running `JSON.parse`.** `parseInputValue` in `EditableCell.tsx:81–84` has an explicit comment `// Bind as the raw text — backend casts to json/jsonb` and returns the textarea string verbatim. The backend (`src-tauri/src/modules/postgres/binding.rs:350–353`) binds the `serde_json::Value::String("…")` as a Postgres text parameter and lets Postgres implicitly coerce it to `jsonb`. Postgres' JSON parser accepts smart quotes as ordinary string-content characters, so the write succeeds even when the user clearly intended ASCII quotes.

Either fix alone is insufficient: disabling autocorrect won't help when users paste already-corrupted JSON from external sources, and `JSON.parse` alone won't reject technically-valid JSON that just happens to have autocorrected smart quotes inside string content. We need both.

## What Changes

- **Disable native autocorrect/spellcheck on the json/jsonb cell editor and row-inspector editor.** When the column's data type matches `looksLikeJson(t)` (today: `json`, `jsonb`, or anything ending in `[]` / starting with `_`), the textarea MUST render with `autoCorrect="off"`, `autoCapitalize="off"`, `spellCheck={false}`, and `autoComplete="off"`. This prevents the OS from silently rewriting characters before React sees them. Applies to both `EditableCell.tsx` and `Inspector.tsx`.
- **Validate JSON edits with `JSON.parse` before committing them to the buffer.** When the user commits a json/jsonb cell edit (Tab/Enter/blur), the frontend MUST parse the textarea contents via `JSON.parse(raw)`. If the parse succeeds, the value sent to the backend MUST be `JSON.stringify(parsed)` (canonical re-serialization — strips trailing whitespace, normalizes escapes, and crucially, surfaces obvious paste-corruption as a parse error). If the parse fails, the edit MUST be rejected with an inline validation error: the cell stays in edit mode, the textarea border turns `var(--danger)`, and a small message below the textarea reports the parse error message. Empty input is treated as `null` (existing behavior); whitespace-only input is rejected as invalid JSON.
- **Surface a non-blocking warning when the canonicalized JSON still contains smart quotes** (U+201C, U+201D, U+2018, U+2019) inside string content. Smart quotes inside string content ARE valid JSON, so we don't reject the edit — but we render a small `⚠ Contains smart quotes` chip below the textarea so the user can decide whether to fix them before committing. The warning never blocks the commit.
- **Frontend type changes**: `parseInputValue` (EditableCell.tsx) and `InspectorEditableField`'s commit path (Inspector.tsx) gain a return type that distinguishes "valid value" from "validation error" so the caller can surface inline errors instead of silently committing garbage. The wire shape of `EditOp.update.changes[col]` is unchanged — it remains a JSON-serializable value.
- **No backend changes.** The backend (`binding.rs`) continues to forward whatever string the frontend sends. The fix is intentionally upstream: by the time a value reaches `bind_edit_value`, it has been parsed-and-restringified to canonical JSON.
- **Out of scope**: the SQL editor path (CodeMirror, not a textarea — no native autocorrect). The user is responsible for the text they type in raw SQL.

## Capabilities

### New Capabilities
_None._

### Modified Capabilities

- `postgres-data-edit`: the **Editable mode in the data viewer** requirement currently says "The inline editor's input type adapts to the column's `data_type` (… monospaced textarea for long text/jsonb/array …)" without specifying any input-sanitization or validation behavior. That requirement is extended with three new sub-requirements covering: (a) disabling native autocorrect/spellcheck on the json/jsonb editor, (b) `JSON.parse` validation before commit (with the inline error UX), and (c) the smart-quote warning chip.

## Impact

- **Frontend code**:
  - `src/modules/postgres/data/EditableCell.tsx` — add the autocorrect-off attributes to the json/jsonb textarea (~lines 290–306), reshape `parseInputValue`'s json branch to return `{ ok: true, value } | { ok: false, error }`, and adjust the commit handler to render the inline error UI when `ok: false`. Add the smart-quote warning chip.
  - `src/modules/postgres/data/Inspector.tsx` — same autocorrect-off attributes on the row-inspector textarea (~lines 231–240), same parse-and-validate in `InspectorEditableField`'s onBlur (~line 237), same error UX, same smart-quote warning.
  - Possibly a small shared helper `src/modules/postgres/data/jsonEditValidation.ts` exporting `validateJsonInput(raw): { ok: true, canonical: string } | { ok: false, error: string }` and `hasSmartQuotes(s: string): boolean` so EditableCell and Inspector use the exact same logic.
- **CSS**: `EditableCell.module.css` and `Inspector.module.css` (or whatever the row inspector uses) gain `.jsonError` (border + small message under the textarea) and `.jsonWarning` (small chip) classes.
- **Tests**: vitest unit tests for `validateJsonInput` covering: valid object, valid array, valid scalar, invalid JSON (paste of HTML), whitespace-only, empty (→ null), and smart-quote-in-content (valid but flagged). Component test for `EditableCell` confirming the autocorrect attrs are present and that invalid input renders the error UI without committing. RTL test for `Inspector` mirroring the same.
- **APIs**: no Tauri command signature changes. `EditOp` payload shape unchanged.
- **Spec**: `openspec/specs/postgres-data-edit/spec.md` — the "Editable mode in the data viewer" requirement gets three new scenarios appended.
- **Dependencies**: none.
- **Risk**: low. The autocorrect attributes are purely additive. The validation is in front of an existing path that already produces server-side errors on bad input — the change is the failure happens sooner with a better message. The only behavior change for existing callers is that pasted text that was previously sent to the server and rejected with `22P02` will now be rejected client-side with the parse error instead.
- **Migration**: none. Existing corrupted data in the database is the user's to clean up (the original incident query was their attempted cleanup; with the error-surfacing fix already merged, they have the message they need to debug the data). A "Find smart quotes in jsonb columns" diagnostic tool could be a follow-up; out of scope here.
