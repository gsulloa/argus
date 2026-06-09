## Context

Each engine ships its own data viewer with its own `⌘S` wiring (issue #88):

- **Postgres** (`TableViewerTab.tsx` ~L473–563): `window.addEventListener("keydown", …)` inside a `useEffect` gated on `active`; before saving it checks `root.contains(document.activeElement)`. On `⌘S` it calls `onSave()`, which applies the dirty `EditOp[]` buffer in one `applyTableEdits` call.
- **MySQL** (`TableViewerTab.tsx` ~L318–365) and **MSSQL** (`TableViewerTab.tsx` ~L356–407): `onKeyDown={handleKeyDown}` on the root `div`. On `⌘S` they call `handleApply()` (same batch-buffer model). No `active` gate on the save branch, and the synthetic handler only fires when focus is inside the `div` subtree.
- **DynamoDB** (`DataViewTab.tsx` ~L813–866): no `⌘S`. Cell edits commit immediately via `handleCommitCell` → `dynamoUpdateItem` (no batch buffer). State `editingCell` tracks the open inline editor; `inspectorIsEditing` tracks the inspector JSON editor, which already maps `⌘S` → Save when focused inside it. The tab already uses `window`-level `⌘F` and a `useShortcuts` hook for `⌘R` / `⌘N`.

The user-visible bug: with the `onKeyDown` engines, pressing `⌘S` after clicking away from the grid (focus on `body`, a toolbar button, or an inspector input outside the `div`) does nothing, so dirty edits appear to silently not save.

## Goals / Non-Goals

**Goals:**
- `⌘S` saves the dirty buffer in Postgres, MySQL, and MSSQL whenever the data tab is active, independent of where focus sits inside the tab (including when nothing is focused).
- Uniform `⌘S` detection mechanism across the three SQL engines.
- DynamoDB has a defined, predictable `⌘S`: commit the open inline cell editor; preserve the inspector editor's `⌘S` → Save; no-op otherwise.
- Preserve all existing behavior: no-op when clean, read-only disables edits, error banners, `origin: "user"`.

**Non-Goals:**
- No batch-edit / dirty-buffer model for DynamoDB (saves stay immediate).
- No changes to Rust commands, the `EditOp` payload, or `origin` semantics.
- No new global/app-level shortcut registry; this stays per-viewer.
- Athena is read-only — out of scope.

## Decisions

### D1: All three SQL viewers use one `window`-level, active-gated `⌘S` listener

Adopt the Postgres mechanism for MySQL and MSSQL: register `keydown` on `window` inside a `useEffect` gated on `active`, remove the `⌘S` branch from the root-`div` `onKeyDown`. Rationale: a `window` listener fires regardless of focus, so parking focus on a toolbar control or `body` no longer swallows the save; gating on `active` prevents an inactive/background tab from hijacking `⌘S`. The non-save branches of `handleKeyDown` (Backspace delete, `⌘Z` undo, `⌘R` reload) stay on the `div` since they are intentionally focus-scoped to grid interaction.

Alternative considered — keep `onKeyDown` and just add an `active` check: rejected, because it does not fix the core complaint (focus outside the `div` still blocks the save).

### D2: Focus rule must not block the save

The Postgres focus guard `root.contains(document.activeElement)` returns false when `document.activeElement` is `body` (nothing focused) — a real "click empty space then `⌘S`" case. The unified rule is: when the tab is `active`, allow `⌘S` to save **unless** focus is in an element that legitimately owns `⌘S` for its own purpose (today: a CodeMirror editor inside the tab, matched by `.cm-editor`, mirroring the existing `⌘F`/`⌘R` guards). Concretely: save when `active` AND focus is `null`/`body` OR within the tab root, AND the focused element is not inside a `.cm-editor`. This is the single rule all three SQL viewers share.

Alternative considered — save unconditionally when `active`: rejected, it would steal `⌘S` from embedded editors (e.g. a SQL/CodeMirror surface) that may define their own save.

### D3: Optional shared helper for the SQL `⌘S` listener

Factor the listener into a small hook (e.g. `useSaveShortcut({ active, rootRef, onSave })`) so the three viewers share one implementation and the focus rule lives in one place. Rationale: prevents the three copies from drifting again (the original cause of this bug). This is an implementation convenience, not a requirement — the specs describe behavior, not the hook.

### D4: DynamoDB `⌘S` commits the active inline editor, handled inside the editor

Because Dynamo has no batch buffer, "save the buffer" has no meaning; `⌘S` means "commit what I'm editing". Crucially, the uncommitted draft lives **inside** the `InlineCellEditor` (`SEditor`/`NEditor` hold local `draft` state) — a `window`-level listener in `DataViewTab` cannot reconstruct that value without an imperative handle. So `⌘S` is handled where the draft is: the `S` and `N` editors treat `⌘S` exactly like `Enter`/`Tab` (commit current draft via their existing `onCommit` → `handleCommitCell` → `dynamo.update_item`, with `N` still gated by the finite-number check). `BOOL`/`NULL` commit on click and need no `⌘S`. The inspector JSON editor already maps `⌘S` → Save and is left untouched. When nothing is being edited, `⌘S` has no dedicated handler (no-op). Rationale: faithful, minimal, and reuses the exact commit path users already get from `Enter`.

Alternatives considered — (a) a `window` listener in `DataViewTab` calling an imperative `commit()` exposed by the editor: rejected as unnecessary plumbing when the editor already owns its keydown; (b) strict no-op for Dynamo: rejected; it fails issue #88's acceptance criterion of at least committing the active editor.

## Risks / Trade-offs

- **`window` listener stealing `⌘S` from a focused embedded editor** → guard on `.cm-editor` (and `active`), matching the established `⌘F`/`⌘R` guards in these viewers.
- **Two inactive sibling tabs both listening on `window`** → each effect is gated on `active`; only the active tab's listener runs, so no double-dispatch.
- **Dynamo `⌘S` racing an in-flight cell commit** → `handleCommitCell` already sets `savingCell` and ignores input while a commit is in flight; the `⌘S` path reuses it, so no new race.
- **Behavior change for Postgres** (now saves when focus is on `body`) → this is the intended fix and is covered by a new scenario; the read-only and clean-buffer no-ops are preserved unchanged.
