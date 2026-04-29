## Context

`run-sql` (mergeado anteriormente) montó CodeMirror 6 con `@codemirror/lang-sql` para el editor de la pestaña `postgres-query`. La configuración actual:

```ts
extensions: [
  // …
  sql({ dialect: PostgreSQL, upperCaseKeywords: true }),
  completionCompartment.current.of(completionExtension),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...historyKeymap,
    ...completionKeymap,
    ...searchKeymap,
  ]),
  customKeymap, // contiene Mod-Enter, Mod-Shift-Enter, indentWithTab
  updateListener,
  EditorView.theme({...}),
]
```

donde `customKeymap` se construye así:

```ts
const customKeymap = keymap.of([
  { key: "Mod-Enter", preventDefault: true, run: () => { onRunRef.current(); return true; } },
  { key: "Mod-Shift-Enter", preventDefault: true, run: () => { onRunAllRef.current(); return true; } },
  indentWithTab,
]);
```

**Síntomas reportados por el usuario**:

1. Tab no acepta la sugerencia del popup; el cursor solo indenta.
2. `Cmd+Enter` no dispara `onRun()`; la statement bajo el cursor nunca se ejecuta.

**Diagnóstico**:

- `indentWithTab` es un `KeyBinding` que enlaza Tab → `indentMore` y Shift-Tab → `indentLess`. **Captura Tab incondicionalmente**, incluyendo cuando el popup de `@codemirror/autocomplete` está abierto. El `completionKeymap` por defecto **no incluye Tab para `acceptCompletion`** — solo Enter (`{ key: "Enter", run: acceptCompletion }`). De ahí el comportamiento observado: Tab indenta, no acepta.
- `Mod-Enter` está en `customKeymap` y se registra después del keymap grande. En CodeMirror 6 las extensions del mismo `Prec.default` se procesan en el orden en que aparecen en el array, con la regla "the last one wins" para bindings duplicados. Sin embargo, ninguna entrada del `defaultKeymap` o `historyKeymap` (en versiones actuales) liga `Mod-Enter`, así que en teoría no debería haber conflicto. El bug puede deberse a:
  - Algún keybinding intermedio (de `lang-sql` o `closeBracketsKeymap`) que está consumiendo `Mod-Enter` con precedencia equivalente y previniendo el match.
  - El `customKeymap` se está creando dentro de un `useEffect([])` y, aunque captura `onRunRef.current` por closure, podría haber un caso edge si la `useEffect` se ejecuta dos veces en `<StrictMode>` y el cleanup deja un view stale al que llega el evento. (No verificado, pero `Prec.highest` lo neutraliza).
  - Una regresión en alguna versión de CM que requiere `Prec.highest` para garantizar que custom bindings ganen sobre extensions de language packs.

La solución cubre ambas vías sin necesidad de bisectar más: subir el customKeymap a `Prec.highest` y mover Tab a un binding consciente del popup.

## Goals / Non-Goals

**Goals**:

- Tab dentro del editor acepta la sugerencia activa del popup de autocomplete cuando hay una.
- Tab dentro del editor indenta (1 nivel) cuando no hay popup abierto.
- Shift-Tab dedenta sin importar el estado del popup.
- `Cmd+Enter` (y `Ctrl+Enter` en Linux/Windows) ejecuta la statement bajo el cursor o la selección, **siempre** que el editor tenga foco.
- `Cmd+Shift+Enter` ejecuta toda la pestaña como multi-statement.
- Ningún cambio fuera del QueryTab — el resto de atajos globales (`Cmd+W`, `Cmd+K`, etc.) sigue intacto.

**Non-Goals**:

- Soporte para Tab triggering autocomplete-on-empty (autocomplete ya se abre solo al tipear o con `Mod-Space`; mantenemos eso).
- Re-binding global del Tab para tab-cycle: el handler global del `useShortcuts` ya respeta `isTypingTarget` (que cubre `contentEditable`), por lo que el Tab dentro del editor nunca llega a `cycle()`.
- Redo binding (`Mod-Shift-Z`) — ya viene de `historyKeymap`; no lo tocamos.
- Otros atajos del editor (búsqueda, multi-cursor, etc.) — quedan donde están.

## Decisions

### 1. Tab handler: `acceptCompletionIfActive`-or-`indentMore`

Definimos un `KeyBinding` para Tab así:

```ts
import { acceptCompletion, completionStatus } from "@codemirror/autocomplete";
import { indentMore, indentLess } from "@codemirror/commands";

const tabBinding: KeyBinding[] = [
  {
    key: "Tab",
    preventDefault: true,
    run: (view) => {
      if (completionStatus(view.state) === "active") {
        return acceptCompletion(view);
      }
      return indentMore(view);
    },
  },
  { key: "Shift-Tab", preventDefault: true, run: indentLess },
];
```

**Por qué**: refleja el patrón canónico de CodeMirror 6 para "Tab acepta sugerencia, sino indenta". `completionStatus(view.state)` devuelve `"active" | "pending" | null`. Solo aceptamos cuando hay popup vivo; cualquier otro estado cae a indent.

**Alternativa descartada**: usar `acceptCompletion` directo y dejar que retorne `false` cuando no hay popup, para luego encadenar a `indentMore` con array de runs. Más conciso pero menos legible y, según mi lectura del API, `acceptCompletion` no retorna `false` consistentemente cuando no hay popup — usar `completionStatus` como guard explícito es más predecible.

### 2. Subir `customKeymap` a `Prec.highest`

```ts
import { Prec } from "@codemirror/state";

const customKeymap = Prec.highest(
  keymap.of([
    { key: "Mod-Enter", preventDefault: true, run: () => { onRunRef.current(); return true; } },
    { key: "Mod-Shift-Enter", preventDefault: true, run: () => { onRunAllRef.current(); return true; } },
    ...tabBinding,
  ]),
);
```

**Por qué**: `Prec.highest` garantiza que estas bindings se prueben antes que cualquier otra, sin importar qué orden tengan en la lista de extensions ni qué pack añada bindings en el futuro. Es la práctica recomendada para shortcuts "de la app" que deben ganar siempre.

**Trade-off**: si más adelante quisiéramos rebindable shortcuts (settings UI), tendríamos que mover esa configuración también a `Prec.highest`. No es un problema hoy.

### 3. `indentWithTab` removido

Lo reemplazamos por nuestros propios bindings de Tab/Shift-Tab. Razón: `indentWithTab` es un "atajo de vida" de `@codemirror/commands` que no inspecciona el estado del autocomplete. No hay forma de combinarlo con la lógica del popup sin envolverlo, y envolver duplica una línea — más limpio escribirlo nosotros.

### 4. Texto del hint en el result panel

Cambio cosmético en `ResultPanel.tsx`: el texto vacío inicial pasa de:

> Press ⌘↩ to run.

a:

> Press ⌘↩ to run · Tab to autocomplete

**Por qué**: el atajo ahora funciona y el usuario lo descubre antes. No usamos un mac-vs-non-mac `⌘↩` vs `Ctrl↩` porque toda la app desktop ya usa la convención `⌘` (ver `useShortcuts.ts` que normaliza Mod a Cmd en macOS y Ctrl en Linux/Windows; el símbolo `⌘` es lo que el usuario espera ver en macOS, y para Windows/Linux es legible aun siendo "incorrecto" — la app está orientada a macOS en V1).

## Risks / Trade-offs

- **Tab acepta autocomplete aunque la sugerencia sea exacta** → el usuario que quería indentar dentro de un popup activo debe pulsar `Escape` primero. Es el comportamiento de la mayoría de editores SQL desktop (DataGrip, TablePlus, Postico). Aceptable.
- **`Prec.highest` para el customKeymap acopla cualquier futuro plug-in** → cualquier extension futura que quiera reasignar `Mod-Enter` también debe ir a `Prec.highest`. Documentado.
- **Falta detección automática del bug** → no tenemos test runner en frontend. Mitigación: añadir un check al QA manual (`8.x` del spec previo). Tests E2E vendrán cuando se introduzca un runner.

## Migration Plan

Cambio aditivo y local. Pasos:

1. Editar `src/modules/postgres/sql/QueryEditor.tsx`:
   - Importar `Prec` de `@codemirror/state`, `acceptCompletion` y `completionStatus` de `@codemirror/autocomplete`, `indentMore` / `indentLess` de `@codemirror/commands`.
   - Quitar `indentWithTab` del array de bindings.
   - Añadir tabBinding (Tab / Shift-Tab).
   - Envolver el customKeymap con `Prec.highest(...)`.
2. Editar `src/modules/postgres/sql/ResultPanel.tsx`: cambiar el placeholder string.
3. `pnpm typecheck` + `pnpm build`.
4. Manual QA: abrir un query tab → tipear `SEL` → ver popup → presionar Tab → confirmar que aparece `SELECT`. Tipear `SELECT 1` → presionar `Cmd+Enter` → confirmar resultado en panel.

**Rollback**: revertir el commit. No hay datos persistidos al feature.

## Open Questions

- **¿Tab se vuelve molesto cuando el popup se abre por sí solo y el usuario quería indentar?** En la práctica, el popup solo se abre con tipeo o con `Mod-Space`; el usuario que está indentando un bloque no debería tener un popup activo. Si hay quejas reales, considerar bindear Tab solo cuando `completionStatus === "active"` Y la sugerencia tiene un match no-trivial — pero eso es complejidad que no necesitamos hoy.
- **¿Mostrar otros atajos en el hint?** `Mod-Shift-Enter` (run all) es útil pero menos común. Lo dejamos fuera del hint para no recargarlo; vive en la documentación / spec.
