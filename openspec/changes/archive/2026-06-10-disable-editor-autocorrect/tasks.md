## 1. Shared mechanism

- [x] 1.1 Create `src/modules/shared/text-input-hygiene.ts` exporting `noAutoCorrectProps = { autoCapitalize: "off", autoCorrect: "off", autoComplete: "off", spellCheck: false }` for native inputs
- [x] 1.2 In the same module, export `noAutoCorrectEditorAttrs = EditorView.contentAttributes.of({ autocapitalize: "off", autocorrect: "off", autocomplete: "off", spellcheck: "false" })` for CodeMirror

## 2. CodeMirror editors

- [x] 2.1 Add `noAutoCorrectEditorAttrs` to the extensions of `src/modules/postgres/sql/QueryEditor.tsx`
- [x] 2.2 Add it to `src/modules/mysql/sql/QueryEditor.tsx`
- [x] 2.3 Add it to `src/modules/mssql/sql/QueryEditor.tsx`
- [x] 2.4 Add it to `src/modules/athena/sql/QueryEditor.tsx`
- [x] 2.5 Add it to `src/modules/dynamo/data-view/edit/InspectorJsonEditor.tsx`

## 3. Inline cell / inspector editors

- [x] 3.1 `src/modules/postgres/data/EditableCell.tsx` — apply `noAutoCorrectProps` to all inputs/textareas unconditionally (replace the JSON-only conditional spread)
- [x] 3.2 `src/modules/postgres/data/Inspector.tsx` — apply to all inputs/textareas (replace JSON-only conditional)
- [x] 3.3 `src/modules/mysql/data/EditableCell.tsx` — apply to all inputs/textareas
- [x] 3.4 `src/modules/mssql/data/EditableCell.tsx` — apply to all inputs/textareas
- [x] 3.5 `src/modules/dynamo/data-view/edit/InlineCellEditor.tsx` — apply to the S (string) and N (number) editors

## 4. Connection forms

- [x] 4.1 Apply `noAutoCorrectProps` to all inputs in `src/modules/postgres/ConnectionForm.tsx`
- [x] 4.2 Apply to `src/modules/mysql/ConnectionForm.tsx`
- [x] 4.3 Apply to `src/modules/mssql/ConnectionForm.tsx`
- [x] 4.4 Apply to `src/modules/athena/ConnectionForm.tsx`
- [x] 4.5 Apply to `src/modules/dynamo/ConnectionForm.tsx`

## 5. Filters, searches, saved queries, chat

- [x] 5.1 Apply to `src/modules/postgres/data/filter-bar/ValueInput.tsx` (all inputs)
- [x] 5.2 Apply to `src/modules/postgres/data/filter-bar/ColumnPicker.tsx` (search input)
- [x] 5.3 Apply to `SchemaSearch.tsx` (replace standalone `spellCheck` with the full bundle)
- [x] 5.4 Apply to `TableSearchInput.tsx` (replace standalone `spellCheck` with the full bundle)
- [x] 5.5 Apply to `SavedQueriesPanel.tsx` inputs
- [x] 5.6 Apply to `SaveAsModal.tsx` (query name + new folder name inputs)
- [x] 5.7 Apply to the composer textarea in `src/modules/ai/components/ChatPanel.tsx`

## 6. Verify

- [x] 6.1 Grep for remaining `<input`/`<textarea` without the shared spread and for every `EditorState.create`/`new EditorView` without the extension; close any gaps
- [x] 6.2 Manually type a mixed-case identifier in each surface and confirm no mutation; inspect a CodeMirror `.cm-content` element to confirm `autocapitalize/autocorrect/autocomplete/spellcheck` attributes are present
- [x] 6.3 Run typecheck/lint (`npm run` build/lint as configured) and confirm no errors
