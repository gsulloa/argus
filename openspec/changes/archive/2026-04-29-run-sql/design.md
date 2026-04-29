## Context

Argus ya tiene la pila Postgres lista para los flujos read y edit: `PgPoolRegistry`, `executeQuery` / `executeMutation`, `is_mutating_sql`, schema browser cacheado en memoria, `postgres-data-grid` virtualizado con inspector, y un activity-log con eventos por comando. Lo que falta es un editor SQL real. Hoy todo lo que no calza en el grid (joins manuales, EXPLAIN, ALTER TABLE, scripts ad hoc) obliga a salir a `psql`.

**Estado actual relevante**:

- `PgPoolRegistry::execute_query` y `execute_mutation` ya manejan el flag `read_only`. `execute_mutation` rechaza con `AppError::Validation "connection is read-only"` antes de tocar la wire.
- `is_mutating_sql(sql)` ya existe (introducido durante `edit-table-data`) — heurística simple sobre el primer keyword tras strip de comentarios. Sirve para clasificar statements en run-sql.
- El módulo Postgres expone `postgres_query_table` con un envelope de `CellValue` que cubre `binary` / `truncated text`. Reutilizable verbatim para resultados ad hoc.
- `postgres_list_relations` y `postgres_list_structure` cargan en memoria del frontend (cache en `useSchemaTree`). Las columnas no están todavía cacheadas a nivel global — sólo cuando el usuario expande una tabla en el sidebar a través de `postgres_list_table_extras` (que devuelve indexes/triggers) o cuando el viewer abre la tabla y el grid recibe `columns`. Hoy no existe un comando central que devuelva columnas para autocomplete.
- `app-shell` registra el tab system con `TabRegistry` keyado por `kind`. Los renderers viven en `src/platform/shell/tabs/<kind>.tsx`. Tab payload arbitrary, stable id arbitrario.
- DESIGN.md fija fuente `Geist Mono` para todo lo monoespaciado, paleta `--accent`, `--accent-soft`, `--surface`, `--border`, `--danger`. Sin token `--warning` formal a la fecha.
- `command-palette` registra/desregistra commands desde cualquier módulo en boot. Soporta hotkeys globales — pero el editor CodeMirror absorbe `⌘↩`, así que el binding global no aplica cuando el editor tiene foco; lo manejamos como atajo del editor.
- `activity-log` define un payload con `kind` enumerado y un `metric` discriminated union que hoy incluye `rows`, `count`, `server_version`, `items`. Hay que añadirle `affected`.

**Constraints**:

- Módulo Postgres autocontenido: la pestaña `postgres-query` vive en `src/modules/postgres/sql/`; nada de Postgres-specific se filtra a `app-shell`.
- Reuso del grid existente: dividir `DataGrid.tsx` en un core read-only adhoc consumible y un wrapper editable. No duplicar la virtualización ni el styling.
- No abrir conexiones nuevas: el run-sql usa el pool existente para esa conexión.
- No persistir SQL a disco entre sesiones — el shell aún no restaura tabs entre relaunches; cuando lo haga (change futuro), encajamos.
- Read-only enforcement defense-in-depth: la heurística `is_mutating_sql` no es bulletproof, pero es la línea por convención. Si entra una mutación disfrazada (`DO $$ … $$`, función con side effect), la responsabilidad cae en el usuario que marcó la conexión read-only en buena fe.
- Cap de filas: 10 000 por respuesta. Es un compromise entre "scroll-to-load no aplica para queries arbitrarias" y "no romper la UI con un `SELECT * FROM events`".

## Goals / Non-Goals

**Goals**:

- Editor CodeMirror 6 con dialecto Postgres por pestaña, atajos `⌘↩` para ejecutar, autocomplete contra el cache del schema browser.
- Comandos backend `postgres_run_sql` (single statement) y `postgres_run_sql_many` (multi-statement).
- Detección de "statement bajo el cursor" cuando no hay selección, con splitting consciente de strings y comentarios (no romper en `;` dentro de un literal).
- Render de resultados read-only reusando la grid virtualizada, con inspector lateral funcional.
- Render de resultados no-SELECT (`affected_rows + command_tag`).
- Render de errores con SQLSTATE + posición y "Show in editor".
- Multi-statement: pestañas internas en el panel de resultados.
- Read-only enforcement consistente con el resto del módulo Postgres.
- Activity-log entry por cada statement ejecutada (1 por single, N por multi).
- Entry points: comando palette `SQL: New Query`, `SQL: New Query Here` contextual, botón `+ Query` por conexión activa en sidebar.
- Persistencia in-session del buffer del editor por tab id.

**Non-Goals**:

- Restaurar pestañas entre relaunches (es un change separado del shell; el buffer in-session basta para V1).
- Visualizar EXPLAIN como árbol — render como texto plano.
- Format SQL automático.
- Snippets / templates personales.
- Binds explícitos `$1`/`$2` desde UI.
- History (es change #7, no se toca aquí).
- Saved queries / favoritos.
- Streaming / cursor-based de resultados grandes — el cap de 10k corta y obliga a `LIMIT`.
- Cancel inflight: tras el primer envío, no hay botón de cancel; si una query se eterniza, el usuario espera el timeout (que existe a nivel de pool de 30s) o cierra la pestaña. Un cancel real es un follow-up.
- Session settings stickyness (`SET search_path` persistente entre runs en la misma pestaña): cada `postgres_run_sql` toma un client del pool y lo libera; si quieres `SET search_path`, lo incluyes en tu multi-statement antes del query.

## Decisions

### 1. Comandos: `postgres_run_sql` (single) y `postgres_run_sql_many` (multi)

`postgres_run_sql(connection_id, sql, origin?)` es la primitiva. Toma un client del pool, decide entre `execute_query` y `execute_mutation` según `is_mutating_sql(sql)`, y devuelve un `RunSqlResult` discriminado.

`postgres_run_sql_many(connection_id, statements, origin?)` recibe un `Vec<String>` ya parseado por el frontend (no parsea en Rust), itera y reusa internamente la misma lógica de `postgres_run_sql` pero **manteniendo el mismo client borrowed del pool durante toda la secuencia**, para que un `SET search_path` antes de un `SELECT` funcione. Se ejecutan secuencialmente; el primer error rompe el bucle (las posteriores quedan como `status: "skipped"`).

**Por qué dos comandos en vez de uno**: el caller siempre sabe si va a mandar uno o varios. Mezclarlo en un único comando con `Vec<String>` obligaría a abrir `len == 1` siempre — funciona pero hace los logs ruidosos (dos events para una sola statement) y complica el contrato del único caso (single statement) que es el flujo principal. Dos comandos, contratos limpios.

**Alternativa descartada**: parser de SQL en Rust con `pg_query.rs` para identificar statements. Demasiado peso para algo que el splitter de TS hace bien con un parser de char-state simple.

### 2. Splitter de statements (frontend)

Implementación: una función `splitStatements(sql: string): Statement[]` que recorre `sql` carácter a carácter manteniendo un estado:

- `normal` → ve `;` → cierra una statement.
- `'…'` → ignora `;` y `--`/`/*`. Maneja escape `''`.
- `"…"` → identifier quoted, ignora `;`. Maneja `""`.
- `$tag$…$tag$` (dollar-quoted strings) → ignora todo hasta el cierre. Soporta tags arbitrarios incluyendo el vacío `$$…$$`.
- `--` hasta fin de línea → comentario.
- `/* … */` → comentario; soporta nesting (Postgres lo permite).

Cada `Statement` retorna `{ sql: string (sin trim global pero sin el `;` final), startOffset, endOffset }`. La función `getStatementUnderCursor(sql, cursorOffset): Statement | null` reusa el splitter y retorna la statement cuyo rango contiene al cursor (o el más cercano si está en whitespace entre dos).

**Por qué frontend**: el editor ya tiene el SQL en cliente; un trip al backend solo para split sería redundante. Además permite resaltar la statement activa visualmente sin latencia.

**Tests**: una batería sobre strings con `;` literal, dollar-quoted, comentarios anidados, y SQL real (CREATE FUNCTION con body multi-line).

### 3. Detección read-only por statement

Para cada statement individual, el backend (no el frontend) llama `is_mutating_sql(sql)`. Si la conexión es `read_only` y la heurística retorna `true`, el comando devuelve `AppError::Validation "connection is read-only"`. El frontend recibe el error con su `code` y lo renderiza en el bloque de error.

**Por qué backend**: defense-in-depth. La UI puede mostrar un banner orientativo, pero un caller programático que envíe DML directo debe ser rechazado.

**Trade-off**: la heurística falla con DML disfrazado (`DO $$ ... INSERT ... $$`). Aceptable como la realidad operativa de Postgres — `DO` ejecuta arbitrary plpgsql. Si el usuario marca read-only y luego usa `DO`, esa es decisión suya. La spec lo deja explícito como riesgo.

### 4. Cap de filas: 10 000 con marker `truncated`

El backend ejecuta el query con un `cursor` o simplemente itera el row set y corta a la 10 001 fila (descartándola y marcando `truncated: true`). No usamos cursor real (`DECLARE` + `FETCH`) en V1 — `tokio_postgres` retorna rows materializadas; aplicamos `take(10_000)` sobre el iterator y miramos si hay un siguiente. Costo: el server-side query de todos modos genera todo el plan; es una protección de **cliente**, no de carga al server. Para resultados verdaderamente enormes, el usuario añade `LIMIT`.

**Por qué fijo y no configurable**: 10k es razonable para cualquier exploración honesta; arriba de eso el grid del cliente igual se vuelve molesto. Configurable es un follow-up trivial vía `settings`.

**Alternativa descartada**: streaming con cursores — útil para "explorar resultados gigantes paginados", pero entra en conflicto con cómo el grid reusable (no-paginado) funciona. Es un change separado si llega la demanda.

### 5. Grid adhoc reusable: split de `DataGrid.tsx`

Hoy `DataGrid.tsx` mezcla render virtualizado, sort/filter server-side, scroll-to-load, edición. Para reuso lo dividimos:

- `<AdhocResultGrid columns rows onSelect />` — solo virtualización + render de celdas + selección. Recibe `columns: ColumnInfo[]`, `rows: CellValue[][]`, opcionalmente un callback `onSelectRow(rowIndex)`. NO tiene sort/filter ni edición.
- `<TableViewerGrid {…} />` — wrapper que añade sort/filter/edit/scroll-to-load encima del adhoc.

Ambos consumen el mismo `useVirtualizer` y los mismos estilos (`DataGrid.module.css` se mantiene; los selectores aplican a ambas variantes).

**Por qué split**: evita que el editor SQL acarree props que no aplican (filtros, sort callbacks, edit buffer). Mantiene una única implementación de virtualización.

**Trade-off**: refactor más amplio del que parece a primera vista. Pero pagar la deuda de dividir ahora es mejor que un fork del componente.

### 6. Inspector lateral: reuso del existente

El inspector del shell (`src/platform/shell/Inspector.tsx`) renderiza el detalle del row seleccionado para `postgres-table-data`. Esa misma lógica vale para el grid adhoc del editor: cuando hay una fila seleccionada en el resultado de un query, el inspector muestra `column → value` exactamente igual.

**Implementación**: el componente `<QueryTab>` registra un selectedRow en su contexto local; el `Inspector` ya consume el current tab payload — extendemos el tab kind para que `postgres-query` exponga `selectedRow` cuando aplica. Una simple ramificación en el inspector por `tab.kind`.

**Por qué**: si el inspector vive en el shell y se acopla al tab activo, hacer que entienda dos kinds es trivial; abrir un inspector aparte por la pestaña query rompe la convención.

### 7. Autocomplete schema-aware sin fetch nuevo

El editor monta una `CompletionSource` de CodeMirror que lee del cache del schema browser:

1. Si el cursor está después de `FROM ` / `JOIN ` / `UPDATE ` / `INTO ` (heurística posicional), ofrece schemas (lo que `postgres_list_schemas` cacheó) y, dentro de un schema dado, relaciones (`postgres_list_relations`).
2. Si el cursor está después de `<alias>.` o dentro de un `SELECT`/`WHERE` con una relación detectada, ofrece columnas — pero las columnas SOLO están disponibles si el usuario ya abrió esa tabla en algún momento (porque es el flujo que pobló las columnas). Si no, fallback a keywords.
3. Keywords SQL siempre están como completion fallback (los provee `@codemirror/lang-sql` de fábrica).

El cache del schema browser ya está en memoria como un `Map`. Lo exponemos como un hook `useSchemaCache(connectionId)` que retorna `{ schemas, relationsBySchema, columnsByRelation }`. El autocomplete consulta ese hook.

**Trade-off**: columnas solo "aprendidas" tras abrir la tabla. Aceptable para V1: en práctica, antes de escribir un query sobre una tabla, el usuario tiende a haberla mirado. Si la demanda real es autocomplete completo desde turn 0, añadimos un comando `postgres_list_columns_bulk(id, schema)` que lazy-fetch de columnas para el schema activo — ese es follow-up.

**Por qué no fetcheamos**: el dolor real es que el editor sea responsivo. Disparar fetches al teclear es UX malo; pre-cargar todas las columnas es work al boot que la mayoría no necesita.

### 8. Multi-statement: sub-pestañas en el panel de resultados

Cuando una run tiene 3 statements y devuelve 3 resultados, el panel renderiza un `<Tabs>` interno con etiquetas `1 · SELECT 200 rows`, `2 · UPDATE 5 rows`, `3 · ✓ DDL`. Cada sub-tab muestra su `RunSqlResult` (grid o summary o error). Se selecciona la primera por defecto; si una falla, esa sub-tab se enfoca automáticamente.

**Por qué**: encadenar paneles verticalmente para 5 resultados se vuelve un scroll-fest. Sub-tabs es el patrón TablePlus / DataGrip y funciona bien en este contexto.

**Implementación**: `<MultiStatementTabs results={Array<RunSqlResult | RunSqlError>} />`. CSS-only, sin librería extra (Radix tabs ya está en deps).

### 9. Persistencia in-session del buffer

`useQueryBuffer(tabId)` hace debounce 500ms y escribe a `settings` (key `pgQueryBuffer:<tabId>`). Al montar la pestaña lee el valor; al cerrar la pestaña limpia la key (cleanup). El shell no restaura tabs entre relaunches todavía, así que en la práctica el buffer sobrevive cambios de pestaña dentro de la misma sesión y nada más. Cuando el shell añada restore-tabs, esto encaja sin cambios.

**Por qué a `settings` y no a un Context volátil**: si el usuario hace ⌘W con dirty (no commiteado), el buffer SE PIERDE — el spec confirma que no confirmamos en cierre porque "es solo SQL, menos crítico que un edit buffer dirty". Si más adelante quisiéramos confirmar, ya está la persistencia lista.

**Alternativa descartada**: persistir solo en memoria por sesión (un `Map<tabId, string>` en un Context). Funciona, pero un context global cross-tabs huele a state leak. Settings con clave por tab es más limpio.

### 10. Entry points

- **Botón `+ Query` en sidebar**: cada fila de conexión activa tiene una zona de actions a la derecha (hoy con un refresh icon). Añadimos un icon button (Lucide `Terminal` o `SquarePlus`) que dispara `runQuerySqlNew(connectionId)` directamente — sin pasar por palette.
- **Palette `SQL: New Query`**: si hay sidebar focus en una conexión, dispara con esa conexión; si no, transiciona a chooser de conexiones activas (mismo patrón que `Schema: Refresh`).
- **Palette `SQL: New Query Here`**: contextual al focus actual del sidebar. Si el focus es una conexión → SQL vacío. Si es un schema → `SET search_path TO "<schema>";\n\n`. Si es una tabla/view/matview → `SELECT * FROM "<schema>"."<relation>" LIMIT 100;`.

**Por qué priorizar el botón**: la palette es power-user; el botón es discoverable. Un usuario que recién llega a Argus debería ver "ah, puedo ejecutar SQL" sin abrir un menú.

### 11. Activity-log: nuevo `kind: "run_sql"` y nuevo `metric` variant

`run_sql` aparece en el enum de kinds. El metric: si el resultado es `kind: "rows"` con N filas, `metric: { kind: "rows", value: N }`; si es `kind: "affected"` con M filas, `metric: { kind: "affected", value: M }`. Ese segundo variant es nuevo en el discriminated union y va al spec del `activity-log`.

**Origen**: siempre `"user"` (todo run-sql es activación humana). El frontend manda `origin: "user"` explícito en los dos comandos.

**Por qué un nuevo metric variant**: `count` está reservado para `count_table` (un `SELECT COUNT(*)` explícito). `affected` semánticamente es distinto: viene de `ExecuteResult::rows_affected()` de `tokio_postgres`. Tiparlo como `affected` deja el log legible ("12 affected" vs "12 rows").

### 12. Tab kind y stable id

`postgres-query` tiene tab id `pgquery:<connectionId>:<uuid>`. Cada `New Query` genera un uuid fresco; abrir múltiples pestañas para la misma conexión es válido y produce ids distintos.

**Por qué uuid y no algo determinístico**: no hay clave natural — el usuario explícitamente quiere una pestaña nueva cada vez. Reusar tabs sería confuso ("¿por qué se sobrescribió mi SQL?").

**Tab title**: por defecto `Query 1`, `Query 2`, ... incremental por conexión (counter en memoria); se puede renombrar manualmente vía double-click en el tab strip (esa funcionalidad ya existe en el shell — verificar; si no, V1 mantiene el nombre default).

### 13. Atajos del editor

CodeMirror keymap default + custom:

- `Mod-Enter` (⌘↩ en macOS, Ctrl-Enter en Linux/Windows) → run.
- `Mod-Shift-Enter` → run all (ignora cursor, ejecuta toda la pestaña como multi-statement).
- `Escape` → si hay autocomplete abierto lo cierra; si no, sin acción custom.
- `Mod-/` → toggle comment line (estándar de CodeMirror).
- `Mod-D` → multi-cursor sobre la siguiente ocurrencia (estándar).
- `Tab` / `Shift-Tab` → indent / dedent (estándar).

**Por qué ⌘↩ y no ⌘R**: ⌘R es "reload" en muchos contextos; ⌘↩ es "submit" universalmente. Además TablePlus, DataGrip, Postico ya usan ⌘↩.

### 14. Posición del error en el editor

Postgres devuelve `position` como un offset 1-based en el SQL fuente (cuando el error es de parsing). Lo extraemos del campo `position` de `tokio_postgres::Error::DbError` y lo enviamos al frontend en `error.position`. El bloque de error muestra "Error at position 47" con un botón "Show in editor" que setea el cursor en `position - 1` (CodeMirror es 0-based).

**Trade-off**: si la statement fallida es la #2 de un multi-statement, la posición es relativa a esa statement, no al SQL completo. Manejamos eso sumando el `startOffset` de la statement antes de mover el cursor.

### 15. CodeMirror montaje sin wrapper React

Sigue el patrón del proyecto: `useEffect` monta `EditorView` en un `<div ref>`, retorna cleanup. Sin `react-codemirror` ni `@uiw/react-codemirror`. El estado (`doc`, `selection`) vive en el `EditorState` de CodeMirror; el frontend lo "lee" con un `EditorView.updateListener` que dispara `onChange(sql)` debounced.

**Por qué**: react-codemirror tiene su propio ciclo y a menudo causa cuellos de botella con re-renders innecesarios. Un montaje directo es ~30 líneas y predecible.

## Risks / Trade-offs

- **Heurística `is_mutating_sql` no es bulletproof** → falla con `DO $$ ... INSERT ... $$`. Mitigación: el spec deja explícito que la heurística es "best effort" y el operador read-only es trust-based; el bind real de protección es la decisión del usuario. Si esto se vuelve un dolor real, considerar un parser SQL completo en backend (no V1).
- **Cap de 10k filas puede sentirse arbitrario** → mitigación: banner claro "Result truncated at 10,000 rows" + sugerencia de añadir `LIMIT`. Configurable es follow-up.
- **No hay cancel inflight** → si el usuario lanza un `SELECT` que tarda 60s, no hay botón de stop. Mitigación: el pool tiene un timeout total razonable; un cancel real (vía `pg_cancel_backend`) es follow-up.
- **Multi-statement no es transaccional** → cada statement commitea sola. Si falla la 3ra, las 1ra y 2da quedaron persistidas. Esto es el contrato de Postgres con statements separadas; documentado en el banner del panel "Statements run sequentially without an implicit transaction. Wrap in BEGIN/COMMIT explicitly if needed.". Mitigación: el usuario puede ejecutar `BEGIN;\n...\nCOMMIT;` manual si quiere atomicidad.
- **Autocomplete de columnas requiere tabla previamente abierta** → mitigación: documentado; un follow-up trivial añade lazy-load on demand.
- **Pestañas duplicadas con UUIDs**: si el usuario crea 50 pestañas de query, no hay agregación. Mitigación: el shell ya soporta cerrar pestañas con `⌘W`; el usuario es responsable de su clutter. Una funcionalidad "tab pinning" es independiente del shell.
- **Statement-bajo-cursor falla en SQL malformado**: si el usuario tiene un `'` sin cerrar, el splitter reporta una sola statement gigante. Mitigación: aceptable — Postgres devolverá un error de parse claro; el cursor está donde el usuario espera.
- **CodeMirror bundle size**: `@codemirror/*` agrega ~150-200KB minified. Mitigación: aceptable para desktop app; tree-shaking de Vite reduce lo importable.
- **Inspector reflejando el grid adhoc**: el inspector tiene que saber qué tab está activo y leer su `selectedRow`. Riesgo de accoplamiento entre `app-shell` e implementación de `postgres-query`. Mitigación: el shell ya tiene el patrón con `postgres-table-data` — extender sigue la misma forma.

## Migration Plan

No hay migración de datos: change aditivo. Pasos de despliegue dentro de la sesión:

1. Backend: añadir `src-tauri/src/modules/postgres/sql.rs` con `RunSqlResult`, `RunSqlError`, `postgres_run_sql`, `postgres_run_sql_many`. Implementar el cap de 10k. Tests unitarios cubriendo: SELECT puro, INSERT con returning, DDL, error con position, multi-statement con falla intermedia, read-only enforcement.
2. Backend: registrar los dos comandos en `commands.rs` y en el `invoke_handler` del módulo Postgres.
3. Backend: extender `ActivityLogEntry` y el helper de emisión para soportar `kind: "run_sql"` y `metric: { kind: "affected", value }`.
4. Frontend: dependencias CodeMirror — `pnpm add @codemirror/state @codemirror/view @codemirror/commands @codemirror/language @codemirror/autocomplete @codemirror/search @codemirror/lang-sql`.
5. Frontend: refactor de `DataGrid.tsx` → extraer `<AdhocResultGrid />`; ajustar `TableViewerTab` para usar el nuevo wrapper. Verificar que el flujo edit no se rompió (snapshot tests visuales si existen).
6. Frontend: nuevo subdirectorio `src/modules/postgres/sql/` con `QueryTab.tsx`, `QueryEditor.tsx`, `useQueryAutocomplete.ts`, `useQueryRun.ts`, `ResultPanel.tsx`, `ResultErrorBlock.tsx`, `MultiStatementTabs.tsx`, `useQueryBuffer.ts`, `splitStatements.ts` + tests.
7. Frontend: registrar el tab kind `postgres-query` en el `TabRegistry` con su renderer.
8. Frontend: extender `useSchemaCache` (o crearlo si no existe como hook estable) que exponga `{ schemas, relationsBySchema, columnsByRelation }`. Añadir el paso de "guardar columnas tras query_table" al ciclo de vida del table viewer (es información que ya circula; sólo hay que cachearla).
9. Frontend: registrar los dos comandos de palette y el botón `+ Query` en cada fila de conexión activa de `SchemaTree.tsx`.
10. Frontend: extender el inspector del shell para reaccionar a tab kind `postgres-query` (renderiza `selectedRow` cuando aplica, igual que `postgres-table-data`).
11. Manual QA: contra una BD local con tabla simple, vista, función con `RETURNS TABLE`, ejecución de SELECT > 10k filas, ejecución de DDL, error de sintaxis, multi-statement con falla intermedia, run-sql en conexión read-only (rechazo backend), botón `+ Query` desde sidebar.
12. Actualizar `openspec/ROADMAP.md`: marcar #6 como completado tras merge.

**Rollback**: revertir el commit. Sin datos persistidos al feature en disco que no sean los `pgQueryBuffer:*` keys; al retirar el feature, esas keys quedan huérfanas y son inertes.

## Open Questions

- **Renombrar pestañas de query**: ¿soportamos rename inline en V1 o el default `Query 1` es suficiente? Probablemente suficiente; rename es follow-up.
- **Auto-cargar columnas para autocomplete completo**: ¿añadimos `postgres_list_columns_bulk(id, schema)` que se dispara on-demand cuando el editor monta y la conexión está activa? Si los QA reales muestran que el autocomplete vacío es molesto, se añade. Default: no, V1 opera sólo con lo que el sidebar/viewer ya cargó.
- **`SET search_path` sticky por pestaña**: hoy cada `postgres_run_sql` toma un client del pool y lo libera. Si quisiéramos que `SET search_path TO "x"` perdure entre runs en la misma pestaña, habría que mantener un client pinned por tab. Es un cambio de modelo significativo (pool no devuelve el client) y abre la puerta a leaks. Default V1: no perdura — el usuario incluye `SET` en su multi-statement si lo necesita.
- **Cancel inflight (`pg_cancel_backend`)**: puede ser un mini-change separado (`cancel-running-query`) si la demanda real aparece. Por ahora confiamos en el timeout del pool (que existe pero conviene confirmar el valor exacto durante la implementación — 30s o 60s).
- **Token visual para "executando"**: durante el run, el editor muestra un `--accent-soft` border o un spinner inline en el panel? Decisión durante implementación, mirando `DESIGN.md`.
- **Grid adhoc: split en `<AdhocResultGrid />` y `<TableViewerGrid />`** — ¿uno hereda del otro o ambos componen un primitive más profundo (`<VirtualizedGrid />`)? Decisión de implementación; el spec describe el contrato externo, el split interno es libre siempre que `postgres-table-data` no regrese.
