## Context

El schema browser ya entrega árbol de objetos por conexión. Hoy el click en una tabla abre `postgres-object-placeholder`, una pestaña de relleno con el mensaje "Viewer not implemented yet". Esta es la primera rebanada que la convierte en algo útil: ver datos de tablas, vistas y vistas materializadas con paginación, sort y filtros, todo read-only.

**Estado actual relevante**:

- `PgPoolRegistry` mantiene un pool por conexión activa con un `ActivePool` que ya separa `executeQuery` (lectura) de un futuro `executeMutation` (rechazado si `read_only`).
- `postgres_list_objects` ya implementó el patrón `tokio::time::timeout` + cancel-token para queries largas; lo reusamos.
- El sistema de tabs es un `TabRegistry` con renderers registrados y un `TabsContext` con estado en memoria (no persistido). Agregar `postgres-table-data` es registrar un renderer más.
- El store de settings es SQLite (tabla `settings`, key/value JSON) accedido vía `settings_get` / `settings_set`. El hook `useVisibleSchemas` muestra el patrón a seguir.
- `@tanstack/react-virtual` ya está instalado (lo usa `SidebarTree`); falta `@tanstack/react-table`.
- DESIGN.md fija fonts (Geist / Geist Mono), accent `#A855F7`, hairlines, densidad compacta — la grid debe respetarlo.

**Constraints**:

- El módulo Postgres debe seguir autocontenido (`src-tauri/src/modules/postgres/`, `src/modules/postgres/`). No debe filtrarse a `app-shell` ni a otros sources.
- LIMIT/OFFSET es suficiente para V1; cursor-based pagination puede llegar después si surge dolor de performance.
- Read-only por diseño: este change no introduce edición. Eso es `edit-table-data` (#5).

## Goals / Non-Goals

**Goals**:

- Ver datos de tablas, vistas y vistas materializadas con grid virtualizada.
- Sort por columna (incluido multi-columna con shift-click) que se traduce en `ORDER BY` server-side.
- Filtros por columna desde el header con un set acotado de operadores; todos parametrizados.
- Page size configurable por tabla, persistido.
- Inspector lateral con la fila seleccionada en read-only, ancho persistente.
- Conteo total perezoso bajo botón explícito.
- Reusar el patrón de timeout/cancel del schema browser.

**Non-Goals**:

- Edición de celdas, insert, delete (eso es `edit-table-data`).
- Export CSV/JSON/SQL (`export-table-data`, opcional).
- Editor avanzado de jsonb / array (mostramos como texto truncado por ahora).
- Vista CREATE TABLE / structure tab (eso es #8 `table-structure-tab`).
- Cursor-based pagination, server-side cursor, snapshot isolation entre páginas. LIMIT/OFFSET y "lo que veas, viste" alcanza para V1.
- Recuento total automático. La UI lo expone como acción explícita para evitar `SELECT COUNT(*)` involuntarios contra tablas grandes.

## Decisions

### 1. LIMIT/OFFSET en lugar de cursor / keyset

Cada página adicional reemite la query con el `offset` incrementado.

**Por qué**: keyset-pagination requiere que el cliente conozca una clave estable, lo cual no podemos garantizar para vistas o tablas sin PK. Cursor server-side mantiene una transacción abierta y complica el ciclo de vida del pool. LIMIT/OFFSET es simple, suficiente para datasets típicos de inspección y consistente con TablePlus.

**Alternativas descartadas**:

- *Keyset/seek*: complejo cuando hay multi-column sort y nullable.
- *Cursor (`DECLARE … CURSOR`)*: requiere transacción persistente; mal con un pool compartido.

**Trade-off aceptado**: páginas profundas (offset grande) son lentas en Postgres. Para V1 es ok; si duele, cambiamos a keyset por columna identificable.

### 2. Filtros como tipo etiquetado en vez de SQL libre

`Filter` es un sum type estricto: `{ column, op, value | min/max }` con un set acotado de operadores. La frontend nunca escribe SQL.

**Por qué**: simplicidad, prevención de inyección, parseable, fácil de serializar a JSON, fácil de invertir/editar en UI. El `run-sql` change posterior cubre el caso "necesito SQL libre".

**Alternativas descartadas**:

- *Texto SQL parseado*: redundante con la pestaña SQL del change #6.
- *Operadores arbitrarios*: amplía superficie de inyección sin valor.

**Validación**: el backend rechaza operadores fuera del set con `AppError::Validation`. La frontend mapea operadores disponibles según el tipo Postgres del header (numéricos no muestran `LIKE`, etc.).

### 3. Identifier quoting siempre, parametrización siempre

Schema y relation se quotean con la regla estándar Postgres (doble comillas, doblando `"` interno). Los valores de filtros van como bound parameters (`$1, $2, …`). Nunca hay `format!("WHERE {} = {}", col, val)`.

**Por qué**: evita SQL injection vía nombres patológicos o valores hostiles. Es la única opción aceptable.

**Implementación**: helper `quote_ident(s: &str) -> String` que retorna `format!("\"{}\"", s.replace('"', "\"\""))`. Builder de query que toma `(schema, relation, options)` y produce `(sql, Vec<Box<dyn ToSql + Sync>>)`.

### 4. Carga incremental scroll-to-load (no paginador)

No mostramos botones "Next page". El virtualizer dispara la siguiente página cuando el usuario está a `2 * page_size` filas del tail.

**Por qué**: TablePlus lo hace así, es lo natural para inspección. El "Page Y" del bar es informativo, no de control.

**Trade-off**: el usuario no puede saltar a la página 50 directo. No nos importa para V1 — saltar a páginas profundas con LIMIT/OFFSET sería lento de todas formas.

### 5. Conteo total bajo botón explícito

`Count rows` dispara `SELECT COUNT(*)` honrando filtros activos. El resultado se cachea hasta que cambien los filtros.

**Por qué**: contra tablas grandes (`pg_class.reltuples` mostrando cientos de millones), `COUNT(*)` puede tardar minutos. No queremos pagar ese costo automáticamente.

**Implementación**: el bottom bar siempre muestra `Showing N rows · Page P`; tras click en `Count rows`, agrega `of <Total>`. Cualquier cambio de filtro resetea el `Total` y exige nuevo click.

### 6. Page size por tabla, ancho del inspector global

`pgTableLimit:<connectionId>:<schema>:<relation>` (number) por relación. `pgInspectorWidth` (number) global.

**Por qué**: una tabla `users` chica vs `events` enorme suelen pedir page sizes distintos — vale la pena recordarlo. El inspector, en cambio, es un control de layout que el usuario ajusta una vez.

**Migración**: ambos defaults vivos en código (`200` y `320` respectivamente); si el setting no existe, usa el default.

### 7. Tab id estable por relación

`pgtbl:<connectionId>:<schema>:<relation>`. Reactivar el mismo nodo enfoca la pestaña existente.

**Por qué**: consistente con cómo `postgres-object-placeholder` ya construye su id. Evita pestañas duplicadas. El `relationKind` no entra en el id porque dos objetos distintos no pueden compartir nombre dentro de un schema en Postgres.

### 8. Comando de query separado del de count

`postgres_query_table` y `postgres_count_table` son comandos independientes. La frontend los compone.

**Por qué**: el count es opcional, perezoso y caro. No queremos atarlo a la query de datos. Permite cancelar el count mientras los datos siguen cargando.

### 9. Timeout reusa el patrón existente

Reusamos el helper de `postgres_list_objects` (15s timeout, cancel-token, devuelve SQLSTATE 57014). La frontend hace auto-retry una vez si la primera page falla por 57014; las páginas siguientes muestran retry manual inline.

**Por qué**: consistencia con el schema browser; el usuario ya conoce el comportamiento. La primera carga es la que más merece auto-retry (es la "abrir la tabla" experience).

### 10. Convención de layout para tab content

Tab content (`TableViewerTab.root` y, a futuro, todo lo que se registre en el `TabRegistry`) usa `flex: 1; min-height: 0` — **no** `height: 100%`. Como red de seguridad transversal, `TabStrip.root` y `BottomBar.root` declaran `flex-shrink: 0` para que el contenido de la pestaña no pueda aplastarlos.

**Por qué**: `.center` (Layout) es una columna flex con `overflow: hidden`. Sus hijos por defecto son `flex: 0 1 auto`, lo que permite shrink bajo presión de min-content. Una tab cuyo `.root` declara `height: 100%` y por dentro tiene contenido con min-content alto (grilla virtualizada + inspector + bottom bar) presiona la columna y el `TabStrip` se aplasta — se queda mostrando solo los descenders de los títulos. La `WelcomeTab` no caía en esto porque ya usaba `flex: 1`.

**Cómo aplicar**: cualquier nuevo tab kind debe seguir el mismo patrón. La regla queda asentada acá hasta que migre a un spec del shell cuando lleguen más viewers (#6 SQL editor, #8 structure tab) y la convención se vuelva más visible.

### 11. Datos como `Vec<Vec<JsonValue>>` con envelope para casos especiales

Cada fila es un array de valores en orden de columnas. Tipos JSON-naturales (string, number, bool, null) se serializan directo. `bytea`, valores grandes (>1MB), `jsonb`/`array` (que pueden ser enormes) se devuelven como `{ kind: "binary"|"truncated", preview, byte_length }`.

**Por qué**: TanStack Table piensa en filas como `unknown`; el array por columnas es trivial de mapear. El envelope evita transferir megabytes innecesarios al renderer (la grid solo muestra preview; el inspector muestra el preview también, no el contenido completo en V1).

**Trade-off**: el inspector no muestra binarios ni textos enormes completos en V1. Es ok — son casos edge. Cuando duela, agregamos un comando `postgres_get_cell` para traer el valor completo bajo demanda.

## Risks / Trade-offs

- **OFFSET grande es lento** → mitigamos: por defecto la grid promueve scroll-to-load consciente; el page-size se queda en 200; si el usuario buffer-ea 50k filas, es deliberado.
- **`SELECT COUNT(*)` lento contra tablas enormes** → mitigamos: bajo botón explícito, no automático; el botón muestra spinner; si el usuario espera demasiado puede cambiar de pestaña — la query queda corriendo hasta que termine o se cancele al cerrar la pestaña.
- **Filtros sobre columnas con tipos exóticos** (uuid, jsonb, array) → mitigamos: el header filter UI ofrece operadores básicos (`=`, `!=`, `IS NULL`); para casos más finos el usuario va a `run-sql` (#6).
- **Vistas materializadas pueden ser muy lentas a `SELECT`** → mitigamos: el timeout de 15s aplica igual; ya existe la auto-retry y manual retry. No tratamos vistas distinto a tablas.
- **Truncado de valores grandes oculta data** → mitigamos: el inspector muestra el preview con el byte length, claramente etiquetado como truncado. En V1 no abrimos el valor completo; en `edit-table-data` o un follow-up llega el getter on-demand.
- **Estado de pestaña no persiste entre sesiones** → trade-off aceptado: igual que el resto de pestañas de Argus hoy. Si llega `multi-window` o "session restore" se aborda transversalmente, no aquí.
- **TanStack Table es una dependencia más** → trade-off aceptado: es estándar, mantenida, headless (no impone CSS), y nos ahorra reescribir column ordering, sort state machine, filter state machine. Bundle delta es razonable (<60KB gzipped).

## Migration Plan

No hay migración: change aditivo. Pasos de despliegue dentro de la sesión de implementación:

1. Agregar `@tanstack/react-table` al frontend (`pnpm add @tanstack/react-table`).
2. Crear `src-tauri/src/modules/postgres/data.rs` con `postgres_query_table` y `postgres_count_table`; registrar en el `invoke_handler` del módulo.
3. Crear `src/modules/postgres/data/` con: `api.ts` (wrappers IPC), `useTableData.ts` (hook con buffer + paginación), `usePageSize.ts` (settings hook por relación), `useInspectorWidth.ts` (settings hook global), `TableViewerTab.tsx` (renderer del tab), `DataGrid.tsx`, `Inspector.tsx`, `BottomBar.tsx`, `ColumnFilter.tsx`.
4. Registrar el tab kind `postgres-table-data` en el `TabRegistry`.
5. Actualizar `src/modules/postgres/schema/openObjectTab.ts` para enrutar `table` / `view` / `materialized-view` al nuevo tab kind.
6. Probar manualmente contra una BD local (tablas chicas, grandes, vistas, mat-views, columnas exóticas como `bytea`/`jsonb`).
7. Actualizar `openspec/ROADMAP.md` marcando #4 como en progreso (o archivado tras el merge).

**Rollback**: revertir el commit. Como la nueva pestaña no toca datos del usuario, no hay estado migrable que limpiar más allá de las settings keys (que quedan inertes si la pestaña deja de existir).

## Open Questions

- ¿Vale la pena precargar la cuenta total para tablas con `pg_class.reltuples < 10000`? Probablemente no — agrega un comando más sin beneficio claro. Queda para discutir si el usuario lo pide.
- ¿El inspector debería abrir un modal/drawer en pantallas chicas en lugar de un panel lateral? Argus es desktop, asumimos ancho razonable. Si algún día llega a iPad-sized, se replantea.
- ¿Soporte de `NULLS FIRST / NULLS LAST` explícito en `order_by`? Para V1 dejamos el default de Postgres (`NULLS LAST` para `ASC`, `NULLS FIRST` para `DESC`). Agregar `nulls?: "first"|"last"` al payload es trivial cuando duela.
