## Why

Los usuarios ejecutan repetidamente las mismas queries SQL contra distintas conexiones (mismo schema en prod/staging/local, queries de diagnóstico que se reutilizan). Hoy la única forma de "recuperar" una query es buscarla en el histórico, que está atado a una conexión y mezclado con ejecuciones desechables. Hace falta una biblioteca personal de queries con nombre, organizable en carpetas, y desacoplada de la conexión de origen — la misma query "Revenue by month" debe poder ejecutarse en cualquier conexión disponible sin reabrirla.

## What Changes

- Nuevo panel **Saved Queries** en el sidebar (entre Connections y Plataforma) que renderiza un árbol jerárquico de carpetas y queries con búsqueda, drag-and-drop, rename inline y menú contextual.
- Persistencia local en SQLite con dos tablas (`saved_query_folders` y `saved_queries`) modelando carpetas como entidad real (parent_id), con cascade delete.
- Nuevos comandos Tauri para CRUD de carpetas y queries, mover entre carpetas, reordenar (`sort_order`).
- **BREAKING**: El `connectionId` deja de estar fijado en el id del tab `postgres-query`. Ahora el id se genera independientemente y la conexión es **mutable** en runtime vía un selector dentro del editor SQL.
- Selector de conexión en la toolbar del editor SQL: aplica a **todas** las tabs SQL (saved, ad-hoc, history-spawned) para mantener consistencia.
- Botón `Save` en la toolbar del editor + atajo `Cmd+S`. Modal con nombre y folder picker solo la primera vez (query nueva). Después, overwrite directo del registro asociado al tab.
- Estado **dirty** del tab (indicador visual) cuando el SQL o el nombre divergen del registro guardado. Cambiar la conexión NO marca dirty.
- Reuso de tab: abrir una saved query ya abierta enfoca la tab existente en lugar de crear una nueva.
- Última conexión usada por saved query persistida (`last_connection_id`) para precargar el selector al reabrir.
- Reuso del `<ResultPanel />` existente — el panel de export (CSV / XLSX / JSONL) sale gratis.

## Capabilities

### New Capabilities
- `saved-queries`: almacenamiento, listado y manipulación de queries guardadas y de su organización jerárquica en carpetas. Cubre el modelo de datos, comandos Tauri de CRUD, y el panel sidebar con árbol, búsqueda, drag-drop y menú contextual.

### Modified Capabilities
- `postgres-sql-editor`: cambia el id del tab (deja de contener `connectionId`), agrega selector de conexión inline mutable, agrega toolbar action `Save` + atajo `Cmd+S`, agrega dirty state, agrega reuso de tab por `savedQueryId`. El autocomplete schema-aware debe re-bindear cuando cambia la conexión.

## Impact

**Backend (Rust)**
- Nueva migración SQLite `0003_saved_queries.sql` con dos tablas, índices y foreign keys.
- Nuevo módulo `src-tauri/src/modules/saved_queries/` (mod.rs, commands.rs) con CRUD + move + reorder + duplicate.
- Registrar nuevos comandos en `src-tauri/src/lib.rs`.

**Frontend (TypeScript / React)**
- Nuevo módulo `src/modules/saved-queries/` con: store, API wrapper, panel sidebar (`SavedQueriesPanel.tsx`), modal de save, context menu, hooks de drag-and-drop.
- Modificar `src/platform/shell/Sidebar.tsx` para incluir el nuevo panel.
- Modificar `src/modules/postgres/sql/QueryTab.tsx` y `QueryEditor.tsx`: nuevo id de tab, selector de conexión inline, dirty state, integración con saved queries, atajo `Cmd+S` a `Prec.highest`.
- Modificar `openQueryTab` para aceptar `savedQueryId?` opcional y para reusar tab cuando exista.
- El schema cache observer debe re-bindear el namespace cuando cambia `connectionId` runtime.

**Sin impacto en**: `query-history` (sigue funcionando igual), Postgres run commands (`run_sql`, `run_sql_many`), data grid, structured editor.

**Riesgos**
- Cambiar el id del tab puede invalidar tabs en `pgQueryBuffer:<tabId>` settings de usuarios que tengan el app abierto en upgrade — aceptable (los buffers son in-session y se descartan al cerrar tab).
- El selector de conexión añade complejidad al `useQueryRun` hook (la conexión es state mutable, no prop fija).
