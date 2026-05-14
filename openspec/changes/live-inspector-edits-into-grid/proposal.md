## Why

When the user edits a field in the single-row inspector panel, the data grid does NOT update in real time. For text, numeric, and JSON/long-text fields, the inspector only writes to the edit buffer on `onBlur` (`Inspector.tsx:923` for textarea, `Inspector.tsx:969` for text input). Until the user clicks away or tabs out, the grid still shows the server value with no dirty marker — so the inspector feels disconnected from the grid. Boolean and enum selects already commit on `onChange`, which is the correct behavior; the gap is text-shaped inputs. The user wants the inspector to behave "como si hubieras editado uno a uno" — i.e., every keystroke in the inspector should visually reflect in the corresponding grid cell, exactly as if the user had double-clicked the cell, typed, and committed.

## What Changes

- **Single-row inspector text inputs commit live.** The text `<input>` in `InspectorEditableField` commits to the edit buffer on every `onChange`, not on `onBlur`. The grid's dirty marker and display value update as the user types.
- **Single-row inspector long-text / JSON textarea commits live.** The `<textarea>` (used for JSON/JSONB columns and for plain-text values longer than 100 chars) also commits on every `onChange`. JSON validation still happens on `onBlur` only (parse strictness must not block typing); during typing the buffer holds the raw string and the field renders no error. The existing validate-on-commit (Cmd-S) path remains the authoritative gatekeeper for invalid JSON.
- **Numeric coercion happens on every keystroke too.** For numeric columns, the inspector parses the input on every change with the same `Number(text)` / `Number.isFinite` rules used today on blur; partial input like `"-"` or `"3."` falls back to a string in the buffer (the existing tolerant behavior of `parseInputValue`).
- **Bulk-edit inspector is OUT OF SCOPE.** The bulk inspector keeps its Apply/Cancel gate. The `postgres-data-edit` capability requirement "Bulk-edit mode in the inspector when multiple rows are selected" is not modified.
- **No new keystroke debounce.** Buffer writes happen synchronously per keystroke. The edit buffer reducer already deduplicates (a same-value re-edit is a no-op, and an edit equal to the original collapses out of the buffer), so a typing burst settles cleanly without bloating the undo stack with N entries — but the undo stack DOES gain one entry per keystroke. This is the same cost the in-grid inline editor pays today when the user types and presses Enter (one entry per commit), shifted to per-keystroke. Acceptable for V1; revisit if undo feels noisy.

## Capabilities

### New Capabilities
<!-- None -->

### Modified Capabilities
- `postgres-data-grid`: the `Inspector panel` requirement is updated to specify that single-row inspector edits commit to the buffer on every change for ALL editable field types (not just boolean / enum). Adds scenarios covering live-update of the grid as the user types in a text or JSON field.

## Impact

- **Code:**
  - `src/modules/postgres/data/Inspector.tsx` — `InspectorEditableField` text input (line ~961–983) moves the commit from `onBlur` to `onChange`; long-text/JSON textarea (line ~905–958) does the same for the raw value (validation stays on blur); numeric inputs share the same `onChange` path with tolerant parsing.
  - No backend changes. No reducer changes (`setCellEdit` already handles per-keystroke dispatch correctly).
  - The existing `lastSyncedValueRef` re-sync `useEffect` (Inspector.tsx:857–863) continues to work: it pulls external buffer updates back into local `text` state when something else (the in-grid editor or undo) changes the cell's value.
- **Specs:** `openspec/specs/postgres-data-grid/spec.md` — `Inspector panel` requirement modified; new scenarios added.
- **Tests:** No automated coverage exists for the inspector's text-input commit flow. Manual QA covers it. Existing `__tests__/Inspector.test.tsx` should still pass — verify.
- **No dependency changes.**
- **Undo stack behavior:** typing a 10-character value generates 10 `set-cell-prev` undo entries instead of 1. Pressing `Cmd-Z` 10 times now walks back the string character-by-character. This is acceptable for V1 and matches no-other-data-grid that we've seen; if the user reports it as noisy we can collapse contiguous same-cell edits in a follow-up.
