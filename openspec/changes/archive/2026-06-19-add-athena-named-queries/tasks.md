## 1. Backend: NamedQueries command surface

- [x] 1.1 Crear `src-tauri/src/modules/athena/named_queries.rs` con los tipos `NamedQuerySummary` (`{ named_query_id, name, description: Option<String>, database, work_group }`) y `NamedQueryDetail` (los mismos campos + `query_string`), con serialización snake_case.
- [x] 1.2 Implementar `athena_list_named_queries(connection_id)`: `acquire` el cliente del pool, derivar `workgroup` desde `ActiveAthenaClient` (no es argumento), paginar `list_named_queries(WorkGroup)` siguiendo `next_token`, resolver IDs vía `batch_get_named_query` en lotes de ≤ 50, mapear a `NamedQuerySummary` (sin `query_string`), ordenar por `name` case-insensitive. Bounded timeout.
- [x] 1.3 Manejo de `unprocessed_named_query_ids`: reintentar el sublote una vez; omitir los que sigan sin procesar (no fallar el listado completo).
- [x] 1.4 Implementar `athena_get_named_query(connection_id, named_query_id)`: `get_named_query` → `NamedQueryDetail` (incluye `query_string`). Bounded timeout.
- [x] 1.5 Mapeo de errores reusando `sdk_err_to_app` / `maybe_sso_specialized` de `errors.rs`; permisos faltantes (`athena:ListNamedQueries`) → `AppError::Aws("AccessDenied"/código real, mensaje, retryable: false)`.
- [x] 1.6 Registrar ambos comandos en `src-tauri/src/modules/athena/mod.rs` y en el `invoke_handler` de `lib.rs`.
- [x] 1.7 Tests unitarios: paginación de `ListNamedQueries`, batching > 50 ids, `unprocessed_named_query_ids` con reintento, orden por nombre case-insensitive, listado vacío → `[]`, mapeo de error de permisos, `get_named_query` devuelve `query_string`.

## 2. Frontend: tipos y API

- [x] 2.1 En `src/modules/athena/types.ts`: `AthenaNamedQuerySummary` (`{ named_query_id, name, description: string | null, database, work_group }`) y `AthenaNamedQueryDetail` (+ `query_string`).
- [x] 2.2 En `src/modules/athena/api.ts`: `listNamedQueries(connectionId): Promise<AthenaNamedQuerySummary[]>` y `getNamedQuery(connectionId, namedQueryId): Promise<AthenaNamedQueryDetail>`, usando el wrapper `call<T>` existente (toAppError).

## 3. Frontend: cache

- [x] 3.1 Extender `src/modules/athena/schema/globalSchemaCache.ts` para cachear el listado de NamedQueries por `connectionId` (`recordNamedQueries` / `getNamedQueries`), con `subscribe` consistente con el resto.
- [x] 3.2 Invalidar el cache de NamedQueries junto al schema en `invalidate(connectionId)` (refresh manual) y al recibir `athena:active-changed` cuando la conexión se desconecta.

## 4. Frontend: branch "Named Queries" en el SchemaTree

- [x] 4.1 En `src/modules/athena/schema/SchemaTree.tsx`: agregar el branch "Named Queries" como primer hijo de la fila de conexión, por encima de las databases.
- [x] 4.2 Lazy-load al expandir: llamar `athenaApi.listNamedQueries(connectionId)` (poblando el cache), con estado de loading visible. No cargar en connect.
- [x] 4.3 Render de nodos: cada NamedQuery como hoja clickable mostrando `name`; `description` como hint/tooltip cuando existe. Participa del search/filter existente del árbol.
- [x] 4.4 Clic en un nodo → `athenaApi.getNamedQuery(connectionId, namedQueryId)` → `openAthenaQueryTab(tabs, { connectionId, connectionName, sql: detail.query_string })`.
- [x] 4.5 Estado vacío: "Sin named queries en este workgroup".
- [x] 4.6 Estado de error **inline** bajo el branch (mensaje del `AppError`), sin romper la sección de databases ni emitir toast.
- [x] 4.7 Integrar con el refresh manual de la conexión (invalida + re-fetch al expandir de nuevo).

## 5. Expansión a todos los workgroups (amend de la decisión #3)

- [x] 5.1 Backend `athena_list_named_queries`: reemplazar `list_named_queries(work_group de la conexión)` por: `list_work_groups()` paginado → para cada workgroup `list_named_queries(work_group)` paginado, acumulando todos los IDs. Un workgroup cuyo `list_named_queries` falle se omite (continue) sin abortar el comando.
- [x] 5.2 Mantener el batching agregado: `chunk_ids(&all_ids, 50)` + `batch_get_named_query` con el retry de `unprocessed` ya existente (sin repetir por workgroup; `BatchGetNamedQuery` resuelve por ID account-wide).
- [x] 5.3 Cambiar el orden a `(work_group, name)` case-insensitive (reemplaza `sort_summaries_by_name`); actualizar el test unitario de orden y agregar uno que mezcle workgroups.
- [x] 5.4 Verificar el mapeo de error: falla de `list_work_groups` → `AppError::Aws` propagado; falla de `list_named_queries` de un workgroup puntual → omitido. `cargo check` + `cargo test` verdes.
- [x] 5.5 Frontend `SchemaTree.tsx`: cambiar el branch de lista plana a **agrupado por workgroup** — un sub-nodo group por cada `work_group` con ≥1 query (omitir vacíos), con contador, y las queries como hojas dentro. Reusar el patrón de nodo group del árbol (igual que databases). Search/filter debe seguir funcionando sobre las hojas.
- [x] 5.6 Estado vacío del branch → texto "Sin named queries en la cuenta" (reemplaza "...en este workgroup"). `pnpm typecheck` + `pnpm lint` verdes.

## 6. QA manual

- [x] 6.1 Cuenta con NamedQueries en un workgroup distinto al de la conexión (caso real: conexión en `primary`, queries en `argus-analytics`): expandir branch, ver el sub-nodo `argus-analytics` con las 2 queries, clic abre tab con el SQL precargado, ejecutable.
- [x] 6.2 Verificar que workgroups vacíos (p. ej. `primary`) NO aparecen como sub-nodos.
- [x] 6.3 Cuenta sin ninguna NamedQuery en ningún workgroup: ver estado vacío "Sin named queries en la cuenta".
- [x] 6.4 Credenciales sin `athena:ListWorkGroups`: ver error inline; confirmar que databases/tablas siguen funcionando.
- [x] 6.5 Desconectar/reconectar y refresh manual: confirmar invalidación y re-fetch.
- [x] 6.6 Revisar contra `DESIGN.md`: tipografía, íconos del branch y de los grupos workgroup, espaciados, estados de loading/empty/error consistentes con el resto del árbol.
