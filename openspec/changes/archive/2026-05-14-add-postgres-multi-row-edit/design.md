## Context

El `DataGrid` actual mantiene `selectedRowIndex: number | null` y el `useEditBuffer` opera fila-por-fila. El backend (`postgres_apply_table_edits`) ya recibe `Vec<EditOp>` y los commitea en una transacción, sin límite duro de tamaño más allá del timeout de 15s.

Las filas vienen virtualizadas (`@tanstack/react-virtual`, overscan=12), con `rowKey` único por fila (`buildRowKey(pk)` para server rows, `insert:<uuid>` para nuevas). El index posicional (`rowIndex`) es estable solo dentro de una sesión de scroll/sort/filter — un sort change resetea el buffer de filas. Esto importa: una selección debe sobrevivir scroll y paginación de tail, pero **no necesita sobrevivir** cambios de sort/filter (resetear con el buffer es aceptable y consistente con el comportamiento actual).

Stakeholders: usuarios power que hacen mantenimientos de datos (bulk archive, bulk-reassign, fix de imports). Constraint estética: la selección debe rendir el accent `#A855F7` sobre `--accent-soft` sin introducir bordes ni gradientes — leer `DESIGN.md`.

## Goals / Non-Goals

**Goals:**
- Permitir seleccionar un rango contiguo de filas arrastrando el mouse en el grid.
- Permitir editar **una o varias columnas** simultáneamente sobre todas las filas seleccionadas desde el inspector lateral, con un único botón "Apply to N rows" al pie.
- Mantener el commit transaccional existente: bulk apply de N filas × M campos = N `EditOp.update` (con M columnas en `changes` cada uno) en una sola llamada a `postgres_apply_table_edits`.
- Mantener el flujo single-row idéntico cuando hay 0 o 1 fila seleccionada: doble-click inline en celdas + inspector solo-lectura.
- Extender `⌫` para bulk-delete sobre la selección.

**Non-Goals:**
- Selección no-contigua (Cmd+Click) — el usuario explícitamente eligió drag-only.
- Selección rectangular de celdas (Excel-like).
- Paste desde clipboard de un rectángulo de celdas.
- Edición inline de celdas en modo multi-selección (deshabilitada deliberadamente; la edición vive en el inspector).
- Aplicar valores diferentes a distintas filas en un mismo gesto (todos los campos tocados aplican el mismo valor a todas las filas elegibles).
- Cambios en el backend Rust ni en los specs de `postgres-connection`/`postgres-table-structure`.
- Selección multi-fila en el viewer de DynamoDB.

## Decisions

### 1. Modelo de selección: `{ anchor: number | null, active: number | null }` con derivado `selectedIndices`

**Decisión:** Reemplazar `selectedRowIndex: number | null` por un par `{ anchor, active }` donde `anchor` es la fila donde inició el drag (mouse-down) y `active` es la fila bajo el cursor (mouse-move / mouse-up). El set de filas seleccionadas se deriva como `[min(anchor, active), max(anchor, active)]` inclusive. Cuando `anchor === null`, no hay selección. Cuando `anchor === active`, hay 1 fila seleccionada (caso indistinguible del single-select de hoy).

**Alternativa considerada:** `Set<number>` libre. Rechazado: el usuario pidió drag-only contiguo; un set libre invita a Cmd+Click después y obliga a manejar pseudo-rangos. Y al borrar/insertar filas el set queda desreferenciado, mientras que el rango se reconstruye trivialmente.

**Alternativa considerada:** `Set<RowKey>` en vez de `Set<number>`. Rechazado para esta capability: los índices son lo natural para drag-range y para virtualization. Si más adelante queremos persistir la selección a través de un sort change, migramos a `RowKey[]`. Por ahora, sort change limpia la selección (consistente con el reset de buffer).

### 2. Drag-to-select: threshold + auto-scroll + capturas a nivel `body`

**Decisión:** Sobre el contenedor `styles.body` (no sobre cada `styles.row`), montar handlers `onMouseDown`, `onMouseMove`, `onMouseUp`. Mouse-down captura `anchor = rowIndexBajoCursor` y `active = anchor` pero **NO commit a la selección visible hasta superar 4px de movimiento**. Hasta entonces, comportarse como single-click (al `onMouseUp` sin drag, toggle selección de la fila como hoy).

Mouse-move (durante drag activo) recalcula `active = pixelY → rowIndex` mediante `Math.floor((scrollTop + clientY - bodyTop) / ROW_HEIGHT)`. Auto-scroll: si `clientY < bodyTop + 20px`, scroll up a `velocity = (20 - dy) * 0.5 px/frame`; análogo abajo. Implementar con `requestAnimationFrame` mientras el flag `dragging` esté activo y el cursor en zona de borde.

`onMouseUp` cierra el drag. Si el drag superó el threshold, la selección queda fija en `[anchor, active]`. Si no, single-click. Listener global de `mouseup` (en `document`) para capturar el caso de soltar fuera del grid.

**Alternativa considerada:** Pointer events con `setPointerCapture`. Equivalente funcional pero `setPointerCapture` sobre el body de un grid virtualizado puede atrapar eventos que el virtualizer necesita; mouse events con listener global son más simples y suficientes (no necesitamos soporte touch para esta iteración).

### 3. Bulk editor vive en el inspector lateral, NO en el `EditableCell`

**Decisión:** Cuando el conteo de selección efectiva (post-filtrado) es ≥2, el inspector lateral entra en modo bulk:

- Cada columna editable se renderiza con un input adaptado al tipo (el mismo `InspectorEditableField` actual sirve de base; se introduce un componente derivado `InspectorBulkField` con estado adicional).
- **Valor inicial**: si `every(row in selection).cell[col] === firstRow.cell[col]`, el campo arranca con ese valor común (mostrado normalmente, en estado pristine). Si hay variación, el campo arranca con `value = null` interno y placeholder `— multiple values —` en el input.
- **Estado `touched`**: bandera local por campo (`useState<boolean>(false)`). Cualquier `onChange` la sube a `true`. Un campo touched se distingue por un borde acentuado y un dot indicador junto al label.
- **Botón `↺` revert**: visible solo cuando `touched === true`. Hace `touched = false` y resetea el contenido al valor pristine (común o vacío con placeholder).
- **NULL**: si `touched === true` y el contenido del input es vacío (o `null` en boolean/enum), el valor aplicado para esa columna es `null`.
- **Footer del inspector**: cuando hay ≥2 filas en la selección efectiva, debajo del cuerpo se renderiza un footer sticky con: `Apply to <N> rows` (button primary), `Cancel` (deselecciona / limpia los touched). El button está habilitado solo si ≥1 campo está touched.

**Alternativa considerada:** Reutilizar el `EditableCell` inline en modo bulk (la versión anterior de este design). Rechazado por feedback del usuario: prefiere editar varios campos antes de commitear, lo cual no encaja en el flujo doble-click + Tab.

**Alternativa considerada:** Modal flotante separado. Rechazado: el inspector ya es la superficie semántica natural para "ver/editar valores de las filas seleccionadas". Reutilizarlo evita una nueva superficie y mantiene la consistencia con single-row inspect.

**Alternativa considerada:** Checkbox por campo "include in apply". Rechazado: agrega un click extra para el caso más común (tocar y aplicar). El estado `touched` implícito + botón `↺` para revertir es más fluido.

### 4. Doble-click inline deshabilitado cuando hay ≥2 filas seleccionadas

**Decisión:** En `DataGrid`, cuando `effectiveSelectionCount >= 2`, el handler de doble-click sobre celdas es no-op (no abre el `EditableCell`). El indicador visual del estado bulk es: el inspector mostrando los campos editables + el chip `N rows selected` en el bottom bar. El cursor sobre celdas vuelve a `default` (no `text`) para señalar que el inline no aplica.

**Alternativa considerada:** Permitir que el inline siga activo y aplique solo a la fila bajo el cursor incluso con multi-selección. Rechazado: introduce ambigüedad ("¿este cambio aplica a 1 o a las N?"). Un solo modo a la vez es más predecible.

**Alternativa considerada:** El doble-click inline aplica al instante al bulk (saltándose el inspector). Rechazado: duplica la superficie de bulk-edit y contradice el feedback del usuario que prefiere el inspector.

### 5. Batched bulk-action del reducer + filtrado de filas elegibles

**Decisión (reducer):** Agregar un action al reducer `useEditBuffer`: `{ type: "bulk-set-cell", entries: Array<{ rowKey, column, value, pk, originalRow, originalColumns }> }`. El reducer lo procesa en una sola pasada, registra **un solo entry en el undo stack** (un `undo` revierte todo el bulk apply) y emite un solo render. Exponer como `buffer.bulkSetCellEdit(entries)`.

Cuando el usuario hace `Apply to N rows`, el caller en `TableViewerTab` construye `entries = touchedFields.flatMap(field => eligibleRows.map(r => ({ rowKey: r.rowKey, column: field.name, value: field.value, pk: r.pk, originalRow: r.row, originalColumns })))`. Cardinalidad: `M_touched × N_effective`. Un solo dispatch.

**Alternativa considerada:** Iterar `for (row of eligible) for (field of touched) buffer.setCellEdit(...)` en el caller. Rechazado: 1000 filas × 5 campos = 5000 dispatches de React, congela la UI.

**Alternativa considerada:** Que el undo revierta fila-por-fila o campo-por-campo. Rechazado: el usuario apretó **un** botón ("Apply to N rows"); un solo `⌘Z` debe revertir el gesto completo.

**Decisión (filtrado de filas elegibles):** El cómputo `eligibleRows` se hace una sola vez al detectar el cambio en `selection` (memoizado). Reglas:
- `row.source === "insert"` → excluida (sin PK servidor).
- `buffer.isRowDeleted(row.rowKey)` → excluida.
- `!row.rowKey` → excluida (defensa).
- `pkColumns === null` (relation sin PK) → todas las filas server son excluidas; en este caso el inspector bulk no debería abrirse: muestra un banner `Bulk edit unavailable on relations without a primary key`.

**Decisión (filtrado de columnas editables):** Una columna se renderiza en modo bulk si:
- NO es PK del relation (`!pkColumns.includes(col.name)`).
- NO es `bytea` (`!looksLikeBytea(col.data_type)`).
- NO está presente como `cell envelope` en ninguna de las filas seleccionadas (si al menos una fila tiene envelope en esa columna, la fila no permite editar esa columna de forma segura; mostrar el campo deshabilitado con tooltip).
- La conexión no es read-only.

El conteo del botón `Apply to N rows` muestra el número de **filas efectivas** (`eligibleRows.length`). Si baja de 2 dinámicamente (porque el usuario marcó delete o el rango cambió), el inspector vuelve a modo single.

### 6. Rendering del estado seleccionado

**Decisión:** Por cada `vi` en `virtualizer.getVirtualItems()`, calcular `selected = vi.index >= rangeStart && vi.index <= rangeEnd`. Pasar `data-selected="true"` al `<div>` de la fila, exactamente como hoy. CSS existente (`[data-selected="true"] { background: var(--accent-soft); }`) ya cubre el caso multi. Sin nuevos tokens en `DESIGN.md`.

Inspector:
- Si `effectiveCount === 0`: empty state como hoy.
- Si `effectiveCount === 1`: inspector single-row como hoy (campos editables single, sin footer).
- Si `effectiveCount >= 2`: inspector en modo bulk (todos los campos en bulk con placeholder/touched, footer con `Apply to N rows`).
- Header del inspector muestra `Inspector · <N> rows selected` en modo bulk para feedback inmediato.

### 7. Bottom bar: chip de selección

**Decisión:** Cuando `selectedCount >= 2`, mostrar un chip a la izquierda del contador de dirty: `<N> rows selected · <button>Clear</button>`. El botón Clear setea `{ anchor: null, active: null }` sin tocar el buffer. Usar tokens `--accent-soft` (background) y `--accent` (texto) de `DESIGN.md`. Sin chip cuando `selectedCount < 2` (un cambio purista respecto al "siempre mostrar selected: 1" — mantenemos zero-noise).

### 8. `⌫` con selección múltiple

**Decisión:** El handler `onGridKeyDown` actual itera el `selectedRowIndex` único. Cambiarlo a iterar el rango `[rangeStart..rangeEnd]`. Para cada índice:
- Si la fila es `insert`: `buffer.removeInsertRow(rowKey)`.
- Si la fila es `server` con PK y no estaba marcada: `buffer.markRowDelete(rowKey, pk)`.
- Si ya estaba marcada para delete: `markRowUndelete(rowKey)`.

Las tres operaciones se agrupan en un nuevo action `bulk-delete-toggle` análogo al `bulk-set-cell` para un solo undo y un solo render.

## Risks / Trade-offs

- **Drag fuera del viewport con virtualization** → Si el usuario arrastra hacia abajo a fila 50000 pero el virtualizer solo tiene montadas las filas 0-50, el cálculo `pixelY → rowIndex` igual funciona (usa scroll position, no presencia DOM). El auto-scroll dispara el virtualizer a montar nuevas filas; sin DOM no hay flicker. Mitigation: testear con un buffer de 10k filas.
- **Drag accidental** → Threshold de 4px antes de comprometerse a drag-mode; clicks normales no afectados. Mitigation: cubrir con un test de "click sin movimiento sigue siendo single-select".
- **Bulk apply de 1000 filas × 5 campos → 1000 `EditOp` (cada uno con 5 columnas en changes) → potencial timeout de 15s** → A 1ms/op promedio de Postgres, 1000 ops caben holgadamente. Pero un UPDATE con índices complejos o triggers podría tardar 50ms/op → 50s, exceder el timeout. Mitigation: dejarlo como issue conocido; el usuario verá el `op_failed` con código de timeout y puede dividir manualmente. (Una mitigación futura sería chunking client-side de N=200; fuera de scope de este change.)
- **Undo de un bulk apply en un solo `⌘Z`** → El reducer guarda un único `UndoEntry` con todas las `entries` (`M_touched × N_eligible`) para revertir. Memoria: 5000 entradas × ~200 bytes ≈ 1MB por entrada del stack. Aceptable.
- **Cambio de sort durante una selección activa** → Reset de la selección (consistente con reset del buffer). El usuario re-selecciona. No introducir "selección persistente cross-sort" sin más data points de UX.
- **Inspector bulk con cambios touched pendientes y el usuario cambia la selección** → Los campos touched se pierden silenciosamente (porque al cambiar la selección el inspector remountea con nuevas filas). Esto es aceptable: el modo bulk es ephemeral hasta el Apply, equivalente a haber cerrado un editor sin Tab. Mitigation: si llega a ser un problema, mostrar una confirmación cuando el usuario cambia la selección con campos touched (fuera de scope inicial).
- **Confusión NULL vs skip** → Sin diferenciación clara, el usuario podría creer que un campo vacío en pristine aplica NULL. Mitigation: el indicador touched (borde + dot) y el botón `↺` son explícitos; el placeholder `— multiple values —` se renderiza con `color: var(--muted)` y desaparece al teclear (state touched). Documentar en tooltip del botón Apply: "Solo aplica los campos marcados con ●".
- **Bulk apply sobre rango que cruza filas `insert`** → Los inserts viven en el tope; el rango bajo selección probablemente no los toque salvo que el usuario arrastre desde fila 0. El filtro de elegibilidad las salta silenciosamente; el contador del Apply button reporta el conteo post-filtro.
- **Tests E2E**: No hay framework E2E de DataGrid hoy; los tests Vitest del `useEditBuffer` cubren el bulk action. La drag-selection y el inspector bulk se verifican manual en dev.
