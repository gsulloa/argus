## Context

Argus persists edits to `jsonb` (and `json`) columns through this chain:

1. User double-clicks a cell → `EditableCell.tsx` mounts a `<textarea>` (line 290) with the current value pre-filled.
2. On Tab / Enter / blur, `parseInputValue` (lines 68–86) is called. For json/jsonb, the `looksLikeJson` branch (lines 81–84) returns the raw textarea string verbatim — explicit comment: `// Bind as the raw text — backend casts to json/jsonb.`
3. The string is dropped into the edit buffer via `useEditBuffer.ts`, packaged into an `EditOp::Update.changes[col]` (a `serde_json::Value::String`) and shipped via `postgres_apply_table_edits`.
4. Backend `binding.rs:350–353` binds the string as a Postgres text parameter with `PlaceholderTemplate::Plain` (no explicit cast). Postgres implicitly coerces text → `jsonb` against the column's declared type.
5. Postgres' JSON parser accepts U+201C / U+201D / U+2018 / U+2019 as ordinary string-content characters — they are not the JSON `"` delimiter, not whitespace, not control chars. The write succeeds.

The row inspector (`Inspector.tsx`, lines 168–266) is a parallel surface: same `<textarea>`, same lack of autocorrect attrs, same pass-through.

macOS' "Use smart quotes" system preference (System Settings → Keyboard → Text Input → Edit) is ON by default. WebKit (which Tauri uses on macOS) respects this preference inside `<textarea>` and `<input>` elements unless `autoCorrect="off"` is set. Result: a user typing `{"foo":"bar"}` watches it transform to `{"foo":"bar"}` in real time. Without `JSON.parse` in the commit path, that corrupted JSON ships to Postgres and is accepted.

This change closes both gaps in the frontend. No backend change is needed.

## Goals / Non-Goals

**Goals:**
- Prevent macOS Smart Quotes from silently corrupting json/jsonb input typed in Argus.
- Reject json/jsonb input that doesn't parse as JSON with a clear inline error before the edit hits the buffer or the network.
- Canonicalize accepted JSON via `JSON.parse` + `JSON.stringify` so what's stored equals what the user can `JSON.parse` back. (This also strips incidental trailing whitespace and normalizes escape sequences — a nice side effect.)
- Surface a non-blocking warning when committed JSON contains smart quotes inside string content (technically valid, but almost always unintended).
- Apply identically in the grid cell editor and the row inspector — both surfaces edit the same column types and must behave the same.

**Non-Goals:**
- Backend validation. The backend is already correct under "I trust the frontend"; doing JSON.parse server-side too would be defense-in-depth but is out of scope for this change — and would mask which surface introduced the bug.
- The SQL editor path (CodeMirror). Raw SQL text is the user's responsibility; we don't reformat it.
- Cleaning up existing corrupted data. That's a data ops task; could be a follow-up diagnostic tool, but not required for the fix.
- Rich JSON editing (tree view, schema-aware completion, etc.). Out of scope — keep the editor a simple validated textarea.
- Localizing the parse error message. JSON.parse's native error text is English-only; acceptable for V1.

## Decisions

### Apply autocorrect-off attributes only when the column is json/jsonb-shaped

We could blanket-apply `autoCorrect="off"` to all cell editors (text columns too). Rejected: text columns legitimately benefit from autocorrect for prose data, and smart quotes inside a `text` column are not corruption — they're just unicode characters the user might want. Gating on `looksLikeJson(t)` keeps the change scoped to the surface where smart quotes are damaging.

Attributes applied to the textarea when `looksLikeJson(column.data_type)`:
- `autoCorrect="off"` — disables OS auto-correction (smart quotes, dash conversion, etc.).
- `autoCapitalize="off"` — disables iOS-style capitalization (no effect on macOS but harmless and idiomatic).
- `spellCheck={false}` — disables the red-underline spellchecker (irrelevant for JSON and visually noisy).
- `autoComplete="off"` — disables browser autocomplete suggestions over the JSON editor.

These four together are the standard "treat this as code" recipe.

### JSON.parse the input on commit, re-stringify before sending

The commit path runs:

```ts
function validateJsonInput(raw: string): { ok: true; canonical: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, canonical: "" };          // empty → null upstream
  try {
    const parsed = JSON.parse(trimmed);
    return { ok: true, canonical: JSON.stringify(parsed) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

The trim handles the common case where the textarea ends in a newline. Empty trims to `""` and the caller treats it as `null` (matching existing behavior for empty input). The canonical re-stringification ensures the stored bytes are minimally normalized — same parse-and-restringify pattern most JSON-aware editors use.

**Alternative considered**: also strip smart quotes that appear outside string content. Rejected — implementing a partial JSON tokenizer to know "outside string content" is overkill; if smart quotes appear at the syntactic level, `JSON.parse` already rejects them (smart quotes are not valid JSON delimiters). The case that survives is "smart quotes inside string content," which is handled by the warning chip below.

**Alternative considered**: skip the `JSON.stringify` and ship the user's raw text after just parse-validating. Rejected for two reasons: (a) it leaves trailing whitespace and other lossless variations in the stored bytes, which makes diffing harder; (b) the canonical form is what downstream tools expect.

### Inline error UX, not a toast

On parse failure, the textarea stays mounted (does not commit, does not exit edit mode), its border becomes `var(--danger)`, and a one-line error message renders directly below it in `font-family: var(--font-mono); color: var(--danger); font-size: 11px`. Pressing Escape still cancels normally. This keeps the user in context — they can fix the JSON and re-commit without losing their work.

**Alternative considered**: commit anyway and show a toast. Rejected — silently committing invalid JSON is exactly the problem we're fixing; a transient toast is too easy to miss.

### Smart-quote warning is non-blocking

After a successful parse, run `hasSmartQuotes(canonical)` to detect U+201C, U+201D, U+2018, U+2019 anywhere in the canonical string. If true, render a small chip `⚠ Contains smart quotes` next to the textarea (still in edit mode? or after commit on the cell?). The chip is informational only — the commit proceeds.

Open question: where does the warning live visually after commit? Options: (a) only while the textarea is open (chip below it); (b) persist as a small indicator on the dirty cell. Decision: only while the textarea is open (option a). Persisting the chip on the cell adds visual noise to the grid and the user already sees the canonical value rendered in the cell — they can re-edit if they want to investigate. Revisit if users actually miss this signal.

### One shared validation module

Both `EditableCell.tsx` and `Inspector.tsx` need the same parse/canonicalize/warn logic. Extract it into `src/modules/postgres/data/jsonEditValidation.ts`:

```ts
export function validateJsonInput(raw: string): ValidateResult { ... }
export function hasSmartQuotes(s: string): boolean { ... }
```

Pure functions; trivially unit-testable in vitest. Both editors import them.

### Empty / null handling

Empty input is treated as a `null` write to the column. This matches current behavior in both surfaces (today an empty textarea returns `""` which the caller upstream coerces). After this change: an empty / whitespace-only string trims to `""` and `validateJsonInput` returns `{ ok: true, canonical: "" }`. The caller continues to interpret that as `null` (existing convention).

## Risks / Trade-offs

- **Risk**: legitimate use cases for pasting non-strict JSON (JSON5, JSONC with comments, trailing commas) will be rejected. → **Mitigation**: pragmatic stance — Argus's column type is `jsonb`, which is strict JSON. If a user wants to write non-strict JSON, they can use the SQL editor. The textarea editor is for strict JSON. If demand emerges, we can layer a JSON5 fallback parse later.

- **Risk**: very large JSON values (e.g. 200KB) get parsed twice per keystroke if we attempt live validation. → **Mitigation**: we only validate on commit (Tab / Enter / blur), not on each keystroke. Parsing a 200KB JSON value once on commit is fast (sub-millisecond) and only blocks the commit thread, not typing.

- **Risk**: the canonical form changes whitespace and key ordering inside objects. Object key order is technically not preserved by `JSON.parse` + `JSON.stringify`, though all current V8 implementations do preserve insertion order for string keys. → **Mitigation**: this is the JSON spec's "no guarantees" zone; users who care about key order are already misusing JSON. The trade is worth it for canonicalization.

- **Risk**: the smart-quote warning surfaces even when smart quotes are intentional (e.g. user is storing literary text in a `display_name` jsonb field). → **Mitigation**: the warning is non-blocking and dismissible by simply ignoring it. The signal-to-noise is good — almost every smart quote in a json/jsonb edit context is unintended autocorrect output, not deliberate.

- **Trade-off**: rejecting paste of structurally-broken JSON happens client-side now, surfaced as a JS-parser error message ("Unexpected token } in JSON at position 47"). That's terser and arguably less user-friendly than Postgres' own error ("invalid input syntax for type json"). Trade is worth it because (a) it shows immediately on commit instead of after a round-trip, (b) the cursor offset hint helps the user locate the issue, and (c) we keep the textarea open at the failure site.
