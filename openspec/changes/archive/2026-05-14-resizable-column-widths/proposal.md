## Why

Hoy todas las grillas de Argus (Postgres editable, Postgres ad-hoc, DynamoDB) usan un `COLUMN_WIDTH` fijo de 180px. Eso obliga a hacer scroll horizontal innecesario en columnas estrechas (booleans, ids numéricos, fechas) y trunca contenido en columnas anchas (texto largo, JSON). El usuario necesita poder ajustar el ancho y, además, que el ancho inicial sea razonable según el tipo del valor para que la primera lectura ya sea útil.

## What Changes

- Reemplazar el `COLUMN_WIDTH` fijo en las tres grillas (`postgres/data/DataGrid.tsx`, `postgres/data/AdhocResultGrid.tsx`, `dynamo/data-view/TabView.tsx`) por un ancho calculado por columna.
- Introducir una tabla de **anchos base por tipo de dato** (numeric, boolean, date/timestamp, uuid, text, json, binary, other) que se usa cuando el usuario no ha personalizado todavía.
- Permitir **arrastrar el borde derecho del header** de cualquier columna para redimensionarla (con un handle visible al hover, 80ms — `--duration-instant`).
- Permitir **doble click en el handle** para volver al ancho base por tipo.
- **Persistir** los anchos personalizados por tabla, vía `useSetting()`, bajo claves tipo `table-widths:postgres:<connectionId>:<schema>.<table>` y `table-widths:dynamo:<connectionId>:<tableName>`. Las query ad-hoc usan persistencia in-memory (no se guarda en disco porque la forma del resultado cambia).
- El cálculo de ancho total del header sticky pasa de `columns.length * COLUMN_WIDTH` a una suma de los anchos efectivos.
- No hay cambios visuales para usuarios que no toquen los handles más allá de los nuevos anchos por tipo.

## Capabilities

### New Capabilities
- `column-width-preferences`: Define el modelo de anchos base por tipo, el contrato de persistencia por tabla, y el comportamiento del handle de resize (rango min/max, reset, hover, drag). Es transversal a Postgres y DynamoDB.

### Modified Capabilities
- `postgres-data-grid`: la grilla editable de Postgres adopta anchos por columna y handle de resize, reemplazando `COLUMN_WIDTH` fijo.
- `postgres-sql-editor`: la grilla de resultados ad-hoc adopta anchos por columna (in-memory por query, sin persistir).
- `dynamo-data-view`: el visor de items DynamoDB adopta anchos por columna persistidos.

## Impact

- **Código**: `src/modules/postgres/data/DataGrid.tsx`, `src/modules/postgres/data/AdhocResultGrid.tsx`, `src/modules/postgres/data/typeHelpers.ts`, `src/modules/dynamo/data-view/TabView.tsx`, sus `*.module.css`, y un nuevo módulo compartido (p.ej. `src/platform/table/columnWidths.ts`) con el mapa de defaults y el hook de persistencia.
- **Persistencia**: nuevas claves en el store de `useSetting()` (`table-widths:*`). Schema simple: `Record<columnName, number>`. Migración no necesaria — ausencia de la clave = usar defaults por tipo.
- **APIs/Tauri**: ninguna nueva.
- **Diseño**: handle hairline 1px visible en hover sobre el borde derecho del header; cursor `col-resize`; respeta tokens existentes (`--hairline`, `--duration-instant`). Sin cambios al header en estado idle.
- **Dependencias**: ninguna nueva. Resize manual con `pointerdown/move/up` (evitar libs externas dado el tamaño del scope).
- **Tests**: cubrir el cálculo de ancho por tipo, persistencia, y reset.
