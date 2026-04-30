## Context

`postgres-sql-editor` (PR #10) ya emite `argus:activity-log` con `kind: "run_sql"` para cada statement ejecutado, vía `emit_activity()` en `src-tauri/src/modules/postgres/sql.rs`. Esos eventos sólo viven en memoria (panel inferior) y se pierden al reiniciar la app.

La app ya cuenta con la infraestructura necesaria:

- **SQLite local** (`<app_data_dir>/argus.db`) con `rusqlite` y migraciones idempotentes en `src-tauri/migrations/` (la primera y única migración hoy es `0001_init.sql` con `connections` + `settings`).
- **Pool registry** (`src-tauri/src/modules/postgres/pool.rs`) que ya conoce el `connection_id` (UUID) y el `name` para cualquier ejecución activa.
- **Tab kinds** registrables vía `TabRegistry.register(kind, component)` con payload tipado por kind, y helper `openQueryTab()` para crear nuevas pestañas `postgres-query` con SQL pre-cargado.
- **Settings KV store** (`platform/settings`) accesible desde Rust y desde TypeScript.
- **Sidebar primitives** (`SidebarTree`, secciones planas) ya descritos en `app-shell` — agregar una nueva sección es composición, no extensión del primitive.

## Goals / Non-Goals

**Goals:**

- Cero pérdida de queries entre sesiones: si corrió, queda persistida.
- Acceder a la historia y reabrir cualquier query con un click.
- Filtros utilizables sin abrir la documentación (UI auto-explicativa).
- Sin nuevas dependencias.
- Acotado a una o dos sesiones de implementación.

**Non-Goals:**

- Sincronización entre máquinas / cloud backup.
- Etiquetado manual o "favoritos" (eso será un change futuro `saved-queries`).
- Editar entradas en sitio.
- Búsqueda full-text avanzada (FTS5) — `LIKE %term%` basta para 10k filas.
- Aggregaciones / dashboards de queries (slowest, most-frequent, etc.) — futuro.
- Persistir queries que sólo se ejecutaron internamente para introspección de schema (esos no pasan por `postgres_run_sql`).

## Decisions

### 1. Punto único de persistencia: dentro de `postgres_run_sql` y `postgres_run_sql_many`

Insertar la fila en SQLite **en el mismo punto** donde hoy se llama `emit_activity()`, antes de retornar. Es síncrono, mismo thread, una sola conexión a SQLite por inserción.

**Alternativa considerada**: un listener desacoplado que se suscribe al canal `argus:activity-log`. La rechazo porque:

- Activity-log incluye más kinds (`run_sql`, futuros `query_table`, etc.) — el listener tendría que filtrar.
- Introduce latencia y complejidad de delivery (¿qué pasa si la app crashea entre emisión y persistencia?).
- El acoplamiento explícito en `sql.rs` es más legible y trivial de auditar.

Trade-off aceptado: si en el futuro otros comandos quieren registrarse en history, replicarán el patrón puntual o lo extraeremos a un helper.

### 2. Una fila por statement ejecutado, no por "run"

En `postgres_run_sql_many` con N statements donde el segundo falla y los siguientes son `skipped`:

- Statement 1 (ok) → 1 fila history
- Statement 2 (err) → 1 fila history
- Statements 3..N (skipped) → **0 filas**

Esto coincide 1:1 con los eventos de activity-log que el editor ya emite, y es lo que el usuario espera ver en su historia ("ese DELETE falló, no se ejecutó nada después").

### 3. Snapshot del nombre de conexión en cada fila

La fila de history almacena `connection_id` (UUID, BLOB) **y** `connection_name` (TEXT) capturado en el momento de la ejecución.

**Por qué**: si el usuario borra la conexión, las filas de history siguen siendo legibles ("postgres-prod" en vez de "(unknown)"). Y "open in editor" puede deshabilitarse limpiamente cuando `connection_id` ya no existe en la tabla `connections`.

**Alternativa**: JOIN contra `connections` al listar. Rechazado porque obliga a borrar history en cascada al borrar conexión, perdiendo contexto histórico.

### 4. Una nueva migración aditiva, sin tocar tablas existentes

`0002_query_history.sql`:

```sql
CREATE TABLE query_history (
  id              TEXT PRIMARY KEY,           -- uuid v4 stringificado
  connection_id   BLOB NOT NULL,              -- mismo formato que connections.id
  connection_name TEXT NOT NULL,              -- snapshot al momento de la ejecución
  sql             TEXT NOT NULL,
  origin          TEXT NOT NULL,              -- 'user' | 'auto'
  status          TEXT NOT NULL,              -- 'ok' | 'err'
  started_at      INTEGER NOT NULL,           -- unix ms (mismo formato que activity-log)
  duration_ms     INTEGER NOT NULL,
  row_count       INTEGER,                    -- presente cuando status='ok' y kind='rows'
  command_tag     TEXT,                       -- presente cuando status='ok' y kind='affected'
  error_code      TEXT,                       -- SQLSTATE cuando aplica
  error_message   TEXT
);

CREATE INDEX idx_query_history_started ON query_history (started_at DESC);
CREATE INDEX idx_query_history_connection ON query_history (connection_id, started_at DESC);
```

El schema es estable — los campos cubren el contrato del activity-log más el snapshot del nombre. Nada de sub-tablas para parámetros (no usamos parámetros en run-sql) ni para tags de error (un `(code, message)` plano alcanza).

### 5. Listing API paginada con filtros server-side

```ts
queryHistoryList({
  connection_ids?: string[],     // multi-select
  since?: number,                // unix ms
  until?: number,                // unix ms
  search?: string,               // LIKE %search% sobre sql
  status?: 'ok' | 'err',         // opcional
  limit: number,                 // default 200, max 1000
  offset: number,                // default 0
}) → { entries: HistoryEntry[], total: number }
```

`total` se devuelve para mostrar "X of Y" en la UI. Sin `total` el usuario no sabe si vale la pena scroll-loadear más. Costo: un `SELECT COUNT(*)` adicional con los mismos filtros — aceptable para 10k filas.

`ORDER BY started_at DESC, id DESC` (con id como tie-breaker estable). El índice `idx_query_history_started` lo cubre.

### 6. Retención: enforcement perezoso al startup

Al arrancar la app, después de migraciones, ejecutar:

```sql
-- por antigüedad
DELETE FROM query_history WHERE started_at < (now_ms - retentionDays * 86400000);

-- por cap absoluto
DELETE FROM query_history WHERE id NOT IN (
  SELECT id FROM query_history ORDER BY started_at DESC LIMIT retentionMaxRows
);
```

**Por qué startup-only**: la operación es barata (10k filas) pero no instantánea (~10ms). Hacerla en cada insert añade latencia al run-sql que ya tiene que ser percibido como instantáneo. Un usuario que dispara 1000 queries en una sesión sigue dentro del cap y no necesita prune mid-session.

Botón manual "Clear history" en el tab corre el mismo prune ignorando los settings (borra todo o por filtros activos).

### 7. Tab single-instance con id fijo `history`

Tab kind: `query-history`. Tab id: literalmente `"history"` (no `query-history:<uuid>`).

**Por qué**: abrir History dos veces no tiene sentido — es una vista de una tabla. Si ya existe, focus; si no, créala. `useTabs().open()` ya trata id duplicado como focus-existing.

Payload: `null` (la pestaña gestiona sus propios filtros internamente).

### 8. Acción "Open in editor" siempre crea un tab nuevo

Click en una fila → `openQueryTab(tabs, { connectionId, connectionName, sql })`. Esto reusa el helper existente del SQL editor, que **siempre crea una pestaña nueva** (el spec de `postgres-sql-editor` lo dice explícitamente).

**Caso conexión borrada**: si `connectionId` no está en la tabla `connections`, deshabilitar el click y mostrar tooltip `Connection no longer registered`. Botón secundario `Copy SQL` siempre disponible.

**Caso conexión existe pero no está activa**: abrimos la pestaña igual contra ese `connectionId`. La query tab existente ya muestra estado "not connected" cuando el pool no tiene un client activo (comportamiento heredado de `postgres-sql-editor`).

### 9. UI: lista virtualizada con TanStack Virtual

Reusa `@tanstack/react-virtual` que ya se usa en `SidebarTree` (per `app-shell`). Filas de altura fija (~44px) → virtualización trivial.

Layout de fila:

```
[hh:mm:ss · MMM dd]  [conn-name pill]  [SQL preview ········· ]  [12 ms · 5 rows]  [✓/✗]
```

Truncar SQL preview con ellipsis a una línea, mostrando completo en tooltip + en panel de detalle al hover/select.

Filtros en una barra superior:

- Connection picker — multi-select con todas las conexiones registradas (incluyendo borradas marcadas con `(deleted)`).
- Date range — dos inputs `date` nativos (today / yesterday / 7d / 30d / custom presets).
- Search — input de texto con debounce 200ms, busca LIKE en `sql`.
- Status filter — toggle "errors only".
- "Clear history" — botón destructivo con confirm.

### 10. Comando de paleta y entrada de sidebar

Comando registrado por el módulo `query-history`:

```ts
{
  id: 'argus.history.open',
  label: 'History: Open',
  group: 'History',
  keywords: ['recent', 'queries', 'log'],
  run: () => tabs.open({ id: 'history', kind: 'query-history', title: 'History', payload: null, closable: true })
}
```

Sección sidebar `Plataforma` debajo de `Connections` con una sola fila clickable `History` que dispara el mismo `tabs.open(...)`. Implementada en `src/platform/shell/Sidebar.tsx` consumiendo el primitive de `SidebarTree` o un row simple (no requiere árbol — una sola entrada plana).

## Risks / Trade-offs

- **Rendimiento de inserción en SQLite por cada run-sql** → mitigación: una sola fila, una sola conexión rusqlite, índice mínimo. Medido informalmente: <1ms por insert. Si se vuelve un cuello de botella, batchear cada N runs o usar canal async — pero no anticipar.
- **Crecimiento de DB sin tope visible** → mitigación: retention al startup + botón "Clear history" + cap absoluto de 10k. Aun a 1KB por SQL promedio, 10k * 1KB = 10MB, irrelevante.
- **Borrar una conexión y perder contexto** → mitigación: snapshot del `connection_name` en la fila. Si el usuario borra la conexión, las filas siguen siendo legibles aunque `Open in editor` quede deshabilitado.
- **Multi-statement runs grandes (100+ statements)** → ese caso ya genera 100 eventos de activity-log; agregar 100 filas más no cambia el orden de magnitud. Si llega a doler, batchear los inserts dentro del run-many con una transacción explícita.
- **Filtro `LIKE %term%` no usa índice** → trade-off aceptado: con cap de 10k filas un table-scan toma ~5ms. Promote a FTS5 cuando dueles.
- **Concurrent writers a SQLite** → rusqlite con WAL (default desde `0001_init.sql`?) maneja un escritor por vez. El run-sql ya está serializado por el pool por conexión; no hay concurrencia real entre múltiples runs.

## Migration Plan

- Migración `0002_query_history.sql` aditiva — apps existentes ganan una tabla vacía al primer arranque post-update.
- Settings nuevos (`queryHistory.retentionDays`, `queryHistory.retentionMaxRows`) tienen default values en código si la key no existe — no requieren seed.
- Sin rollback automático: bajar de versión deja la tabla huérfana en SQLite, sin afectar el resto de la app.

## Open Questions

- ¿Mostrar el SQL preview en monoespaciada (Geist Mono) o en sans? Por consistencia con el editor sugiero monoespaciada con tamaño reducido. **Decisión inicial: Geist Mono 12px, una línea con ellipsis**.
- ¿"Clear history" pide confirmación con modal o es one-click + undo toast? Sin patrón previo en la app para undo toasts. **Decisión inicial: modal de confirm con texto del scope ("Delete all 8,432 history entries?")**.
- ¿Re-ejecutar directamente desde la fila (sin abrir editor)? Tentador pero abre la puerta a accidentes (correr un DELETE viejo sin revisarlo). **Decisión: no, sólo "Open in editor" + decisión consciente de presionar Run**.
