## Why

Hoy un click en una tabla del schema browser abre una pestaña placeholder con el mensaje "Viewer not implemented yet". Sin un viewer real, Argus no reemplaza TablePlus para inspección diaria, que es el caso de uso principal de V1. Este change entrega la primera rebanada utilizable: ver los datos de una tabla con paginación, ordenamiento, filtros simples e inspector — todo read-only. La edición (`edit-table-data`) queda para el siguiente change para mantener la rebanada manejable.

## What Changes

- Nueva pestaña `postgres-table-data` que reemplaza el placeholder cuando se hace click en una tabla, vista o vista materializada.
- Comando IPC `postgres_query_table(connection_id, schema, table, options)` que ejecuta un `SELECT` paginado con sort y filtros aplicados server-side.
- Grid virtualizado (TanStack Table + el `@tanstack/react-virtual` ya instalado) con scroll-to-load por LIMIT/OFFSET.
- Page size configurable por tabla, default 200 filas. Persistido en `settings` con key `pgTableLimit:<connectionId>:<schema>:<table>`.
- Filtros por columna desde el header con operadores `=`, `!=`, `LIKE`, `IS NULL`, `IS NOT NULL`, `>`, `<`, `>=`, `<=`, `BETWEEN` (numérico/fecha).
- Sort por columna: click en header cicla `asc → desc → none`; shift-click agrega columnas al sort multi-columna.
- Panel inspector a la derecha: form read-only de la fila seleccionada, con todos los campos (incluidos los que no caben en la grid).
- Barra inferior con indicador `Showing X rows · Page Y` y botón "Count rows" que ejecuta `SELECT COUNT(*)` perezoso.
- El comando `postgres_query_table` respeta el flag `read_only` (es solo lectura, así que no necesita gating, pero usa `executeQuery`).
- Soporte para vistas y vistas materializadas además de tablas — el viewer es agnóstico al tipo de relation.

## Capabilities

### New Capabilities

- `postgres-data-grid`: comando IPC para query paginada de tablas/vistas, modelo de filtros y sort, pestaña con grid virtualizado e inspector, persistencia de page size por tabla.

### Modified Capabilities

- `postgres-schema-browser`: el click en tabla/vista/mat-view ahora abre la pestaña `postgres-table-data` en lugar del placeholder. Funciones, tipos, extensiones, triggers e índices siguen abriendo placeholder hasta los changes posteriores (#8 `table-structure-tab` y similares).

## Impact

- **Backend**: nuevo módulo `src-tauri/src/modules/postgres/data.rs` con `postgres_query_table` y `postgres_count_table`. Reusa `PgPoolRegistry::executeQuery` y el patrón de timeout/cancel-token de `postgres_list_objects`.
- **Frontend**: nuevo módulo `src/modules/postgres/data/` (hook + componentes); registro de tab kind `postgres-table-data` en `src/platform/shell/tabs/`; cambio en `src/modules/postgres/schema/openObjectTab.ts` para enrutar tablas/vistas a la nueva pestaña.
- **Dependencias nuevas**: `@tanstack/react-table` (`@tanstack/react-virtual` ya está instalado).
- **Settings**: nuevas keys `pgTableLimit:<connectionId>:<schema>:<table>` (number, default 200).
- **Out of scope**: edición de celdas (#5), export CSV/JSON, group-by, joins ad-hoc, editor de jsonb/array, paginación cursor-based (LIMIT/OFFSET es suficiente para V1).
- **Out of scope para esta rebanada**: las funciones, tipos, etc. siguen mostrando el placeholder — los abordan changes posteriores del roadmap.
