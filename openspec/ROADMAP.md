# Argus — Roadmap de cambios

Plan de alto nivel de los `change` de OpenSpec que conforman la versión 1 (Postgres) y los siguientes (DynamoDB, CloudWatch). Cada item es un `/opsx:propose` futuro: el nombre kebab-case sirve directo como argumento.

> Convención: cada change entrega una rebanada vertical funcional. Si una característica no cabe en una sesión, se parte en dos. Nada de PRs gigantes.

---

## V1 — Postgres

```
1. bootstrap-tauri-shell        ✅ archivado
2. add-postgres-connection      ✅ archivado
3. browse-postgres-schema       ✅ archivado
3.5. refine-schema-browser-ux   ✅ archivado (UX iteration sobre #3)
4. view-table-data              ✅ archivado
5. edit-table-data              ✅ archivado
6. run-sql                      ← siguiente
7. query-history
8. table-structure-tab
```

Después del #5 ya tienes una herramienta utilizable para reemplazar TablePlus en tu uso diario.

### 1. `bootstrap-tauri-shell` ✅ archivado

**Meta**: Esqueleto Tauri 2 + React + Vite. Layout, paleta vacía, registry de conexiones, theming, atajos base.
**Capacidades**: `app-shell`, `command-palette`, `connection-registry`.
**Depende de**: nada.
**Estado**: archivado en `openspec/changes/archive/2026-04-28-bootstrap-tauri-shell` (PR #2).

---

### 2. `add-postgres-connection` ✅ archivado

**Meta**: Crear/editar/borrar conexiones reales de Postgres. Test de conexión sincrónico. Toggle read-only por conexión.
**Capacidades nuevas**: `postgres-connection` (módulo Postgres en `src/modules/postgres/` y `src-tauri/src/modules/postgres/`).
**Capacidades modificadas**: `connection-registry` (acepta `kind: "postgres"` con params específicos validados).
**Incluye**:

- Form completo: host, port, database, username, password, sslmode, application_name.
- Form alternativo: pegar una `postgresql://` URL y parsearla.
- Toggle `read_only: bool` en params; el módulo Postgres lo respeta y rechaza mutaciones cuando está activo.
- Comando `postgres.testConnection(params, secret)` que abre y cierra una conexión y reporta latencia + versión.
- Comandos `postgres.connect(id)` / `postgres.disconnect(id)` que mantienen un pool por conexión activa.
- UI: dialog desde el "+" del sidebar; estados loading/error/success en el test.
  **Out of scope**: SSH tunnel, certificados cliente, opciones avanzadas tipo `connect_timeout` (futuro change si hace falta).
  **Depende de**: 1.
**Estado**: archivado en `openspec/changes/archive/2026-04-28-add-postgres-connection` (PR #4).

---

### 3. `browse-postgres-schema` ✅ archivado

**Meta**: Sidebar muestra schemas → tablas, vistas, vistas materializadas, funciones, tipos, extensiones (sequences quedaron fuera tras `refine-schema-browser-ux`). Filtrable + selector de schemas visibles.
**Capacidades nuevas**: `postgres-schema-browser`.
**Capacidades modificadas**: `app-shell` (sidebar admite secciones jerárquicas con búsqueda).
**Incluye**:

- Comando `postgres_list_schemas(id)`.
- Comando `postgres_list_objects(id, schema)` → tablas, vistas, mat-views, funciones, tipos, extensiones, triggers, índices.
- UI: árbol bajo cada conexión activa con dos grupos planos `Data` y `Structure`, search box, picker de schemas visibles (persiste en `settings`).
- Click en un objeto abre una pestaña placeholder en el área central — el viewer real vive en changes posteriores.
- Timeout 15s con `pg_cancel_backend` real + auto-retry una vez en SQLSTATE 57014, botón manual de retry para el resto (de `refine-schema-browser-ux`).
  **Out of scope**: edición del schema (DDL), diff de schemas, ER diagrams.
  **Depende de**: 2.
**Estado**: archivado en `openspec/changes/archive/2026-04-28-browse-postgres-schema` y refinado en `openspec/changes/archive/2026-04-28-refine-schema-browser-ux`.

---

### 4. `view-table-data`

**Meta**: Click en una tabla → grid paginado estilo TablePlus. Sort por columna, filtros simples por columna. Panel inspector a la derecha muestra fila seleccionada.
**Capacidades nuevas**: `postgres-data-grid`.
**Incluye**:

- Comando `postgres.queryTable(connectionId, schema, table, { limit, offset, orderBy, filters })`.
- Grid con TanStack Table + virtualizer; scroll-to-load (LIMIT + OFFSET).
- Default 200 filas por carga, **configurable por tabla** (la preferencia se guarda en `settings` con key `tableLimit:<schema>.<table>`).
- Filtros: header de columna con operadores (`=`, `!=`, `LIKE`, `IS NULL`, `>`, `<`, rangos numéricos, rangos de fecha).
- Sort: click en header (cycle: asc → desc → none), multi-column con shift-click.
- Panel inspector: form read-only de la fila seleccionada con todos los campos.
- Indicador "X of N rows" en la barra inferior. Conteo total perezoso (botón "Count rows" — `SELECT COUNT(*)`).
  **Out of scope**: edición (siguiente change), exportar, agrupar.
  **Depende de**: 3.

---

### 5. `edit-table-data`

**Meta**: Edición de celdas estilo TablePlus — buffer local, celdas sucias resaltadas, ⌘S commitea todo en una transacción. Insert y delete de filas. Diff preview antes de commit.
**Capacidades nuevas**: `postgres-data-edit`.
**Capacidades modificadas**: `postgres-data-grid` (grid acepta modo editable; respeta read-only flag).
**Incluye**:

- Edit-in-place: doble click en celda, edición inline tipada según el tipo Postgres (input, textarea para text largo, picker para enums, etc.).
- Estado dirty por celda visualizado (color de fondo distinto).
- Insert: botón "+" → fila nueva editable; queda dirty hasta commit.
- Delete: seleccionar fila(s) + tecla ⌫ → marcadas para borrar (visual: tachadas).
- ⌘S abre el preview de diff: lista de UPDATE/INSERT/DELETE que va a ejecutar.
- Confirmar el preview ejecuta `BEGIN; ...; COMMIT;` en una sola tx; en caso de error, rollback completo y mensaje claro.
- Si la conexión es read-only, todas las operaciones están deshabilitadas en UI y el backend rechaza por seguridad.
  **Out of scope**: edición de tipos complejos (jsonb editor avanzado, array editor) — funciona pero como texto en V1.
  **Depende de**: 4.

---

### 6. `run-sql`

**Meta**: Pestaña dedicada a ejecutar SQL libre. CodeMirror 6 con highlight Postgres, autocomplete de tablas/columnas del schema cargado. Múltiples pestañas de query simultáneas.
**Capacidades nuevas**: `postgres-sql-editor`.
**Incluye**:

- Tab kind `postgres-query` con un editor CodeMirror por pestaña.
- Atajo ⌘↩ ejecuta selección o, si no hay selección, la statement bajo el cursor.
- Autocomplete: tablas y columnas del schema activo (carga al abrir la conexión).
- Resultado debajo del editor: grid (reusa el de #4 pero en modo read-only), o "X rows affected" para statements no-SELECT.
- Indicador de tiempo de ejecución y filas devueltas.
- Multi-statement: si hay varias separadas por `;`, ejecuta en orden y muestra resultados por pestañas internas.
  **Out of scope**: explain visualizer, format SQL, snippets de usuario.
  **Depende de**: 3 (necesita el schema cargado para autocomplete). Puede convivir con 4/5 sin tocarlas.

---

### 7. `query-history`

**Meta**: Pestaña History con todas las queries ejecutadas, persistida. Filtrable por conexión, fecha, texto. Click → carga al editor.
**Capacidades nuevas**: `query-history`.
**Capacidades modificadas**: `postgres-sql-editor` (cada ejecución registra en history).
**Incluye**:

- Tabla `query_history` en SQLite: `(id, connection_id, kind, sql, started_at, duration_ms, row_count, error?)`.
- Tab kind `history` accesible desde el sidebar (sección Plataforma) o desde la paleta (`History: Open`).
- UI: lista virtualizada con timestamp + connection name + primer fragmento del SQL.
- Click → abre nueva pestaña query con ese SQL pre-cargado.
- Búsqueda full-text simple (LIKE) sobre el SQL.
- Retención: configurable, default 30 días o 10k entradas (lo que llegue primero).
  **Out of scope**: history compartido entre máquinas, etiquetado manual, queries favoritas (puede ser un siguiente change `saved-queries`).
  **Depende de**: 6.

---

### 8. `table-structure-tab`

**Meta**: La pestaña de tabla tiene tres tabs internos como TablePlus: Data / Structure / Raw. Structure muestra columnas, tipos, defaults, PK, FKs, índices, triggers. Raw muestra el `CREATE TABLE` reconstruido.
**Capacidades nuevas**: `postgres-table-structure`.
**Capacidades modificadas**: `postgres-data-grid` (envuelta en un sub-tabset Data/Structure/Raw).
**Incluye**:

- Comando `postgres.tableStructure(connectionId, schema, table)` → columnas, constraints, índices, triggers, FKs.
- Subtab Structure: tabla con columnas (nombre, tipo, nullable, default, PK?, FK?, comentario).
- Subtab Raw: bloque DDL reconstruido con CodeMirror read-only y botón Copy.
- Las funciones también obtienen una vista similar (subtabs Definition / Signature / Calls).
  **Out of scope**: editar el schema (alter table, create index) — eso sería `edit-postgres-schema` en V1.5.
  **Depende de**: 3.

---

## Crossroads y changes opcionales (cuando se justifiquen)

Estos no están en la ruta crítica. Se proponen cuando el dolor sea real:

- `add-ssh-tunnel` — soporte SSH para conexiones detrás de bastión.
- `export-table-data` — CSV / JSON / SQL inserts.
- `import-csv` — cargar un CSV a una tabla.
- `saved-queries` — favoritos con nombre + carpetas.
- `multi-window` — abrir varias ventanas con conjuntos distintos de pestañas.
- `keyboard-shortcuts-editor` — UI para reasignar atajos.
- `schema-search` — buscar columnas/tablas por nombre cross-schema.
- ~~`auto-update` — `tauri-plugin-updater` para release continua.~~ ✅ resuelto en `ship-beta-auto-update` (pipeline completo de beta + auto-updater silencioso vía R2).

---

## V2 — DynamoDB

Cada uno de estos sigue el mismo patrón que el flujo Postgres pero con su propio modelo:

```
9.  add-dynamo-connection         ← AWS credential chain, perfil/región
10. browse-dynamo-tables          ← lista de tablas + descripción (KeySchema, GSIs)
11. view-dynamo-items             ← scan/query con paginación por LastEvaluatedKey,
                                    detalle como JSON pretty
12. edit-dynamo-items             ← put/update/delete; sin "transacción" estilo
                                    Postgres — cada operación es atómica
13. run-partiql                   ← editor con highlight PartiQL
```

**Decisiones a aterrizar cuando llegue el momento**:

- ¿Credenciales vía AWS profile (`~/.aws/credentials`), SSO, o pegar access keys? (probablemente las tres).
- ¿Cómo presentar items con shapes heterogéneos en una grid? Pestaña de modo `JSON` vs `Tabla` con columnas inferidas.

---

## V2 — CloudWatch

```
14. add-cloudwatch-connection     ← reutiliza credencial AWS de Dynamo si existe
15. browse-log-groups             ← árbol de log groups + streams
16. tail-log-stream               ← live tail con filtros simples
17. run-cloudwatch-insights       ← editor Insights + grid de resultados
18. metrics-explorer              ← (opcional) explorar métricas, no solo logs
```

CloudWatch es read-only por naturaleza — no hay edición. La UX se acerca más a un visor de logs (Datadog-like) que al grid de TablePlus.

---

## Notas transversales

- **Cross-cutting**: ningún change V2 toca código del módulo Postgres. Solo añade cosas en `src/modules/<source>/` y `src-tauri/src/modules/<source>/`. Si descubres que necesitas modificar algo del Postgres para soportar Dynamo, **es señal de que la abstracción se está colando donde no debe** — para, repensa.
- **Versionado de specs**: cuando un change modifica una capability existente, el `spec.md` del change usa `## MODIFIED Requirements` con el bloque entero copiado y editado. No deltas parciales.
- **Capability naming**: usar prefijos por dominio: `postgres-*`, `dynamo-*`, `cloudwatch-*`. Lo compartido sin prefijo: `app-shell`, `command-palette`, `connection-registry`, `query-history`.
- **Sesiones**: cada change debería caber en 1-2 sesiones de trabajo. Si en `/opsx:propose` el `tasks.md` supera 60 ítems, considerar partir el change en dos.
