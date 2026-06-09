## Context

Argus renders two kinds of text-editing surfaces:

1. **Native `<input>`/`<textarea>`** — connection forms, filter bar, searches, saved-query dialogs, the AI chat composer, and inline cell/inspector editors for Postgres/MySQL/MSSQL/DynamoDB.
2. **CodeMirror 6 editors** — the SQL editors (postgres/mysql/mssql/athena) and the DynamoDB JSON inspector editor, each instantiated directly via `new EditorView({ state, parent })` with no shared wrapper.

Current state is inconsistent: only Postgres JSON cells (`EditableCell.tsx`, `Inspector.tsx`) conditionally set the four attributes; a few searches set only `spellCheck="false"`; everything else sets nothing. CodeMirror's editable region is an internal `contentEditable` div not exposed through React props.

Constraint: frontend-only change, no Rust/API/schema impact. Must not regress (new inputs should inherit the behavior by default).

## Goals / Non-Goals

**Goals:**
- Disable `autoCapitalize`, `autoCorrect`, `autoComplete`, `spellCheck` on every text-editing surface.
- Provide one shared mechanism for native inputs so the default is hard to forget.
- Cover CodeMirror editors via a reusable extension.

**Non-Goals:**
- No redesign of any form, editor, or component.
- No change to validation, parsing, or submit behavior.
- No new lint rule to enforce usage (noted as a possible follow-up, not in scope).
- CloudWatch surfaces only insofar as they use the same shared mechanism; no new CloudWatch-specific work.

## Decisions

### Decision 1: A shared props bundle for native inputs
Export a constant (e.g. `noAutoCorrectProps`) — `{ autoCapitalize: "off", autoCorrect: "off", autoComplete: "off", spellCheck: false }` — from a shared module (`src/modules/shared/text-input-hygiene.ts`). Each native input spreads `{...noAutoCorrectProps}`. Explicit per-input attributes already present can be removed in favor of the spread.

- **Why over a wrapper `<Input>` component**: a wrapper would require migrating every call site's styling/ref/props surface — large, risky, and stylistically invasive. A spread is a one-line, low-risk addition that preserves existing markup and matches the issue's "spread of props" suggestion.
- **Alternative considered**: a `useNoAutoCorrect()` hook returning the props — equivalent, but a plain constant is simpler since the value is static.

### Decision 2: A reusable CodeMirror extension via `EditorView.contentAttributes`
Export an extension (e.g. `noAutoCorrectEditorAttrs = EditorView.contentAttributes.of({ autocapitalize: "off", autocorrect: "off", autocomplete: "off", spellcheck: "false" })`) from the same shared module, and add it to the `extensions` array of every `EditorState.create`/`EditorView` setup.

- **Why over post-render DOM mutation**: `contentAttributes` is the idiomatic CodeMirror 6 API, applied declaratively and re-applied on reconfigure, with no ref timing or cleanup concerns.
- **Note**: HTML attribute names/values are strings here (`spellcheck: "false"`), distinct from the React camelCase props in Decision 1.

### Decision 3: Single shared module location
Place both exports in `src/modules/shared/` (which already hosts cross-module code like `filter-bar/`). Co-locating the native-input bundle and the CodeMirror extension keeps the "text hygiene" concern discoverable in one file.

## Risks / Trade-offs

- **Missed surfaces** → Enumerate every file in tasks.md from the issue + Explore audit; a final grep for `<input`/`<textarea`/`EditorState.create` validates coverage.
- **`autoComplete="off"` and password managers** → Acceptable: these are app-internal DB connection forms, not consumer login forms; suppressing browser autofill of identifiers/SQL is the intended behavior.
- **No enforcement mechanism** → A future ESLint rule could require the spread on raw inputs; out of scope here. Centralizing in one module already reduces drift.
- **CodeMirror reconfigure** → `contentAttributes` is part of the extension set, so it survives state reconfiguration; no risk of attributes being dropped on editor updates.

## Migration Plan

No runtime migration — purely additive frontend attributes. Rollback is reverting the diff. Verify by typing a mixed-case identifier in each surface and confirming no mutation, plus inspecting CodeMirror `.cm-content` for the attributes.
