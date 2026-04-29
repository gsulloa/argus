## 1. Backend: bulk columns command

- [x] 1.1 Crear `src-tauri/src/modules/postgres/columns.rs` con tipos `BulkColumnInfo` (incluye `default_value: Option<String>` y `comment: Option<String>`) y `ColumnsBulkResult { schema, columns_by_relation: BTreeMap<String, Vec<BulkColumnInfo>> }`.
- [x] 1.2 Implementar `postgres_list_columns_bulk(connection_id, schema, origin?)`: una sola query SQL que joinea `pg_attribute`, `pg_class`, `pg_namespace`, `pg_attrdef`, `pg_description`, filtrando por `nspname = $1`, `relkind IN ('r','v','m','p','f')`, `attnum > 0`, `NOT attisdropped`. Group by `relname` en Rust preservando `attnum` order.
- [x] 1.3 Timeout 8s con cancel-on-timeout (mismo patrón que `list_structure`). Devuelve `AppError::Postgres { code: "57014", … }` en timeout.
- [x] 1.4 Registrar el módulo en `src-tauri/src/modules/postgres/mod.rs`, exportar el comando, y registrarlo en `src-tauri/src/lib.rs::invoke_handler`.
- [x] 1.5 Tests unitarios de la query builder (sin live DB): verificar que la SQL contiene los joins esperados, las cláusulas de filtro, y el `ORDER BY relname, attnum`. (3 tests añadidos, 100 pasan.)

## 2. Backend: activity-log

- [x] 2.1 Extender `ActivityKind` en `src-tauri/src/modules/activity_log/mod.rs` con `ListColumnsBulk` (snake_case → `"list_columns_bulk"`).
- [x] 2.2 Test de discriminantes incluyendo el nuevo variant.
- [x] 2.3 En `columns.rs`, emitir el `ActivityLogEntry` con `kind: ListColumnsBulk`, `origin` del argumento, `sql: null`, `params: null`, `metric: Items { value: <total cols> }` en éxito, error en fallo.

## 3. Frontend: cache extension

- [x] 3.1 En `src/modules/postgres/schema/globalSchemaCache.ts`, añadir `recordColumnsBulk(connectionId, schema, columnsByRelation: Map<string, BulkColumnInfo[]>)` que itera y popula `bulkColumnsByRelation.get(schema)` y notifica subscribers UNA vez al final.
- [x] 3.2 Añadir `getNamespace(connectionId): SQLNamespace` que itera el cache excluyendo schemas system y mapea cada (schema, relation) → `Completion[]` con `{ label, type: "property", detail: data_type, info: comment ?? undefined }`.
- [x] 3.3 Añadir helper `isSystemSchema(name: string): boolean` exportado desde el mismo módulo.
- [x] 3.4 Añadir un `Set<string>` de in-flight bulk fetches (key: `<connectionId>:<schema>`) con métodos `markBulkInflight`, `clearBulkInflight`, `isBulkInflight`, `hasBulkColumns`. La invalidación de connection limpia el prefijo correspondiente.
- [x] 3.5 Hash/equality helper `namespaceShapeKey(connectionId: string): string` que serializa keys top-level y per-schema relation names.

## 4. Frontend: schema browser trigger

- [x] 4.1 En `src/modules/postgres/schema/api.ts`, añadir wrapper `listColumnsBulk(connectionId, schema, origin?: "auto"|"user")` y tipo `ColumnsBulkResult`.
- [x] 4.2 En `src/modules/postgres/schema/useSchemaTree.ts`, después del `dispatch({ type: "relationsLoaded" })` exitoso, llamar a `triggerColumnsBulk(connectionId, schema)` (helper local fire-and-forget que cubre system-skip, idempotencia, in-flight tracking, error logging).
- [x] 4.3 La invalidación del cache en `globalSchemaCache.invalidate(connectionId)` limpia los flags de in-flight con prefix `<connectionId>:`.

## 5. Frontend: completion sources redesign

- [x] 5.1 Crear `src/modules/postgres/sql/completionSources.ts` con `keywordSource`, `buildSchemaSource(connectionId)`, `documentIdentifierSource` (AST walker via `syntaxTree` que detecta CTEs por proximity a keyword "with" y todos los `Identifier`/`QuotedIdentifier`), y `composeSources(connectionId)`.
- [x] 5.2 Eliminar `src/modules/postgres/sql/autocomplete.ts` y todas sus referencias.
- [x] 5.3 Eliminar `src/modules/postgres/sql/columnCache.ts` y las llamadas a `maybeRecordColumnsFromSelect` en `useQueryRun.ts`.
- [ ] 5.4 Tests del documentIdentifierSource walker — DEFERRED: el frontend no tiene runner de tests. Validación vía manual QA.

## 6. Frontend: editor compartments + reconfigure

- [x] 6.1 En `QueryEditor.tsx`, separar `langCompartment` (estático, `sql({ dialect: PostgreSQL })`) y `autocompleteCompartment` (dinámico, `autocompletion({ override: composeSources(connectionId) })`).
- [x] 6.2 `QueryEditor` ahora acepta `connectionId` (no `completionSource`) y construye las sources internamente. `QueryTab` actualizado en consecuencia.
- [x] 6.3 `QueryEditorHandle.reconfigureAutocomplete()` dispatcha `autocompleteCompartment.reconfigure(...)` con sources frescos.
- [x] 6.4 `QueryTab.tsx` subscribe a `globalSchemaCache`, calcula `namespaceShapeKey` en cada notify, debounce 100ms y dispatcha `editor.reconfigureAutocomplete()` solo si el shape cambió. Cleanup del timer al unmount.

## 7. Validación

- [x] 7.1 `cargo build` y `cargo test --lib` sin errores (100 tests pasan).
- [x] 7.2 `pnpm typecheck` y `pnpm build` sin errores.
- [ ] 7.3 Manual QA contra una BD local:
  - Conectar → expandir un schema en el sidebar → verificar en logs que se disparó `postgres_list_columns_bulk` y que el activity-log muestra `kind: "list_columns_bulk"` con count correcto.
  - En un query tab, tipear `SEL` → ver `SELECT` en el popup (keyword source).
  - `SELECT * FROM ` → ver schemas + tablas (schema source).
  - `SELECT * FROM public.us` → ver `users` (canonical qualified-name).
  - `SELECT u. FROM "public"."users" u` → cursor después de `u.` → ver columnas de users (alias-aware).
  - `WITH recent AS (SELECT 1) SELECT * FROM rec` → ver `recent` como CTE.
  - Identificadores con dígitos: si la BD tiene `users_2024`, tipear `users_20` debería completarlo.
  - Schema system: expandir `pg_catalog` no dispara bulk (ver activity-log).
  - Reconfigure dinámico: con un query tab abierto, expandir un nuevo schema en el sidebar → ~100ms después, en el query tab tipear `FROM <new_schema>.` → ver sus tablas.
- [ ] 7.4 Verificar que el syntax highlighting / undo / cursor del editor NO se reinician cuando ocurre un reconfigure (no flicker).
