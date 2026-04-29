## Why

Argus ya tiene un viewer de tablas usable, pero sigue siendo solo lectura. Para reemplazar TablePlus en el día a día necesitamos editar datos: corregir un valor, insertar una fila de prueba, borrar una basura. Sin esto, cada cambio obliga a saltar a `psql` o TablePlus y se rompe el flujo. Esta rebanada cierra el ciclo "ver → editar → guardar" estilo TablePlus, con buffer local, diff preview antes de commit, y commit transaccional. La edición avanzada de tipos (jsonb editor visual, array editor) queda fuera para mantener la rebanada manejable.

## What Changes

- Modo editable en la grid `postgres-table-data` cuando la conexión NO es read-only: doble click sobre celda activa edición in-place; tipo del input se decide por el `data_type` Postgres (texto corto = input, texto largo / `text` / `jsonb` / `_text` = textarea con monoespaciado, booleanos = checkbox, enums = select, `null`-able = atajo para `NULL`).
- Buffer local de cambios pendientes por pestaña: cada celda editada queda marcada "dirty" con color distinto; el buffer NO toca la BD hasta el commit.
- Botón "+" en la barra inferior crea una fila nueva editable que queda dirty con kind `insert` hasta commit; la PK puede dejarse en blanco si tiene default (Postgres la rellena).
- Delete: seleccionar una o varias filas + `⌫` (o botón en barra) las marca como `delete` en el buffer, render tachado; deshacer con `⌘Z` mientras la fila siga dirty.
- `⌘S` o el botón Save aplica directo: ejecuta `BEGIN; ...; COMMIT;` en una sola transacción a través de un nuevo helper `executeMutation` del pool. No hay modal de preview — la fricción del modal terminó siendo más molesta que útil; el activity-log y el grid muestran el resultado.
- Cualquier error hace `ROLLBACK` completo, deja el buffer intacto y muestra el error en un banner sticky encima del grid (mensaje + SQLSTATE + `failed_op_index` 1-based).
- Tras un commit exitoso el buffer se vacía, las filas insertadas pasan a ser parte del buffer normal con sus PK asignadas, y la grid refresca solo las filas afectadas (no recarga toda la página).
- `postgres_apply_table_edits(connectionId, schema, relation, edits)` es el comando IPC nuevo; recibe el buffer del frontend, valida shape y tipos, y ejecuta la transacción server-side. Read-only enforcement vive en la pool helper, no en el comando.
- El SQL builder hace cast explícito `$N::<data_type>` en cada placeholder de SET/VALUES/WHERE para que `tokio-postgres` no falle al bindear strings contra columnas no-textuales (uuid, jsonb, timestamp, integer, etc.). Los valores viajan como `Option<String>`; Postgres los convierte server-side.
- El backend identifica filas existentes por su PK; si la tabla no tiene PK, todas las celdas existentes se vuelven read-only en UI y solo `INSERT` queda habilitado (con un banner explicativo "Esta tabla no tiene PK; no se puede editar ni borrar filas existentes").
- En conexiones `read_only: true`, toda la UI de edición queda deshabilitada (doble click no entra a edit, botón `+` no aparece, `⌫` no marca delete) y el backend rechaza el comando con `AppError::Validation` "connection is read-only" si llega a recibirse.
- Activity-log: el commit emite un evento `kind: "apply_edits"` con el SQL completo de la transacción concatenado y un `metric: { kind: "rows", value: <total rows affected> }`.

## Capabilities

### New Capabilities

- `postgres-data-edit`: comando IPC `postgres_apply_table_edits` que ejecuta una transacción de edits desde el frontend buffer (con cast `::<type>` por placeholder), helper `executeMutation` que respeta `read_only`, modelo de buffer dirty (insert/update/delete), banner de error inline, integración con activity-log.

### Modified Capabilities

- `postgres-data-grid`: la grid expone modo editable; las celdas dirty pintan con `--accent-soft`; las filas marcadas para delete renderizan con texto tachado; barra inferior gana botones "+" y "Save" + indicador de cambios pendientes; el inspector del row seleccionado deja de ser estrictamente read-only y refleja edits sobre esa fila. Reactivar la pestaña con buffer dirty NO descarta el buffer.
- `postgres-connection`: añade `executeMutation(id, sql, params)` al pool helper (ya enunciado en el spec actual como contrato pero sin implementación); rechaza con `AppError::Validation "connection is read-only"` cuando el flag está activo. Añade un comando interno `postgres_table_primary_key(id, schema, relation)` reusado por la edición para conocer la PK.
- `activity-log`: el set de `kind` se amplía con `apply_edits`; mapping de metric añade `apply_edits → { kind: "rows", value: <total rows affected> }`. (Versiones anteriores de este change también añadían `preview_edits`; ese fue eliminado al simplificar el flujo de save.)

## Impact

- **Backend**: nuevo módulo `src-tauri/src/modules/postgres/edit.rs` con `postgres_apply_table_edits` y un builder de SQL para `UPDATE / INSERT / DELETE` parametrizado. Implementación real de `executeMutation` en `pool.rs` (hoy stub o ausente). Nuevo `postgres_table_primary_key` en `data.rs` o en `schema.rs` para lookup de PK desde `pg_index` + `pg_attribute`.
- **Frontend**: extender `src/modules/postgres/data/` con `useEditBuffer.ts` (buffer dirty + undo), `EditableCell.tsx` (renderiza el input adecuado por tipo), `DiffPreviewDialog.tsx`, `useTablePrimaryKey.ts`. Modificar `DataGrid.tsx`, `BottomBar.tsx`, `Inspector.tsx` para conectar el buffer.
- **Atajos**: `⌘S` en la pestaña table-data abre el diff preview; `⌫` con filas seleccionadas marca delete; `⌘Z` deshace el último edit del buffer; `Escape` durante edición de celda cancela.
- **Settings**: ninguna nueva.
- **Out of scope**: editor visual de jsonb (texto plano por ahora), editor visual de array (texto plano), edición de columnas con tipos compuestos / row types, edición masiva tipo "find & replace", merge / upsert, soporte para tablas sin PK más allá de insert.
- **Out of scope para esta rebanada**: edición de schema (ALTER TABLE, etc.) — eso es un change futuro `edit-postgres-schema` (V1.5).
