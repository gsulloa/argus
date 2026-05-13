## Why

Hoy en el viewer de Postgres el usuario solo puede editar una celda a la vez. Cuando necesita poner el mismo valor en una columna sobre 20, 100 o 1000 filas (por ejemplo `status = 'archived'`, `processed_at = NULL`, `region = 'cl'`), tiene que hacer doble-click fila por fila. El backend `postgres_apply_table_edits` ya commitea N ops en una sola transacción — la limitación es puramente UI: falta selección múltiple y una acción de "bulk-set" sobre la selección.

## What Changes

- **Selección por arrastre en el grid**: mouse-down sobre el área de fila + drag vertical extiende la selección desde la fila de inicio hasta la fila bajo el cursor. Mouse-up confirma la selección. La selección puede tener 1..N filas contiguas.
- **Modo de edición depende del tamaño de la selección**:
  - **0 o 1 fila seleccionada** → sin cambios: doble-click en una celda abre el `EditableCell` inline como hoy; el inspector lateral muestra la fila activa en modo solo-lectura como hoy.
  - **≥2 filas seleccionadas** → el inspector lateral entra en **modo bulk edit**: el doble-click inline en celdas queda deshabilitado y la edición ocurre exclusivamente desde el inspector.
- **Bulk edit en el inspector**:
  - Cada columna editable (no-PK, no-binary, no-envelope) se renderiza como un campo con input adaptado al `data_type` (idéntico al `InspectorEditableField` existente).
  - **Valor inicial del campo**: si todas las filas seleccionadas elegibles comparten exactamente el mismo valor en esa columna, el campo arranca con ese valor (en estado pristine). Si las filas tienen valores distintos, el campo arranca **vacío** con placeholder `— multiple values —`.
  - **Estado "tocado"**: tan pronto como el usuario interactúa con un campo (teclea, cambia un select, toggle de boolean), ese campo entra en estado *touched* y se marca con un punto/borde indicador. Un botón pequeño `↺` junto al campo permite revertir un campo tocado al pristine.
  - **NULL**: tocar un campo y dejarlo vacío commitea `NULL` para esa columna en todas las filas seleccionadas (estado touched + texto vacío ≠ pristine).
- **Apply to N rows**: al pie del cuerpo del inspector, un botón `Apply to N rows` está habilitado cuando hay ≥1 campo tocado. Al hacer click, valida los campos tocados (JSON strict-parse, etc.), y si todos pasan, hace **una sola** acción agrupada en el buffer: por cada (fila elegible × campo tocado) se registra un `setCellEdit`, todos como una sola entrada en el undo stack. Si una validación falla (JSON inválido en un campo tocado), el commit se aborta, no se modifica el buffer, y el campo problemático muestra el error inline (mismo patrón ya existente).
- Filas `insert` dentro de la selección son ignoradas por el bulk apply (no tienen PK servidor). Filas marcadas para `delete` también son ignoradas. El contador del botón (`Apply to N rows`) refleja el conteo **efectivo** post-filtrado.
- **Bottom bar refleja la selección**: cuando hay ≥2 filas seleccionadas, muestra el contador `N rows selected` con un botón "Clear" que limpia la selección sin tocar el buffer.
- **Backspace (`⌫`)** ahora marca delete sobre todas las filas server-selected (extendiendo el comportamiento actual de fila única). Filas `insert` seleccionadas se eliminan del buffer como hoy. Todo se agrupa en una sola entrada del undo stack.
- **`⌘S` / Save** no cambia: el backend ya soporta N updates por transacción; un bulk-apply de 200 filas con 3 campos tocados se serializa como 200 `EditOp.update` (cada uno con 3 columnas en `changes`) y se commitea atómicamente.
- **Sin cambios** al `EditableCell` inline: su API se mantiene; el bulk vive 100% en el inspector.

## Capabilities

### New Capabilities
(none — esta funcionalidad extiende capabilities existentes de Postgres)

### Modified Capabilities
- `postgres-data-grid`: agrega el modelo de selección multi-fila por arrastre (reemplaza `selectedRowIndex: number | null` por un rango), renderizado del estado seleccionado sobre múltiples filas, y el chip en el bottom bar.
- `postgres-data-edit`: agrega el modo bulk-edit en el inspector lateral (campos pristine/touched, placeholder `— multiple values —`, botón `Apply to N rows`, expansión a entradas batched del buffer), deshabilita el doble-click inline cuando hay ≥2 filas seleccionadas, y extiende `⌫` para marcar delete sobre N filas. El backend (`postgres_apply_table_edits`, builder de SQL, payload `EditOp`) **no cambia** — los N×M sets se traducen a N `EditOp.update` independientes cuyo `changes` agrupa las M columnas tocadas.

## Impact

**Código afectado (frontend, módulo Postgres):**
- `src/modules/postgres/data/DataGrid.tsx`: estado de selección (anchor + active), handlers `onMouseDown`/`onMouseMove`/`onMouseUp` a nivel de body. Deshabilita el doble-click inline en el `EditableCell` cuando el conteo de selección es ≥2.
- `src/modules/postgres/data/Inspector.tsx`: nuevo prop `selectedRows: Array<{ rowKey, row, pk } | InsertRowRef>` (en lugar del actual `row + rowKey` single). Cuando el conteo elegible es ≥2 entra en modo bulk: cada `InspectorEditableField` (o un componente nuevo `InspectorBulkField`) maneja estado `touched`, placeholder `— multiple values —`, botón `↺` por campo, y debajo del cuerpo se renderiza un botón sticky `Apply to N rows`. En modo single (0/1 filas) mantiene el comportamiento actual.
- `src/modules/postgres/data/TableViewerTab.tsx`: orquesta selección ⟷ inspector ⟷ buffer. Resuelve la lista de filas seleccionadas elegibles desde el `selection` rango + el buffer de viewer rows.
- `src/modules/postgres/data/BottomBar.tsx`: agrega el chip `N rows selected` con botón Clear.
- `src/modules/postgres/data/Inspector.module.css`: estilos para el indicador touched, el botón revert por campo, el placeholder de "multiple values" y el footer del Apply button.
- `src/modules/postgres/data/DataGrid.module.css`: estilos para `data-selected="true"` aplicados a múltiples filas (ya existe el token para una; reutilizar `--accent-soft`).

**Sin cambios:**
- Backend Rust (`src-tauri/src/modules/postgres/edit.rs`, `binding.rs`): el contrato de `postgres_apply_table_edits` y `EditOp` se mantienen idénticos.
- Tipos compartidos (`src/modules/postgres/data/types.ts`): sin cambios.
- DynamoDB: fuera de scope (su selección múltiple es otro stream de trabajo, ya esbozado en `dynamo-data-view`).

**Dependencias:** ninguna nueva. Reutiliza `@tanstack/react-virtual`, el `useEditBuffer` existente, y los tokens de `DESIGN.md`.

**Riesgos:**
- Drag-selection sobre filas virtualizadas: al hacer drag más allá del viewport, el virtualizer puede no haber montado las filas; necesitamos un auto-scroll mientras se arrastra cerca del borde superior/inferior, y trabajar con índices (no con elementos DOM).
- Performance: bulk-apply de 1000 filas × M campos tocados dispara 1000×M `setCellEdit`. El reducer debe hacer un solo dispatch batch (action `bulk-set-cell` con todas las entradas) en lugar de N×M dispatches sucesivos.
- UX: si el usuario sin querer arrastra al hacer un click normal, no debe seleccionar 2 filas. Threshold de 4px de movimiento antes de iniciar drag.
- UX inspector bulk: distinguir visualmente pristine vs touched es crítico — si el usuario no nota el indicador puede creer que "vacío" siempre significa NULL. Usar borde de color accent + dot + botón ↺ explícito sobre fields touched.
- Estado del inspector cross-row: hoy el inspector usa `key={rowKey:colName}` para forzar remount entre filas. En modo bulk, el "rowKey" es la lista de filas seleccionadas; al cambiar la selección (drag a un rango distinto) el inspector debe remount/reset todos los campos para no contaminar entre selecciones.
