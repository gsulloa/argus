## Why

Athena ya guarda queries reutilizables **en la propia cuenta** como NamedQueries (las crea quien sea desde la consola de AWS, IaC, o el SDK), y hoy Argus no las ve: el SchemaTree de Athena sólo muestra databases → tablas/views → columnas. Un usuario que ya tiene su biblioteca de queries tiene que ir a la consola de AWS a copiarlas. Esta rebanada las trae al sidebar: detecta las NamedQueries de la cuenta y permite abrirlas en un tab de Athena con un clic.

Las NamedQueries de AWS están **scoped por workgroup**, y el usuario las piensa a nivel cuenta ("tengo mis saved queries"), no por workgroup — además la conexión normalmente apunta a un solo workgroup (p. ej. `primary`) que puede no ser donde viven las queries. Por eso el listado enumera **todos los workgroups** de la cuenta y agrupa el resultado por workgroup en el árbol, en vez de limitarse al workgroup de la conexión.

De paso cierra un gap real: Athena hoy no abre **ninguna** query guardada en su propio tab (ni Saved Queries ni Context Queries están cableadas a Athena). El branch de NamedQueries es el primer flujo "query guardada → tab de Athena" y reusa el `openAthenaQueryTab` ya existente.

Esta versión es **solo lectura** (listar + abrir). Crear / editar / borrar NamedQueries en la cuenta (CRUD vía `CreateNamedQuery` / `UpdateNamedQuery` / `DeleteNamedQuery`) queda como fase 2, capturada en un issue de seguimiento.

## What Changes

- Nuevo comando IPC `athena_list_named_queries(connection_id)` que detecta las NamedQueries de **todos los workgroups de la cuenta** (no solo el de la conexión) vía el cliente Athena ya en el pool:
  - `ListWorkGroups` paginado → todos los workgroups de la cuenta.
  - Por cada workgroup, `ListNamedQueries(WorkGroup = <wg>)` paginado → IDs (acumulando los de todos los workgroups).
  - `BatchGetNamedQuery(ids)` en lotes de ≤ 50 sobre el conjunto agregado (este verbo es account-wide por IDs, no requiere repetir por workgroup) → objetos completos; cada `NamedQuery` ya trae su `work_group`.
  - Retorna `Array<{ named_query_id, name, description?, database, work_group }>` ordenado por `(work_group, name)` case-insensitive. **No** incluye el `query_string` en el listado (se trae bajo demanda al abrir — ver siguiente comando), para mantener el payload del árbol liviano.
- Nuevo comando IPC `athena_get_named_query(connection_id, named_query_id)` que retorna `{ named_query_id, name, description?, database, work_group, query_string }` vía `GetNamedQuery`. Es el que alimenta el clic → tab. (`GetNamedQuery`/`BatchGetNamedQuery` resuelven por ID sin importar el workgroup, así que sirven igual para cualquier workgroup.)
- Nuevo branch **"Named Queries"** en el `AthenaSchemaTree`, por encima de las databases, bajo la fila de la conexión Athena, **agrupado por workgroup**:
  - Lazy-load: se carga al expandir (igual que databases/tablas hoy), con su estado de loading.
  - Bajo el branch, un sub-nodo por cada workgroup que tenga ≥ 1 NamedQuery (los workgroups vacíos se omiten para no meter ruido). Cada workgroup muestra su nombre y un contador.
  - Dentro de cada workgroup, cada NamedQuery es un nodo hoja clickable que muestra su `name` (y `description` como hint/tooltip cuando existe).
  - Clic en un nodo → `athena_get_named_query` → `openAthenaQueryTab(tabs, { connectionId, connectionName, sql: query_string })`. El tab nuevo arranca con el `query_string` precargado en el editor.
  - Estado vacío (cuenta sin ninguna NamedQuery en ningún workgroup): "Sin named queries en la cuenta".
  - Estado de error **inline** en el branch (no toast, no romper el resto del árbol): p. ej. cuando faltan permisos `athena:ListWorkGroups` / `athena:ListNamedQueries`, muestra el mensaje del `AppError` bajo el branch.
  - Refresh manual: el branch participa del refresh del árbol como el resto (invalida su cache al refrescar la conexión).
- El listado se cachea en memoria por conexión (paralelo al `globalSchemaCache` existente) y se invalida en `athena:active-changed` al desconectar y en refresh manual.

## Capabilities

### New Capabilities

- `athena-named-queries`: detección de NamedQueries de **todos los workgroups de la cuenta**. Comandos `athena_list_named_queries` (ListWorkGroups → ListNamedQueries por workgroup → BatchGetNamedQuery agregado, orden por `(work_group, name)`, sin `query_string`) y `athena_get_named_query` (GetNamedQuery, incluye `query_string`). Branch "Named Queries" en el sidebar de la conexión Athena, **agrupado por workgroup** (un sub-nodo por workgroup con ≥ 1 query, contador, los vacíos se omiten): lazy-load, nodos clickables, clic → abre `query_string` en un tab de Athena vía `openAthenaQueryTab`, estado vacío, error inline, refresh. Cache en memoria por conexión. **Solo lectura** — sin Create/Update/Delete.

### Modified Capabilities

- `athena-schema-browser`: el árbol del sidebar de cada conexión Athena SHALL renderizar el branch "Named Queries" (definido por `athena-named-queries`) por encima de las databases. El comportamiento de databases → tablas → columnas no cambia. El refresh de la conexión SHALL invalidar también el cache de NamedQueries.

## Impact

- **Backend**: nuevo archivo `src-tauri/src/modules/athena/named_queries.rs` con `athena_list_named_queries` y `athena_get_named_query`. Reusa `AthenaClientRegistry::acquire` para tomar el cliente (el `workgroup` de la conexión ya **no** determina el scope — se enumeran todos vía `ListWorkGroups`). Reusa `sdk_err_to_app` / `maybe_sso_specialized` de `errors.rs` para el mapeo de errores (incl. permisos faltantes → `AppError::Aws("AccessDenied", …, false)`). Bounded timeout como el resto de comandos del módulo. Registrar ambos comandos en `mod.rs` y en el `invoke_handler` de `lib.rs`. Tests cubriendo batching de `BatchGetNamedQuery` (> 50 ids agregados de varios workgroups), orden por `(work_group, name)`, `unprocessed_named_query_ids`, y mapeo de error de permisos.
- **Frontend**: 
  - `src/modules/athena/types.ts`: tipos `AthenaNamedQuerySummary` (`{ named_query_id, name, description, database, work_group }`) y `AthenaNamedQueryDetail` (+ `query_string`).
  - `src/modules/athena/api.ts`: `listNamedQueries(connectionId)` y `getNamedQuery(connectionId, namedQueryId)`.
  - `src/modules/athena/schema/globalSchemaCache.ts`: extender para cachear el listado de NamedQueries por conexión, con `invalidate` en disconnect/refresh.
  - `src/modules/athena/schema/SchemaTree.tsx`: nuevo branch "Named Queries" por encima de databases, **con sub-nodos por workgroup**; lazy-load; nodos clickables; estados loading/empty/error inline; clic → `getNamedQuery` → `openAthenaQueryTab`.
- **IAM**: el feature requiere `athena:ListWorkGroups`, `athena:ListNamedQueries`, `athena:BatchGetNamedQuery` y `athena:GetNamedQuery`. Si faltan, el branch muestra error inline; el resto del árbol (databases) sigue funcionando.
- **Out of scope (fase 2 → issue de seguimiento)**: crear / editar / borrar NamedQueries (`CreateNamedQuery`, `UpdateNamedQuery`, `DeleteNamedQuery`), botón "Save as Named Query" en el toolbar del editor, gating por `read_only` para escritura, confirmación de delete, y el tab "recuerda su origen" para ofrecer Update vs Create. También fuera: NamedQueries de catálogos distintos a `AwsDataCatalog`.
- **Riesgos**: una cuenta con muchos workgroups genera `ListWorkGroups` + un `ListNamedQueries` (posiblemente multi-página) por workgroup; mitigación: paginar perezoso al expandir (no al conectar), enumerar workgroups una vez y cachear el resultado completo. Workgroups `DISABLED` se incluyen igual (pueden tener queries históricas) salvo que AWS rechace el `ListNamedQueries`, en cuyo caso ese workgroup se omite sin romper el resto. `BatchGetNamedQuery` puede devolver `unprocessed_named_query_ids` parciales; mitigación: incluir lo procesado y, si quedan sin procesar, reintentar ese sublote una vez antes de omitirlos.
