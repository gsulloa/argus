## Why

El botón `+ Query` que se añadió en el change `run-sql` para abrir la pestaña SQL vive dentro de la `rowToolbar` del sidebar, que es **invisible hasta que el usuario hace hover** sobre la fila de conexión (`opacity: 0` → `1` en `:hover`). Para alguien que no conoce la app, el path de "abrir el editor SQL de esta conexión" es invisible: no hay ninguna afordanza permanente. El usuario reporta literal "ahora no abre la tab de sql" — diagnóstico: el botón existe pero la discoverabilidad es nula.

Además, el menú contextual del clic-derecho sobre la fila de conexión hoy ofrece `Edit / Duplicate / Delete`. No tiene un ítem para abrir SQL, lo cual sería el segundo path discoverable más natural.

Esta rebanada saca el botón de la zona "hover-only" para que sea siempre visible mientras la conexión está activa, y añade el ítem `New SQL Query` al menú contextual. Dos paths obvios: ratón → clic en el icono permanente; clic-derecho → seleccionar.

## What Changes

- **Botón `+ Query` siempre visible para conexiones Postgres activas**: dejar de aplicarle `opacity: 0` (default) → `opacity: 1` (en hover). Mover el botón a un slot de "primary action" siempre visible, dentro de la fila de conexión, separado de los toolbar items secundarios (refresh + visibilidad de schemas) que mantienen su comportamiento hover-only — esos son acciones secundarias y la convención previa funcionaba.
- **Estilo visible pero discreto**: el botón usa el mismo tono `var(--text-muted)` con hover `var(--text)` que los demás iconos del sidebar. NO usa `--accent` para no competir visualmente con el dot de "active" — el objetivo es discoverabilidad, no llamar la atención.
- **Solo aparece cuando la conexión está activa** (igual que ahora): si la conexión no está conectada, el botón sigue oculto. La fila de conexión inactiva no tiene un editor SQL al cual abrir.
- **Tooltip claro**: `New SQL query (⌘↩ runs the statement)` en vez del actual `New SQL query`. Da pista del atajo de ejecución sin saturar la UI.
- **Item de context menu `New SQL Query`**: añadir un nuevo ítem al menú contextual de la fila de conexión, **arriba** de Edit / Duplicate / Delete y separado por un separator. Solo se muestra cuando la conexión está conectada (Postgres activo); en conexiones inactivas no se renderiza.
- **No se agrega un atajo global** (algo tipo `⌘N` para new query) — la palette ya tiene `SQL: New Query`, y eso queda como path para usuarios de teclado.

## Capabilities

### New Capabilities
<!-- ninguna -->

### Modified Capabilities

- `postgres-schema-browser`: el spec del botón `+ Query` se actualiza para reflejar visibilidad permanente (no hover-gated) cuando la conexión está activa, y para añadir un nuevo requirement: el ítem `New SQL Query` en el context menu de la fila de conexión.

## Impact

- **Frontend únicamente**: cambios en
  - `src/platform/shell/Sidebar.module.css`: eliminar la regla que oculta el botón SQL; mantener oculto solo refresh + visibility picker.
  - `src/platform/shell/Sidebar.tsx`: separar el botón SQL de la `rowToolbar` (hover-only) en un nuevo slot siempre visible, y añadir el ítem `New SQL Query` al `ContextMenu` (solo cuando `isPostgres && active`).
  - `src/modules/postgres/schema/SchemaTree.tsx`: dividir `SchemaToolbar` en dos exports — `SchemaPrimaryActions` (siempre visible: solo el botón SQL) y `SchemaToolbar` (hover-only: refresh + visibility picker), para que el Sidebar pueda renderizarlos en slots distintos. Alternativamente, un único componente `SchemaActions` con prop `slot: "primary" | "secondary"`. Decidido durante implementación según legibilidad.
- **Backend**: ninguno.
- **Settings / persistencia**: ninguno.
- **Atajos**: sin cambios.
- **Out of scope**: re-rediseño del sidebar, iconografía nueva, atajo global `⌘N`, FAB en el área central, página de welcome con CTA. Esos son cambios de mayor alcance que escapan al fix de discoverabilidad.
