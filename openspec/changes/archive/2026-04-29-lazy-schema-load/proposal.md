## Why

Hoy el schema browser carga **todo** el contenido de un schema (tablas, vistas, mat-views, funciones, tipos, extensiones, índices, triggers) en una sola IPC con `tokio::try_join!` de 6 queries. La semántica all-or-nothing tiene dos consecuencias visibles para el usuario: (1) si **una** sola query supera 15s — típicamente `pg_proc` con `pg_get_function_arguments` por OID en schemas con cientos de funciones overloaded, o `pg_index` en schemas con tablas particionadas — las **otras 5** queries son canceladas y todo se reintenta; tras un retry, la fila del schema termina en `error` aunque los relations cargarían rápido por sí solos. (2) La carga inicial paga el costo de queries que el usuario aún no necesita ver (índices/triggers de cada tabla, firmas de funciones que nadie ha clickeado todavía).

El usuario reporta el síntoma directamente: "11 schemas visibles, 4 nunca terminan de cargar — siempre los mismos". El patrón determinista descarta pool starvation y confirma que esos 4 schemas tienen contenido pesado en alguna de las queries-veneno.

## What Changes

- **BREAKING** Eliminar `postgres_list_objects(id, schema)`. Reemplazarlo por tres comandos especializados:
  - `postgres_list_relations(id, schema)` — solo `pg_class` (tablas, vistas, mat-views). Es la query barata. Carga eager al expandir el schema.
  - `postgres_list_structure(id, schema)` — funciones (sin firma), tipos, extensiones. Carga lazy al expandir el grupo `Structure`.
  - `postgres_list_table_extras(id, schema, relation)` — índices y triggers de **una** tabla. Carga lazy al expandir la tabla.
- Nuevo comando `postgres_get_function_signature(id, schema, function_name, oid)` que resuelve `pg_get_function_arguments` + `pg_get_function_result` para una sola función. Se invoca lazy desde la pestaña/tooltip de la función — la lista del árbol muestra solo el `name`.
- Cada comando aplica `tokio::join!` (no `try_join!`) con timeout **individual** de 8s por query interna y timeout total de 10s. Los resultados retornan un envelope `{ loaded: {...}, failed: [{ kind, error }] }` para que la UI muestre lo que sí cargó y un mensaje por-grupo para lo que falló.
- Frontend: el cache pasa de "estado por schema" a "estado por (schema, group)". El árbol renderiza grupos individualmente con su propio loading/error/retry. Un schema con `Structure` fallido sigue mostrando sus tablas.
- Auto-retry SQLSTATE 57014 sobrevive solo en el path eager (`relations`). En los lazy fetches, el usuario tiene control explícito vía botón "Retry" — no hay auto-retry, no hay sorpresas de espera larga.
- Invalidación: el `Schema: Refresh` de la palette y la invalidación por `postgres:active-changed` siguen funcionando (vacían el cache completo del connection). Cada grupo además gana su propio botón refresh.

## Capabilities

### New Capabilities

- *(none)*

### Modified Capabilities

- `postgres-schema-browser`: el comando `postgres_list_objects` se reemplaza por tres comandos por-grupo + un getter de firma; el cache frontend cambia a granularidad por-grupo; los índices y triggers dejan de cargarse por-schema y pasan a per-table on-expand; auto-retry queda solo para el fetch eager de relations; los grupos lazy obtienen UI de partial degradation con retry por-grupo.

## Impact

- **Backend** (`src-tauri/src/modules/postgres/`):
  - `schema.rs` se divide en helpers separados por kind con timeout individual; queries `SQL_LIST_FUNCTIONS` deja de incluir `pg_get_function_arguments`/`pg_get_function_result`; `SQL_LIST_INDEXES` y `SQL_LIST_TRIGGERS` ganan filtro por `relname`.
  - `schema_commands.rs` reemplaza `postgres_list_objects` por los 3 comandos nuevos + el getter de firma. Comparten `fire_cancel` y la lógica de timeout.
  - `schema_types.rs` agrega tipos para los envelopes parciales (`PartialResult<T>`, `KindFailure`).
  - `lib.rs` actualiza el `tauri::generate_handler!` macro: agrega los 4 nuevos, quita el viejo.
- **Frontend** (`src/modules/postgres/schema/`):
  - `useSchemaTree.ts` reescribe el reducer: `Map<string, ObjectState>` se transforma en `Map<string, { relations, structure, tableExtras: Map<table, ExtraState> }>`. El effect eager solo dispara `relations` para los visibles; los demás se disparan en `onExpand` callbacks pasados al `SidebarTree`.
  - `SchemaTree.tsx` y `objectIcons.tsx` se ajustan para renderizar el partial-state por grupo (placeholder + "Retry" inline en el grupo, no en el schema entero).
  - `api.ts` y `types.ts` se actualizan a los 4 comandos nuevos.
  - `events.ts` agrega un evento `invalidate-group` para el botón refresh por-grupo.
- **Out of scope**:
  - Cambios al `POOL_MAX_SIZE` o al `RecyclingMethod` de deadpool — con el rediseño la presión se evapora; si reaparece, lo abordamos por separado.
  - Timeout en `pools.acquire()` — misma lógica.
  - El otro problema reportado (carga lenta de datos en tablas — `row_to_json`, OFFSET deep) — es cambio aparte, ortogonal a este.
  - Persistencia del cache cross-session — sigue siendo en memoria.
- **Migration**: ningún consumer externo usa `postgres_list_objects`. El cambio es interno al módulo Postgres + sidebar. Tests existentes de `schema.rs` (3 unit tests) se reescriben contra los helpers nuevos; el live-test (gated detrás de `live-pg-tests`) se replica para cada comando.
