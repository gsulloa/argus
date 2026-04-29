## Context

`view-table-data` ya está mergeado: la pestaña `postgres-table-data` muestra un grid virtualizado, sort + filter server-side, scroll-to-load por LIMIT/OFFSET, inspector lateral, page-size persistente, todo read-only. Esta rebanada añade edición.

**Estado actual relevante**:

- `PgPoolRegistry` distingue `executeQuery` (lectura) y `executeMutation` (mutación). El spec ya dice que `executeMutation` "rechaza con `AppError::Validation` cuando `read_only`", pero hasta ahora no había caller — la primera implementación real llega en este change. Tenemos que verificar que el helper realmente exista vs que sea solo el contrato.
- `postgres_query_table` devuelve `columns` con `name`, `data_type`, `ordinal_position`, `is_nullable`. NO devuelve la PK; la edición la necesita.
- Las filas vienen como `Vec<Vec<CellValue>>` indexadas por posición de columna. El `CellValue` envelope para `bytea` / `truncated text` significa que algunas celdas no traen el valor real — solo preview. Para esas celdas, edición debe estar deshabilitada (no podemos pretender que el usuario edite a partir de un preview).
- `useTableData` mantiene un buffer de filas paginadas en memoria. El buffer ya existe; necesitamos un buffer **paralelo** de edits (no mutar el buffer original — queremos poder distinguir "valor real en BD" vs "valor que el usuario tipeó pero no commiteó").
- Tabs no persisten estado entre sesiones de app — si el usuario cierra Argus con cambios pendientes, los pierde. Mantenemos esa convención (warn al cerrar pestaña con dirty buffer).
- DESIGN.md fija accent `#A855F7` y `--accent-soft` para estados activos. Usamos un nuevo token `--warning` (o un soft amarillo similar) para celdas dirty si DESIGN.md ya lo tiene; si no, reusamos `--accent-soft` con un border hint y dejamos pendiente formalizar el token cuando salga la primera review visual.

**Constraints**:

- El módulo Postgres se mantiene autocontenido. La edición vive en `postgres-data-edit` (capability nueva), no se filtra a `app-shell`.
- No introducir un buffer global cross-tab — cada pestaña tiene su propio buffer dirty. Al cerrar la pestaña, si hay dirty, confirmar descarte.
- Read-only enforcement vive en el pool helper (server-side), no solo en UI. La UI deshabilita afordances pero un caller programático que llame a `postgres_apply_table_edits` directamente debe ser rechazado.
- La transacción tiene que ser **una sola**. No partirla en N transacciones por kind. El usuario espera atomicidad estilo TablePlus.

## Goals / Non-Goals

**Goals**:

- Editar celdas individuales con input tipado por tipo Postgres.
- Insertar y borrar filas con buffer local previewable.
- Diff preview antes de commit, con SQL real visible.
- Commit transaccional con rollback completo en error.
- Read-only enforcement server-side robusto (no solo UI).
- Refresh quirúrgico tras commit (no recargar toda la página, solo las filas afectadas).
- Mantener el buffer si el usuario cambia de pestaña y vuelve.

**Non-Goals**:

- Editor visual de jsonb / array (V1 = texto plano editado como string; el backend valida que sea JSON parseable cuando el tipo es `jsonb`).
- Editor visual de tipos compuestos / row types / `hstore`.
- Find & replace masivo, bulk update.
- Edición optimista con propagación cross-tab (cambios en una pestaña no afectan otras pestañas que muestren la misma tabla — el usuario refresca manualmente si quiere).
- Soporte editable para tablas sin PK (solo INSERT habilitado en ese caso; UPDATE/DELETE deshabilitados con banner explicativo).
- Auto-commit, auto-save, drafts persistentes en disco.
- Conflict detection ("alguien más modificó esta fila desde que la cargaste"). Una limitación conocida; ver Risks.
- Edición de schema (ALTER TABLE, agregar columna, etc.) — eso es `edit-postgres-schema` futuro.

## Decisions

### 1. Buffer dirty paralelo, no mutación in-place del buffer de lectura

Cada pestaña mantiene un mapa `Map<RowKey, RowEdits>` con los edits pendientes. `RowKey` es la PK serializada (o un id sintético `tmp:<uuid>` para inserts). `RowEdits` es `{ kind: "update" | "insert" | "delete", changes: Map<columnName, newValue>, originalRowSnapshot? }`.

**Por qué**: separa "estado del servidor" de "intención del usuario". Permite cancelar edits, hacer undo granular, mostrar un diff real (`old → new`), y reconciliar tras commit (las filas que cambiaron en BD se pueden re-fetch puntualmente).

**Alternativa descartada**: mutar el buffer de filas y marcar cada celda con un flag `dirty`. Más simple en código pero pierde el "valor original" — sin él el diff preview no puede mostrar `old → new`, y un undo se vuelve un re-fetch.

**Trade-off**: dos representaciones que mantener sincronizadas en UI. Lo absorbemos con un selector único `getDisplayValue(row, column)` que consulta primero el buffer y cae al row real.

### 2. PK lookup explícito, comando aparte

Antes de habilitar edición, el frontend llama `postgres_table_primary_key(connectionId, schema, relation)` y recibe `{ columns: string[] | null }`. Si `null`, la tabla no tiene PK; UI marca update/delete deshabilitados.

**Por qué**: la PK no cambia con paginación o filtros, así que separarla del query de datos evita re-fetcharla en cada página. Además, vistas y vistas materializadas no tienen PK por defecto — eso significa "no editable" automáticamente, sin lógica especial en el viewer.

**Alternativa descartada**: extender `postgres_query_table` para devolver la PK en cada respuesta. Bloat innecesario.

**Implementación backend**: lee `pg_index` con `indisprimary = true` + join a `pg_attribute` para sacar los nombres de columnas. Una sola query.

### 3. SQL builder para edits, NUNCA SQL libre

El backend recibe `edits: Vec<EditOp>` donde `EditOp` es:

```rust
enum EditOp {
    Update { pk: HashMap<String, JsonValue>, changes: HashMap<String, JsonValue> },
    Insert { values: HashMap<String, JsonValue> },
    Delete { pk: HashMap<String, JsonValue> },
}
```

El builder genera `UPDATE "schema"."relation" SET "col" = $1 WHERE "pk1" = $2 AND ...`, `INSERT INTO ... ($cols) VALUES ($vals) RETURNING *`, `DELETE FROM ... WHERE "pk1" = $1 AND ...`. Identificadores **siempre** quoteados con `quote_ident` (ya existe del change anterior). Valores **siempre** bound como params.

**Por qué**: misma razón que el viewer read-only: SQL injection no es opción aceptable; los usuarios pueden tipear cualquier cosa en una celda y eso debe ir a Postgres como bind param. El builder maneja también casting implícito mínimo (string → text/uuid/numeric/json) — Postgres se encarga del resto.

### 4. Una transacción por commit, ROLLBACK total en error

`postgres_apply_table_edits` toma una conexión del pool, ejecuta `BEGIN`, itera el `Vec<EditOp>` aplicando cada uno con `executeMutation`, y al final hace `COMMIT`. Cualquier error en el medio dispara `ROLLBACK` y devuelve `AppError::Postgres { code, message, failed_op_index }`.

**Por qué**: TablePlus-like atomicidad. Si una de 50 operaciones falla, no queremos quedar a medias.

**Implementación**: la transacción se mantiene durante todo el comando. Lock ligero — el comando NO es para "stage cambios", es para "stage durante segundos y commit". El usuario puede pasar minutos editando antes del `⌘S` (sin transacción), pero el commit en sí es rápido.

**Trade-off**: si la transacción es enorme (1000 edits), puede tardar y mantener un lock. Aceptable: nadie edita 1000 filas a mano. Si llegara el caso, partirlo es una decisión del usuario, no del cliente.

### 5. Diff preview muestra SQL real

El backend expone `postgres_preview_table_edits(connectionId, schema, relation, edits)` que NO ejecuta nada — solo construye el SQL+params usando el mismo builder y los devuelve. La UI los renderiza.

**Por qué**: el usuario ve exactamente qué se va a ejecutar. Da confianza, ayuda a detectar bugs ("mi edit cambió la columna equivocada"), y reusa el builder en lugar de duplicarlo en TS. Mismo principio que `EXPLAIN` antes de un query pesado.

**Alternativa descartada**: construir el diff en TS y mostrar un pseudo-SQL ("UPDATE users SET name = 'foo' WHERE id = 1"). Riesgo de divergencia: el TS muestra una cosa, el backend ejecuta otra. Inaceptable cuando el usuario está confiando en lo que ve.

**Implementación**: el comando devuelve `Vec<{ kind: "update"|"insert"|"delete", sql: string, params: Vec<DebugString>, target: { schema, relation, pk_summary?: string } }>`. El builder lo expone como una función pura `build_edit_sql(op)`; ambos comandos (preview y apply) lo usan.

### 6. `executeMutation` real, con SET TRANSACTION READ WRITE explícito si la conexión NO es read-only

Hoy el spec describe `executeMutation`; lo implementamos. El helper:

1. Acquires connection from pool.
2. Si `read_only`: devuelve `AppError::Validation "connection is read-only"` ANTES de tocar el wire.
3. Si no read-only: ejecuta la query con bind params; respeta el timeout estándar (15s, mismo patrón que el resto).

**Por qué este shape**: una sola función, predecible, parametrizable. La transacción wrap (`BEGIN; ...; COMMIT`) NO vive en `executeMutation` — vive en `postgres_apply_table_edits` que controla la lifetime de la transacción explícitamente y maneja el rollback. `executeMutation` es para statements sueltas; el commit usa el client crudo dentro de un scope transaccional.

**Implementación**: en `postgres_apply_table_edits`, sacamos un `client` del pool, hacemos `client.batch_execute("BEGIN")`, iteramos llamando a `client.execute(sql, params)` para cada op (no `executeMutation` — para no abrir N conexiones). Validamos read-only una vez al inicio chequeando el flag de la pool. Esto evita el overhead de re-validar por op y mantiene la transacción atómica.

### 7. Refresh quirúrgico tras commit

El backend devuelve `{ committed: number, refreshed_rows: Vec<{ pk, row }> }`. `refreshed_rows` contiene:

- Para cada `update`: la fila completa post-commit (refrescada del propio `RETURNING *` del UPDATE).
- Para cada `insert`: la fila completa con la PK asignada (también `RETURNING *`).
- Para cada `delete`: nada en `refreshed_rows` — la PK ya no existe.

El frontend reemplaza/inserta/elimina solo esas filas en el buffer de `useTableData`, sin recargar páginas.

**Por qué**: recargar 200 filas tras un edit de 1 celda es un waste. Además, si el usuario está mirando una página profunda, recargar la primera lo descontextualiza. Refresh quirúrgico mantiene la posición de scroll y solo "parpadea" las filas tocadas.

**Trade-off**: si los edits afectan filas más allá de las visibles vía triggers (un UPDATE en `users` que toca `audit_log` por trigger), eso no se refleja. No nos importa para V1; el usuario siempre puede refresh manual.

### 8. Tipos de input en celda por `data_type` Postgres

Mapping inicial:

- `text`, `varchar`, `bpchar`, `name`, `uuid`, `cidr`, `inet`, `macaddr` → `<input type="text">` con monoespaciado.
- `text` cuyo valor en buffer pasa de 100 chars, o `_text` (array), o `jsonb`/`json` → `<textarea>` mono.
- `int2`, `int4`, `int8`, `numeric`, `float4`, `float8` → `<input type="text" inputmode="decimal">` con validación cliente "es número".
- `bool` → `<select>` con `true / false / NULL` (si nullable).
- `date`, `timestamp`, `timestamptz` → `<input type="text">` con placeholder ISO 8601 (no datetime native, para mantener control sobre timezone display).
- Tipos enum (`pg_type.typcategory = 'E'`) → `<select>` con valores válidos. La UI los descubre vía `pg_enum` lookup; backend lo expone en `postgres_table_primary_key`'s response como info adicional, o como `postgres_column_enum_values` separado — TBD (ver Open Questions).
- `bytea` → no editable en V1 (banner "binary, not editable inline").
- Cualquier otro tipo → fallback `<input type="text">` con monoespaciado y validación al commit (Postgres rejects → error en UI).

**Por qué**: cubre el 90% de casos sin invertir en pickers fancy. La validación dura recae en Postgres al `COMMIT` — el usuario aprende rápido qué formato espera.

**Trade-off**: una fecha mal escrita falla en commit, no en edit-time. Aceptable; no queremos reimplementar el parser de timestamps de Postgres en TS.

### 9. Atajos: `⌘S` save, `⌫` delete, `⌘Z` undo, `Escape` cancel edit

- `⌘S` (cuando la pestaña tiene foco y hay buffer dirty) → abre diff preview modal.
- `⌫` (cuando hay filas seleccionadas y NO hay celda en edit) → marca para delete las filas seleccionadas; toggle si ya están marcadas.
- `⌘Z` (cuando hay edits en buffer) → deshace el último edit del buffer (LIFO sobre un stack de operations).
- `Escape` (durante edición de celda) → cancela el cambio de esa celda, no toca el resto del buffer.
- Doble click en celda → entra a modo edit; `Tab` y `Enter` salen del modo edit y commitean el cambio al buffer (no a BD).

**Por qué**: TablePlus-like, predecible. `⌘S` es universal. `⌘Z` LIFO sobre el stack de edits ahorra memoria comparado con un undo/redo full state.

**Implementación**: un reducer en el hook `useEditBuffer` con acciones `setCellEdit / markRowDelete / markRowUndelete / addInsertRow / undo / clear / commitSuccess`. El stack de undo es una `Vec<Action>` que se aplica en reversa.

### 10. Modal del diff preview, no panel inline

Es un modal ocupando ~80% de viewport, con scroll interno por lista de operations. Header muestra `N updates · M inserts · K deletes`. Footer con `Cancel` y `Confirm & Apply`.

**Por qué**: un modal frena al usuario y le obliga a leer. Un panel inline se mezcla con el resto de la UI y es más fácil de "saltarse". Para un commit destructivo, fricción intencional es buena.

**Trade-off**: un modal interrumpe el flow. Vale la pena para commits.

### 11. Conexiones read-only: doble enforcement (UI + backend)

UI:

- Doble click en celda no entra a edit (chequea `connection.params.read_only`).
- Botón "+" no se renderiza.
- `⌫` en filas seleccionadas no marca delete.
- Banner persistente en la barra inferior: "Read-only connection — edits disabled".

Backend:

- `postgres_apply_table_edits` chequea `read_only` antes de hacer nada y devuelve `AppError::Validation { message: "connection is read-only" }`.
- `postgres_preview_table_edits` también lo chequea (no hay razón de generar SQL para algo que no se puede ejecutar).

**Por qué doble**: defense in depth. Un bug en el frontend no debe lograr una mutación. El backend es la verdad.

### 12. Cierre de pestaña con buffer dirty

Cuando el usuario intenta cerrar la pestaña con cambios pendientes, modal de confirmación: "Discard N changes?" con `Cancel / Discard`. Si confirma, la pestaña se cierra y el buffer se pierde. NO persistimos drafts a disco en V1.

**Por qué**: simplicidad. Drafts persistentes son un rabbit hole (versionado, reconciliación tras schema change, etc.) sin demanda clara.

## Risks / Trade-offs

- **No hay conflict detection** → si dos personas editan la misma fila, el último commit gana. Mitigación: en V1 la edición es typically single-user (Argus es desktop), y Postgres ya garantiza atomicidad por fila. Si llega demanda real, podemos añadir un `WHERE col = $oldValue AND pk = $pkValue` opcional ("optimistic lock") — pero abre una caja de Pandora con tipos no-igualables (jsonb, array). Lo dejamos out.
- **`bytea` y tipos exóticos no editables** → mitigación: banner claro en la celda; el usuario sabe que tiene que ir a `psql` o `run-sql` (#6) para esos casos.
- **Validación de tipos en cliente es laxa** → mitigación: errors de Postgres en commit son claros (ej. `invalid input syntax for type integer: "abc"`). El UI los muestra inline y resalta la op fallida.
- **`⌘Z` no es redo** → mitigación: por ahora es solo undo LIFO. Si hace falta redo (probablemente no en V1), es un stack más.
- **Tablas con PK compuesta** → el builder soporta PKs multi-columna nativamente. UI muestra todas las columnas PK como read-only (no editables vía la grid; cambiar una PK requiere DELETE + INSERT y eso ya es achievable en el flujo).
- **Tablas sin PK** → solo INSERT habilitado. UPDATE/DELETE bloqueados con banner. Riesgo: el usuario abre una tabla sin PK y se confunde por qué no puede editar. Mitigación: banner explícito + tooltip en cada celda.
- **Triggers que mutan otras tablas** → no se reflejan en la UI tras commit. Mitigación: documentado; refresh manual.
- **Transacción de muchas ops puede tardar y mantener locks** → mitigación: confiamos en el buen criterio del usuario (no editar 5000 filas a mano); si llega el caso, partir manualmente.
- **Render de inputs en celda + virtualizer** → cuando una celda entra en edit, el virtualizer puede reciclar el row si el usuario hace scroll lejos. Mitigación: detectamos el scroll-out y commiteamos el cambio al buffer antes de que el DOM node sea reciclado. Si el usuario quiere "cancelar" lo edita explícitamente con Escape antes de mover.
- **`refreshed_rows` puede no contener las nuevas filas si la PK la generó un trigger no `SERIAL`** → el `RETURNING *` de Postgres lo devuelve igual, así que esto no es problema en la práctica. Solo casos extremos (sin PK, sin RETURNING capability) caen al fallback "refresh manual".

## Migration Plan

No hay migración: change aditivo. Pasos de despliegue dentro de la sesión:

1. Implementar `executeMutation` real en `src-tauri/src/modules/postgres/pool.rs` (si no estaba implementado todavía); test unitario para el branch read-only.
2. Crear `src-tauri/src/modules/postgres/edit.rs` con el builder de SQL para `EditOp`, los comandos `postgres_table_primary_key`, `postgres_preview_table_edits`, `postgres_apply_table_edits`. Tests unitarios del builder (update / insert / delete; PK simple y compuesta; identificadores patológicos; rejection de read-only).
3. Registrar los tres comandos en `commands.rs` y en el `invoke_handler` del módulo Postgres.
4. Frontend: añadir `useEditBuffer.ts`, `EditableCell.tsx`, `DiffPreviewDialog.tsx`, `useTablePrimaryKey.ts`. Modificar `DataGrid.tsx`, `BottomBar.tsx`, `Inspector.tsx`, `TableViewerTab.tsx`.
5. Hook de cierre de pestaña con confirm modal cuando hay dirty buffer (extender `TabsContext` si hace falta — debería ser un hook genérico `useCloseConfirm(canClose: () => boolean)`).
6. Actualizar `activity-log` spec/types para incluir `apply_edits` en el set de kinds y el mapping de metric.
7. Probar manualmente contra una BD local (tabla con PK simple, PK compuesta, sin PK; tipos comunes; bytea; jsonb; vista (no editable); read-only connection).
8. Actualizar `openspec/ROADMAP.md` marcando #5 como en progreso/archivado tras merge.

**Rollback**: revertir el commit. La edición es feature-add; no hay datos persistidos en disco específicos al feature (el buffer es en-memoria por pestaña). Las tablas modificadas vía Argus quedan modificadas (es la naturaleza de un feature de edición), pero rollback de la app no las desmodifica — eso requeriría que el usuario revierta a mano vía SQL, que es lo correcto.

## Open Questions

- **Enums**: ¿exponemos `postgres_column_enum_values(connectionId, schema, relation, column)` separado, o pre-cargamos todos los enums de la tabla en `postgres_table_primary_key` (renombrándolo a `postgres_table_edit_metadata`)? Probablemente lo segundo: una llamada al abrir la pestaña, lista todo lo que necesito para editar. Pero queda como decisión a aterrizar en implementación si el lookup de enums es caro.
- **`--warning` token o `--accent-soft` para celdas dirty?** Dependiente de DESIGN.md. Si no existe `--warning`, lo introducimos junto con este change. Si existe, lo usamos. Ver con DESIGN.md durante implementación.
- **Stack de undo: ¿solo LIFO o un undo/redo completo?** V1 = solo LIFO. Si pruebas reales muestran que el usuario necesita redo, lo añadimos como follow-up trivial.
- **Inserción multi-fila de un pegado (Excel-style)**: el botón "+" inserta una fila. ¿Pegar 50 filas desde clipboard debería funcionar? Probablemente sí en el long-term, pero out of scope para V1 (requiere parser de TSV/CSV en cliente). Queda como `paste-rows` follow-up.
- **Confirmación de delete por separado**: hoy el flujo es marcar para delete + diff preview + confirm. ¿Hace falta un confirm extra para delete (estilo "are you sure" doble)? Probablemente no — el diff preview ya es la confirmación. Si pruebas reales muestran deletes accidentales, agregamos un toggle "Confirm deletes individually" en settings.
