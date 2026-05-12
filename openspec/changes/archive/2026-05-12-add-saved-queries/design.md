## Context

Argus ya tiene un módulo de **query history** (`src-tauri/src/modules/query_history/` + `src/modules/query-history/`) que sirve como blueprint excelente: SQLite local, comandos Tauri CRUD, tab singleton, integración con el editor para "Open in editor". Adicionalmente, el sidebar tiene un componente genérico **`SidebarTree`** (`src/platform/shell/SidebarTree.tsx`) usado hoy por el schema browser — virtualizado, keyboard nav, integración dnd-kit — que es candidato directo para renderizar el árbol de Saved Queries.

El editor SQL actual (`postgres-sql-editor` capability) está anclado al `connectionId` desde la creación del tab: el id del tab tiene la forma `pgquery:<connectionId>:<uuid>`, el payload incluye `{ connectionId, connectionName, sql }`, y el autocomplete está cableado al schema cache de esa conexión. Para soportar "abrir una saved query contra cualquier conexión sin reabrir" hay que romper este invariante.

## Goals / Non-Goals

**Goals:**
- Biblioteca personal de queries con nombre, organizadas en carpetas anidadas (sin límite de profundidad práctico).
- Acceso rápido desde sidebar siempre visible.
- Una saved query puede ejecutarse contra cualquier conexión disponible — la elección es runtime, no se guarda con la query.
- Save flow simple: primera vez pide nombre + carpeta; después es overwrite directo. Cmd+S nunca abre un picker después del primer save.
- Reutilizar exports del `ResultPanel` existente sin código nuevo.
- Cero impacto sobre `query-history`, `postgres_run_sql`, structured edit/filter.

**Non-Goals:**
- Snippets parametrizados (placeholders `$1`, `:param`). Las queries son completas y se ejecutan tal cual.
- Versionado / historial por saved query.
- Compartir entre usuarios o sincronizar en la nube.
- Búsqueda full-text del SQL. Solo filtro por nombre de carpeta/query.
- Soft delete / papelera. Hard delete con confirmación.
- Tags ortogonales a carpetas.

## Decisions

### D1: Modelo de datos — carpetas como entidad real (parent_id)

Dos tablas en lugar de un solo `folder_path` string.

```
┌─ saved_query_folders ───────────┐
│ id          TEXT PK (UUID v4)   │
│ parent_id   TEXT FK NULL        │──┐ self-FK ON DELETE CASCADE
│ name        TEXT NOT NULL       │  │
│ sort_order  INTEGER NOT NULL    │  │
│ created_at  INTEGER NOT NULL    │  │
│ updated_at  INTEGER NOT NULL    │  │
└─────────────────────────────────┘  │
              ▲                      │
              │ FK ON DELETE CASCADE │
              │                      │
┌─ saved_queries ─────────────────┐  │
│ id                TEXT PK       │  │
│ folder_id         TEXT FK NULL  │──┘
│ name              TEXT NOT NULL │
│ sql               TEXT NOT NULL │
│ sort_order        INTEGER NOT NULL │
│ last_connection_id BLOB NULL    │  -- UUID de connection_registry
│ created_at        INTEGER NOT NULL │
│ updated_at        INTEGER NOT NULL │
└─────────────────────────────────┘

raíz: parent_id IS NULL / folder_id IS NULL
```

Índices:
- `idx_folders_parent` on `saved_query_folders(parent_id, sort_order)`
- `idx_queries_folder` on `saved_queries(folder_id, sort_order)`
- `idx_queries_name` on `saved_queries(name)` para búsqueda case-insensitive

**Why over folder_path string**: carpetas vacías son válidas (usuario crea "reports/" antes de tener queries), rename de carpeta es O(1), drag-and-drop de carpeta entera es un solo UPDATE. El costo de joins extra es despreciable para datasets de cientos de filas.

**Cascade**: `ON DELETE CASCADE` en parent_id (folders) y folder_id (queries) — borrar una carpeta borra subcarpetas y queries. Frontend confirma siempre que la carpeta no esté vacía.

**No ciclos**: el frontend valida en los `move_folder` que el target no es descendiente del nodo a mover. El backend valida también (defensa en profundidad).

### D2: Selector de conexión inline — `connectionId` deja el id del tab

**Antes**: `tabId = pgquery:<connectionId>:<uuid>`, `payload = { connectionId, connectionName, sql }`. Tab inmutable.

**Después**: `tabId = pgquery:<uuid>`, payload mutable `{ savedQueryId?: string, initialConnectionId?: string, initialSql: string }`. El connection actual vive en **state del tab** (`useQueryTabState`), no en el id ni en el payload de la registry.

```
┌─ Editor Header / Toolbar ──────────────────────────────────┐
│ [Connection: prod_db ▾]   │   [Save]  [Format]  [Run ⌘↩]   │
└────────────────────────────────────────────────────────────┘
```

- El selector lista todas las conexiones del `connection-registry`. La conexión activa se pinta con un dot de status (conectada/desconectada) reusando el indicador del sidebar.
- Cambiar conexión:
  1. Despacha effect que reconfigura el `Compartment` del autocomplete con `globalSchemaCache.getNamespace(newConnectionId)` (mismo mecanismo que ya existe para "cache update").
  2. Limpia el `runner.state` (cualquier resultado previo se descarta — pertenecía a la conexión anterior).
  3. NO marca el tab como dirty.
  4. Si hay `savedQueryId`, persiste `last_connection_id = newConnectionId` en `saved_queries` (debounced 1s, fire-and-forget).
- Si no hay conexión seleccionada al pulsar Run: muestra toast "Selecciona una conexión" y aborta.

**Why mutable**: lo pidió el usuario explícitamente, y abrir una query es un flujo más común que crear una tab nueva. La alternativa (modal picker al abrir) añade fricción.

**Trade-off**: el `useQueryRun` hook deja de recibir `connectionId` como prop estable; pasa a leerlo del state del tab. Esto fuerza re-renders en el componente padre cuando cambia, pero el editor sigue aislado en su propio `useEffect` reconfigurando solo el autocomplete compartment.

### D3: Reuso de tab por saved query

Cuando el usuario hace doble-click en una saved query del árbol:

```
openSavedQuery(savedQueryId) {
  existing = tabs.find(t => t.kind === "postgres-query" && t.state.savedQueryId === savedQueryId)
  if (existing) → focus(existing.id)
  else → open new pgquery tab with savedQueryId, initialSql, initialConnectionId=last_connection_id
}
```

El binding se mantiene en `useQueryTabState` (extiende el state per-tab actual). Si el usuario "Save As"-like quisiera dos vistas — no lo soporta el spec (siempre overwrite). Si abre la misma query en otra ventana del app — out of scope (multi-window no es feature actual).

### D4: Dirty state

Un tab está **dirty** cuando:
- (sql actual ≠ sql guardado) OR (name actual ≠ name guardado)
- Para queries no guardadas aún (sin `savedQueryId`): dirty si `sql.length > 0`.

NO marca dirty:
- Cambio de conexión.
- Re-ejecución de la query.
- Cambio en `last_connection_id` (es metadato de comodidad).

Indicador visual: dot `●` antes del título del tab. Tooltip "Unsaved changes". Cerrar tab dirty: confirmación "Discard unsaved changes?" con botones Discard / Cancel. (Diferencia con regla actual de `postgres-sql-editor` que descartaba sin confirmar — ese comportamiento sigue para tabs sin `savedQueryId`).

### D5: Save flow

Atajo `Cmd+S` bindeado a `Prec.highest` en el editor (compite con `Mod+Enter`, `Mod+Shift+F`).

```
onSave():
  if (!savedQueryId) {
    open SaveAsModal({ defaultName: tab.title, defaultFolderId: lastUsedFolderId })
    on confirm(name, folderId):
      record = invoke("saved_queries_create", { name, folderId, sql })
      tab.state.savedQueryId = record.id
      tab.state.savedSql = record.sql
      tab.state.savedName = record.name
      tab.title = record.name
      toast("Saved")
  } else {
    invoke("saved_queries_update", { id: savedQueryId, sql, name })
    tab.state.savedSql = sql
    tab.state.savedName = name
    toast("Saved")
  }
```

**Why no Save As ever**: el usuario lo pidió explícitamente. Si quiere "Save As", hace `Cmd+A`, `Cmd+C`, new tab, `Cmd+V`, `Cmd+S` — fricción aceptable porque es flujo raro.

### D6: Sidebar tree — reutilizar `SidebarTree`

```
┌─ SAVED QUERIES        + ▾ ─┐    ← header con botón "New" (menú: query / folder)
│ 🔍 Filter...               │    ← search box (filtra árbol por nombre)
├────────────────────────────┤
│ ▾ 📁 reports               │
│   ▾ 📁 finance             │
│     • Revenue              │
│     • Churn                │
│   ▸ 📁 ops                 │
│ ▾ 📁 adhoc                 │
│   • test query             │
│ • root-level query         │    ← queries sin folder al final
└────────────────────────────┘
```

- Componente: `SavedQueriesPanel.tsx` que envuelve `<SidebarTree />` (reusa la implementación de schema browser).
- Nodos tipados: `{ kind: "folder", id, name, children } | { kind: "query", id, name, folderId }`.
- Búsqueda: input arriba; filtro client-side (case-insensitive substring sobre nombre). Mientras hay filtro activo, todas las carpetas con descendientes que matchean quedan expandidas auto. Vaciar input vuelve al estado de expansión previo.
- Drag-drop:
  - Folder onto folder → move (validar no-ciclo).
  - Query onto folder → move.
  - Query onto query → no-op (no reordering en drop sobre item; reordenar vía menú "Move up/down" o drag entre slots).
  - Reordenar dentro de la misma carpeta: drag con drop entre items (indicador de línea).
- Right-click menú contextual:
  - Sobre query: Open, Open in new tab, Rename (F2), Duplicate, Move to folder…, Delete.
  - Sobre folder: New query, New folder, Rename (F2), Delete (con confirmación si tiene contenido).
  - Sobre área vacía / root: New query, New folder, Collapse all.
- Doble-click query: `openSavedQuery(id)` (reusa o abre).
- Rename inline: F2 o `Enter` con foco en nodo → input replace label; `Enter` confirma, `Esc` cancela. Validación: nombre no vacío.

### D7: Persistir estado de expansión

Settings key `savedQueries:expandedFolders` → `Set<folderId>`. Se actualiza con debounce 200ms en cada toggle. Se ignora durante búsqueda activa (la expansión auto-search no contamina el set guardado).

### D8: `last_connection_id` lifecycle

Persistencia en columna `last_connection_id` (BLOB UUID, nullable). Se actualiza:
- Al abrir una saved query y cambiar conexión vía selector (debounced 1s).
- Al guardar una saved query nueva con `Cmd+S` (toma la conexión activa del tab).

Al abrir saved query:
- Si `last_connection_id` está set Y la conexión existe Y está activa → selector pre-cargado.
- Si la conexión no existe (eliminada) o está desconectada → selector vacío, banner "Select a connection".

NO se elimina automáticamente si la conexión se borra — el connection-registry no notifica este módulo; cuando el usuario abre la query y la conexión no existe, el frontend lo trata como `null` y deja el campo vacío.

## UI: Flujo de Save

```
┌────────────────────────────────────────┐
│  Save Query                       [✕]  │
├────────────────────────────────────────┤
│  Name                                  │
│  ┌────────────────────────────────┐    │
│  │ Revenue by month               │    │
│  └────────────────────────────────┘    │
│                                        │
│  Folder                                │
│  ┌────────────────────────────────┐    │
│  │ ▾ reports / finance            │    │  ← treeselect (mismo árbol)
│  └────────────────────────────────┘    │
│                  + New folder…         │  ← inline botón
│                                        │
│              [ Cancel ]  [ Save  ⌘↩ ]  │
└────────────────────────────────────────┘
```

- Nombre validación: requerido, trim.
- Folder picker: dropdown con árbol, default = última carpeta usada (settings `savedQueries:lastUsedFolder`).
- "+ New folder…": inline expand → input → enter crea carpeta hija del folder seleccionado y la selecciona.

## Risks / Trade-offs

**[R1] Romper `tabId = pgquery:<connectionId>:<uuid>` invalida buffers in-session de usuarios con tabs abiertas al upgrade**
→ Aceptable. Los buffers (`pgQueryBuffer:<tabId>` settings) son in-session y se descartan al cerrar tab. Un cambio de id en upgrade equivale a un app restart desde el punto de vista del usuario. Documentar en CHANGELOG.

**[R2] Selector de conexión en el editor obliga a refactorizar `useQueryRun` que asume `connectionId` estable**
→ Mitigación: pasar `connectionId` como argumento explícito a `runner.run(connectionId, ...)` en lugar de capturarlo en closure. El hook ya tiene `runStartedAt` mutable; añadir un argumento es bajo riesgo.

**[R3] Schema cache observer puede tener leaks si el callback no se desuscribe al cambiar conexión**
→ Mitigación: el `useEffect` que observa la cache se cleanup-ea al cambiar `connectionId` (dep array). Test: cambiar conexión 5 veces no acumula observadores (verificar con `globalSchemaCache._observerCount` en dev).

**[R4] Drag-drop puede crear ciclos si la validación falla**
→ Mitigación: doble validación (frontend + backend). Backend rechaza con `AppError::Validation` si `target_parent_id` es descendiente del `id` movido (CTE recursivo en SQLite).

**[R5] Save con nombre duplicado en la misma carpeta**
→ Decisión: permitirlo. Las queries son ergonomía personal; el usuario puede tener "test" en dos carpetas o duplicado en una. No constraint UNIQUE.

**[R6] Race: usuario edita SQL durante save**
→ El save toma el snapshot del editor en el momento del click; ediciones posteriores quedan dirty contra el snapshot guardado. Comportamiento esperado.

**[R7] Rendimiento del árbol con N grande**
→ `SidebarTree` ya virtualiza. Hasta 10k nodos no debería degradar; el modelo `parent_id` requiere construir el árbol en frontend, complejidad O(N). Aceptable para datasets esperados (<1k queries por usuario).

## Migration Plan

1. **Migración SQLite**: `0003_saved_queries.sql` crea ambas tablas + índices. Sin datos previos a migrar (capability nueva).
2. **Rollback**: si la migración falla post-deploy, revertir el binary; las tablas vacías no afectan otras features. La nueva migración solo crea tablas — no modifica `query_history` ni `connection_registry`.
3. **Forward-compat**: tabs antiguas con id `pgquery:<connId>:<uuid>` que sigan en settings (`pgQueryBuffer:<tabId>`) serán huérfanos sin tab y se limpiarán naturalmente. El nuevo formato `pgquery:<uuid>` no colisiona.

## Open Questions

Ninguna bloqueante. Decisiones a confirmar durante implementación:
- ¿Iconos específicos para folder vs query? (default lucide: Folder / FileCode2)
- Tamaño máximo del SQL guardado: ¿límite duro? Propuesta: 1 MB (sanity check, no constraint).
- "Duplicate query": ¿abre el modal de save con name `Revenue (copy)` o crea silently y abre tab? Propuesta: crea silently con `(copy)` y selecciona el nodo en el árbol.
