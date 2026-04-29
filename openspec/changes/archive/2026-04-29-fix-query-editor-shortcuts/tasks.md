## 1. QueryEditor: keymap fixes

- [x] 1.1 Importar `Prec` de `@codemirror/state`, `acceptCompletion` y `completionStatus` de `@codemirror/autocomplete`, y `indentLess`/`indentMore` de `@codemirror/commands` en `src/modules/postgres/sql/QueryEditor.tsx`. Quitar el import de `indentWithTab`.
- [x] 1.2 Construir `tabBindings: KeyBinding[]` con dos entradas: Tab → `completionStatus(view.state) === "active" ? acceptCompletion(view) : indentMore(view)`; Shift-Tab → `indentLess`.
- [x] 1.3 Reemplazar el `customKeymap` actual por `Prec.highest(keymap.of([{Mod-Enter}, {Mod-Shift-Enter}, ...tabBindings]))` para asegurar precedencia máxima.
- [x] 1.4 Verificar que `customKeymap` envuelto en `Prec.highest` siga apareciendo en el array de extensions del `EditorState.create` y que el orden relativo del keymap "grande" no afecte el resultado (debería ganar siempre).

## 2. ResultPanel: hint con atajos

- [x] 2.1 En `src/modules/postgres/sql/ResultPanel.tsx`, cambiar el texto `Press ⌘↩ to run.` del estado `idle` por `Press ⌘↩ to run · Tab to autocomplete`.

## 3. Validación

- [x] 3.1 `pnpm typecheck` y `pnpm build` sin errores.
- [ ] 3.2 Manual QA: abrir un query tab, tipear `SEL`, presionar Tab → debe completar a `SELECT`. Tipear `SELECT 1`, presionar `Cmd+Enter` → resultado en el panel. Tipear con cursor en una línea indentada y popup cerrado → Tab indenta como antes. Shift-Tab dedenta independiente del popup. (Pendiente — QA manual contra dev server.)
