## Why

Hoy cada query se ejecuta y desaparece — el SQL editor (`postgres-sql-editor`) emite eventos al `activity-log` en memoria, pero esos eventos se pierden al reiniciar la app. El usuario no puede revisar qué corrió ayer, recuperar una query que ya descartó, ni medir cuánto tarda la misma sentencia en distintos entornos. Esta es una funcionalidad de mesa básica para reemplazar TablePlus en el flujo diario y aterriza el punto 7 del roadmap.

## What Changes

- Nueva tabla SQLite `query_history` con `(id, connection_id, sql, started_at, duration_ms, row_count, error_code?, error_message?, status, origin)` poblada por cada `postgres_run_sql` y cada paso de `postgres_run_sql_many` que efectivamente se ejecute (incluyendo errores; saltos `skipped` no se persisten).
- Comandos Tauri `query_history_list(filter, page)` y `query_history_delete(id)` para leer y borrar entradas.
- Nuevo tab kind `query-history` con lista virtualizada, filtros (por conexión, rango de fechas, búsqueda full-text LIKE sobre el SQL) y acción "open in editor" que abre un nuevo `postgres-query` con el SQL pre-cargado contra la conexión original.
- Sección "Plataforma" en el sidebar (debajo de "Connections") con una entrada `History` que abre el tab — single-instance: si ya está abierto, lo enfoca.
- Comando de paleta `History: Open` con la misma semántica.
- Retención configurable vía `settings`: por defecto **30 días o 10 000 entradas** (lo que llegue primero). Limpieza ejecutada al arrancar la app y opcionalmente vía botón "Clear history" en el tab.
- El SQL editor registra en history cada ejecución que llegue al pool — en el mismo punto donde hoy emite `argus:activity-log` para `kind: "run_sql"`.

## Capabilities

### New Capabilities

- `query-history`: tabla SQLite, comandos Tauri de lectura/borrado, retención, tab kind `query-history` con UI de lista + filtros + acción "open in editor".

### Modified Capabilities

- `postgres-sql-editor`: cada invocación a `postgres_run_sql` y cada paso ejecutado de `postgres_run_sql_many` debe persistir una entrada en `query_history` además de emitir el evento de activity-log. La política de "qué se persiste" (incluye errores, excluye `skipped`) queda fijada como requirement aquí.

> Nota: la sección "Plataforma" del sidebar y el comando de paleta `History: Open` se describen como requirements de `query-history`, no como modificaciones a `app-shell` / `command-palette` — siguiendo el patrón existente donde cada capability registra sus propios slots y comandos sobre las primitivas compartidas.

## Impact

- **Backend**: nueva migración `0002_query_history.sql`; nuevo módulo `src-tauri/src/modules/query_history/` (data access + comandos Tauri); hook en `src-tauri/src/modules/postgres/sql.rs` (después del `emit_activity` actual) para insertar en la nueva tabla.
- **Frontend**: nuevo módulo `src/modules/query-history/` (api, tab, panel de filtros, lista virtualizada con `@tanstack/react-virtual` ya disponible); registro del tab kind en `src/platform/shell/tabs/`; nueva sección en `src/platform/shell/Sidebar.tsx`.
- **Settings**: nuevas claves `queryHistory.retentionDays` (default `30`) y `queryHistory.retentionMaxRows` (default `10000`).
- **Sin nuevas dependencias externas**: rusqlite, tanstack/react-virtual y CodeMirror ya están en el proyecto.
- **Sin breaking changes**: capacidades existentes ganan requirements aditivos.
