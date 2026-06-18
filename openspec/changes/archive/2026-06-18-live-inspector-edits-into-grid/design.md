## Context

The inspector panel (`src/modules/postgres/data/Inspector.tsx`) shares a single edit buffer (`UseEditBufferResult` from `useEditBuffer.ts`) with the data grid. When the user edits a cell in the grid, the buffer's `setCellEdit` is dispatched; the grid re-renders showing the new value with a dirty highlight. The inspector mirrors the same buffer: `displayValue = editsEntry?.changes[col.name] ?? serverValue` (Inspector.tsx:118–121) and `dirty = buffer.isCellDirty(rowKey, col.name)` (Inspector.tsx:114).

For boolean and enum fields, the inspector dispatches `onChange` (line ~877 and ~893) on every change, so the buffer — and thus the grid — updates immediately as the user picks an option. For text, textarea (JSON / long-text), and numeric fields, the inspector keeps a local `text` state and only dispatches `onChange` on `onBlur` (line ~923, ~970). This blur-only commit is the source of the visual lag: the user types in the inspector, the inspector's input shows the typed value live (local state), but the grid still shows the server value with no dirty marker until the user moves focus away.

The user's request is to make the inspector's text-shaped inputs behave the same way as the boolean/enum selects: commit on every change so the grid mirrors the inspector live.

## Goals / Non-Goals

**Goals:**
- A keystroke in the inspector's single-row text input, numeric input, or long-text/JSON textarea immediately updates the corresponding grid cell's display value and dirty marker.
- The existing `lastSyncedValueRef` re-sync path continues to work, so external buffer changes (in-grid editor, undo) still flow back into the inspector's local `text` state.
- The JSON strict-parse validation (`validateJsonInput`) is preserved as a commit-time gate on Cmd-S; it does NOT block typing in the inspector.
- The bulk inspector keeps its Apply/Cancel gate unchanged. Its current per-field `touched` state and the existing requirement in `postgres-data-edit` remain authoritative for multi-row edits.

**Non-Goals:**
- Adding a debounce. We commit synchronously per keystroke; the reducer absorbs the cost.
- Collapsing contiguous undo entries on the same cell. Each keystroke gets its own undo entry in V1; an optional collapse pass can be a follow-up.
- Changing the bulk inspector workflow.
- Changing the in-grid inline editor (it already commits on Enter / Tab / blur which is the right behavior for that surface).
- Changing the `postgres-data-edit` capability or any reducer.

## Decisions

### Decision 1: Move text-input commit from `onBlur` to `onChange`

**Choice:** In `InspectorEditableField`, the text `<input>` (line ~961–983) and the long-text/JSON `<textarea>` (line ~905–958) call `onChange(...)` (the prop, which invokes `buffer.setCellEdit`) inside their `onChange` handler, not inside `onBlur`. For the text input, the numeric coercion logic currently inside `onBlur` (line ~970–981) is moved into the `onChange` handler so the buffer receives the typed primitive immediately. For the textarea, the raw `text` is dispatched live; JSON validation moves to `onBlur` only as a UI-error indicator (it still does NOT commit a different value — the raw text is what's in the buffer).

**Why over alternatives:**
- *Alternative A: keep onBlur and add a manual "preview" overlay in the grid that listens to the inspector's local state.* Complex; introduces a second source of truth.
- *Alternative B: debounce the onChange commit by ~50ms.* Adds latency for no clear benefit. The reducer is O(1) per dispatch; React reconciliation of the grid's virtualized rows is also fast (only the active row re-renders meaningfully). Rejected.
- *Alternative C: commit on `onChange` but only after the user has typed at least 1 character distinct from the original.* Would prevent an "edit then immediately revert" from leaving a buffer entry, but the reducer already collapses an edit equal to the original via the `cellEquals(originalRow[idx], value)` check at `useEditBuffer.ts:158–162`. So the buffer self-cleans. No extra logic needed. Rejected (already covered).

### Decision 2: JSON textarea — commit raw text live, validate on blur

**Choice:** The JSON/JSONB textarea commits the raw `text` string to the buffer on every change (so the grid shows the dirty marker as the user types). The strict-parse `validateJsonInput` runs only on `onBlur` and only to set `jsonError` / `jsonWarning` UI state — it does NOT re-dispatch a different value, and it does NOT block the commit. The Cmd-S apply path runs the same strict-parse before flushing to Postgres, so an invalid JSON cell never reaches the database.

**Why:** A user typing `{"foo": ` (mid-typing, invalid JSON) should still see the grid update. Blocking the commit during typing would defeat the purpose of live preview. The strict-parse runs at two layers: (a) inline error feedback on blur, (b) atomic gate at save time. Both already exist and are untouched.

**Trade-off:** an unsaved invalid JSON value sits in the buffer while the user types. If they navigate away without fixing it, Cmd-S fails with a per-cell error (existing UX). The grid's dirty marker is technically pointing at invalid JSON; we accept this — it's the same state the user would reach by typing invalid JSON in the in-grid editor and pressing Enter (which today shows the error inline and keeps the editor open). The inspector path now reaches the same state via a different door.

### Decision 3: Numeric coercion happens in `onChange`, not `onBlur`

**Choice:** Move the `Number(text)` / `Number.isFinite` parsing currently at `Inspector.tsx:970–981` into the text input's `onChange` handler. Partial values like `"-"`, `"3."`, `"3.1e"` are kept as strings (the existing tolerant behavior); only fully-parseable numerics coerce to `number`. Empty string still resolves to `null` (NULL).

**Why:** The grid renders `cellMono` for numeric columns based on the column type, not the value type. A transient string in a numeric column displays as `"3."` (the raw text) until the user finishes typing — which is the same visual as the in-grid editor today. The buffer accepts either; the apply-time validation in `postgres_apply_table_edits` is what eventually rejects an unparseable value.

### Decision 4: `lastSyncedValueRef` keeps working

**Choice:** No change to the existing re-sync `useEffect` at Inspector.tsx:857–863. It compares the incoming `value` prop (which now updates per-keystroke from the buffer) against the last value the field saw. If the user is the one driving the change, the `value` prop and the local `text` state evolve together — the effect's `Object.is(value, lastSyncedValueRef.current)` returns true (same reference) and skips the resync. The effect only kicks in when an EXTERNAL change (in-grid editor, undo) lands on the same cell.

**Why we need to verify this empirically:** With per-keystroke commits, `value` now changes on every keystroke. The `useEffect` re-runs on every keystroke. We need to confirm:
1. `lastSyncedValueRef.current` gets updated inside the effect (it does — line 861).
2. The effect's branch correctly identifies "user-driven" vs "external" changes. The current logic: if `value !== lastSyncedValueRef.current`, sync. Since the effect updates `lastSyncedValueRef.current` immediately after a sync, the next render's `value` (still the same buffer value) won't trigger another sync. **But:** when the user types, `text` is updated by the input's onChange BEFORE the parent's render lands the new `value` prop. So the order is: type → setText(t) → parent renders with new `value` → effect runs → `Object.is(value, lastSyncedValueRef.current)` is false → calls `setText(valueToText(value))` → no-op because `text` is already equal → `lastSyncedValueRef.current = value`. This is a harmless extra setState that React de-dupes.

Conclusion: the existing ref logic still works under per-keystroke commits. No change.

### Decision 5: Bulk inspector untouched

**Choice:** Do not modify the bulk inspector path. Its current Apply/Cancel/touched-state workflow is specified in the `postgres-data-edit` capability (requirement: "Bulk-edit mode in the inspector when multiple rows are selected") and is intentionally Apply-gated for atomicity over N rows.

**Why:** A live-commit bulk inspector would dispatch `bulkSetCellEdit` with `M_columns × N_rows` entries on every keystroke. For a 500-row × 1-column selection that's 500 reducer entries per keystroke — fine for one keystroke, but bloats the undo stack rapidly and changes the meaning of "Cancel" (which today is a no-op on the buffer). Out of scope here; revisit only if the user asks for it.

## Risks / Trade-offs

- **[Risk] Undo stack gains one entry per keystroke.** → Mitigation: documented as a known V1 trade-off in the proposal's Impact section. Acceptable because (a) Cmd-Z still works one step at a time; (b) the reducer collapses no-op edits, so accidental over-typing doesn't pollute; (c) we can collapse contiguous same-cell edits in a follow-up if undo noise becomes a real complaint.
- **[Risk] Per-keystroke re-renders of the grid for a large virtualized list could be expensive.** → Mitigation: the grid is already virtualized (`useVirtualizer`); only the visible rows render, and within those, only the affected row's cells re-render meaningfully (other cells short-circuit on `displayValue` equality). Typing in the inspector exercises the same render path as typing in the in-grid editor and pressing Enter — already validated by existing performance. No new bottleneck.
- **[Risk] JSON typing leaves invalid JSON in the buffer mid-edit.** → Mitigation: same risk as the in-grid editor; Cmd-S validates strictly before commit. The inspector's on-blur validation surface still flags it visually.
- **[Trade-off] No unit test for the change.** The single-row inspector text path has no automated coverage. Manual QA is the verification. Existing `__tests__/Inspector.test.tsx` runs without modification — confirm.
