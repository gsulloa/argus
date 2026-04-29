## Why

El editor SQL del change anterior (`run-sql`) shipea con dos bugs que rompen los atajos centrales del flujo:

1. **Tab no acepta sugerencias del autocomplete** — el editor monta `indentWithTab` que captura Tab incondicionalmente, así que la sugerencia que aparece en el popup nunca se acepta con Tab. El usuario debe usar Enter, lo que es contra-intuitivo y rompe el patrón de TablePlus / DataGrip / VS Code.
2. **Cmd+Enter no ejecuta la query** — el binding `Mod-Enter` en el `customKeymap` se registra pero no dispara, probablemente por precedencia con el `defaultKeymap` cuando ambas extensions tienen `Prec.default`. La señal "Press ⌘↩ to run" en el panel de resultados queda sin cumplir.

Sin estos dos atajos, la pestaña SQL es prácticamente inutilizable: el spec del editor los promete y el panel de resultados los publicita. Esta rebanada los arregla y, de paso, formaliza una pequeña batería de pruebas manuales en el QA del proyecto para que regresiones similares no pasen sin notarse.

## What Changes

- **Tab acepta autocomplete cuando el popup está abierto, e indenta cuando no**: añadir un `KeyBinding` para `Tab` que llama a `acceptCompletion` (de `@codemirror/autocomplete`) primero; si retorna `false` (no hay popup activo), cae a `indentMore`. `Shift-Tab` mantiene `indentLess`. Esto reemplaza el `indentWithTab` actual.
- **`Mod-Enter` ejecuta la statement bajo el cursor (o la selección)**: el `customKeymap` se eleva a `Prec.highest` para garantizar que su `Mod-Enter` y `Mod-Shift-Enter` ganen sobre cualquier binding del `defaultKeymap` o de extensions futuras. (Hoy `defaultKeymap` no liga `Mod-Enter`, pero el bug observado sugiere que la precedencia no es la asumida — `Prec.highest` lo blinda explícitamente).
- **Hint visual del binding**: el placeholder del result panel pasa de `Press ⌘↩ to run` a `Press ⌘↩ to run · Tab to autocomplete`, así el usuario ve los dos atajos correctos al abrir la pestaña.
- **No se cambia ningún atajo existente** fuera del editor (Cmd+W, Cmd+K, Cmd+\, etc. siguen igual).

## Capabilities

### New Capabilities
<!-- ninguna -->

### Modified Capabilities

- `postgres-sql-editor`: el spec del editor especifica explícitamente que `Tab` acepta la sugerencia activa de autocomplete cuando el popup está abierto y, en otro caso, indenta; y que `Mod-Enter` / `Mod-Shift-Enter` deben tener precedencia máxima dentro del editor para no ser absorbidos por el keymap por defecto.

## Impact

- **Frontend**: cambios localizados en `src/modules/postgres/sql/QueryEditor.tsx` (configuración de `EditorState`, prep de keymap y precedencia). Cambio menor en `src/modules/postgres/sql/ResultPanel.tsx` (texto del placeholder).
- **Backend**: ninguno.
- **Settings / persistencia**: ninguno.
- **Riesgos**:
  - El nuevo binding de `Tab` dispara `acceptCompletion` aunque la sugerencia sea exacta; si el usuario quiere indentar mientras el popup está abierto, primero debe cerrar el popup con `Escape`. Es el comportamiento de la mayoría de editores SQL — aceptable.
  - `Prec.highest` para el customKeymap impediría que un futuro keymap intente sobre-escribir `Mod-Enter` sin usar `Prec.highest` también. Documentado en el spec.
- **Out of scope**: re-bind global `Tab` (la app la usa para ciclar pestañas vía `useShortcuts`), redo (`Mod-Shift-Z`), comentarios multi-línea más allá de `Mod-/` que ya viene del default.
