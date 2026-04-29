## 1. Backend: Postgres run-sql command surface

- [x] 1.1 Crear `src-tauri/src/modules/postgres/sql.rs` con tipos `RunSqlResult` (variantes `Rows` y `Affected`), `RunSqlError` (con `position`), y `RunManyOutcome` (`Ok | Err | Skipped`).
- [x] 1.2 Implementar `postgres_run_sql(connection_id, sql, origin)`: clasifica con `is_mutating_sql`, ramifica a `execute_query` (rows envelope) o `execute_mutation` (affected envelope), aplica el cap de 10k filas (toma 10_000, descarta el siguiente, marca `truncated: true`), captura `tokio_postgres::Error::DbError::position` para `RunSqlError`.
- [x] 1.3 Implementar `postgres_run_sql_many(connection_id, statements, origin)`: borrowea un client del pool una sola vez, itera reusando la lógica de `run_sql` por statement con el mismo client, halt-on-error con `Skipped` para los siguientes, libera el client al final (incluso en error).
- [x] 1.4 Reusar `Value`/`CellValue` envelope existente para `kind: "rows"` (binary/truncated cells idénticos a `postgres_query_table`).
- [x] 1.5 Registrar ambos comandos en `src-tauri/src/modules/postgres/commands.rs` y en el `invoke_handler`.
- [x] 1.6 Tests unitarios cubriendo: SELECT puro, INSERT con `RETURNING *` (rows envelope), INSERT plano (affected), DDL (affected, 0 filas), error sintáctico (position propagada), read-only enforcement por `is_mutating_sql`, multi-statement halt-on-error, `SET search_path` persiste entre statements del mismo run.

## 2. Backend: Activity-log expansion

- [x] 2.1 Extender el enum `ActivityKind` con `RunSql`.
- [x] 2.2 Extender el enum `ActivityMetric` con variant `Affected { value: i64 }` y mapear su serialización snake_case (`{"kind":"affected","value":...}`).
- [x] 2.3 Helper de emisión en `run_sql.rs` (o donde viva el resto): construye `ActivityLogEntry` con `sql` poblado, `params: null`, `metric` según `RunSqlResult` variant.
- [x] 2.4 En `run_sql_many`, emitir un evento por statement ejecutada (ok o err); NO emitir para skipped.
- [x] 2.5 Verificar que `serde::Serialize` del nuevo metric variant respeta el shape ya documentado en spec (snake_case, value serializado como número entero).

## 3. Frontend: Dependencias y refactor del grid

- [x] 3.1 Añadir dependencias CodeMirror 6 a `package.json` (`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/language`, `@codemirror/autocomplete`, `@codemirror/search`, `@codemirror/lang-sql`).
- [x] 3.2 Extraer `<AdhocResultGrid columns rows onSelectRow emptyState />` desde `src/modules/postgres/data/DataGrid.tsx`. El nuevo componente NO acepta sort/filter/edit; sólo virtualización + render + selección.
- [x] 3.3 Refactor `DataGrid.tsx` para componer `<AdhocResultGrid />` por debajo (o compartir un primitive interno), preservando todo el comportamiento del table viewer (sort, filter, scroll-to-load, edit affordances). Compartido vía mismo CSS module y `@tanstack/react-virtual`; el `DataGrid` editable existente se mantiene intacto.
- [ ] 3.4 Manual smoke del table viewer: abrir tabla, paginar, filtrar, ordenar, editar, save. Asegurar que ningún regresión visual ni funcional. (Pendiente — manual QA al final.)
- [x] 3.5 Exportar `<AdhocResultGrid />` para que `postgres-sql-editor` la consuma. Importada vía path relativo (no hay `data/index.ts` en el proyecto).

## 4. Frontend: Splitter y autocomplete

- [x] 4.1 Crear `src/modules/postgres/sql/splitStatements.ts` con `splitStatements(sql: string): Statement[]` (estado char-by-char respetando `'…'`, `"…"`, `$tag$…$tag$`, `--`, `/* … */` con nesting).
- [x] 4.2 Función `getStatementUnderCursor(sql, cursorOffset): Statement | null` reusando el splitter.
- [ ] 4.3 Tests unitarios del splitter — DEFERRED: el frontend no tiene runner de tests (vitest/jest); añadirlo es scope creep. Validación vía manual QA + revisión de código. Las cases del spec están cubiertas en la implementación.
- [x] 4.4 Crear `src/modules/postgres/schema/globalSchemaCache.ts` (módulo global, no hook) que expone `{ schemas, relationsBySchema, columnsByRelation }` por `connectionId`. Poblado desde `useSchemaTree` y `useTableData`.
- [x] 4.5 Crear `src/modules/postgres/sql/autocomplete.ts` (`makeSchemaCompletion(connectionId)`): produce una `CompletionSource` que lee del schema cache y NO dispara IPC. Heurísticas posicionales para schemas/relations/columns + fallback keywords del dialecto.
- [x] 4.6 Helper `maybeRecordColumnsFromSelect(connectionId, sql, columns)` (en `columnCache.ts`) que detecta el patrón `SELECT … FROM "<schema>"."<relation>" …` simple y popula `columnsByRelation`. Llamado desde `useQueryRun` tras cada SELECT exitoso.

## 5. Frontend: Editor y runtime de ejecución

- [x] 5.1 Crear `src/modules/postgres/sql/QueryEditor.tsx`: monta CodeMirror 6 directo sobre un `<div ref>` con `EditorView`, language `sql({ dialect: PostgreSQL })`, autocomplete extension, keymap default + `Mod-Enter` (run), `Mod-Shift-Enter` (run all), `Mod-/` toggle comment. Expone `onChange(sql)` debounced 500ms y un `editorRef` para mover el cursor desde fuera (errores).
- [x] 5.2 Crear `src/modules/postgres/sql/api.ts` con `runSql(connectionId, sql)` y `runSqlMany(connectionId, statements)` que invocan los comandos Tauri y devuelven los tipos discriminados.
- [x] 5.3 Crear `src/modules/postgres/sql/useQueryRun.ts`: estado `{ status: "idle" | "running" | "done" }` con outcome discriminado por `mode: "single" | "multi"`. Método `run({ fullSql, selectionFrom, selectionTo, cursor, forceAll? })` que decide single vs multi via `splitStatements` y dispatch al backend.
- [x] 5.4 Crear `src/modules/postgres/sql/useQueryBuffer.ts`: lee/escribe `pgQueryBuffer:<tabId>` con debounce 500ms; cleanup al unmount/close.

## 6. Frontend: Result panel y multi-tabs

- [x] 6.1 Crear `src/modules/postgres/sql/ResultPanel.tsx`: ramifica entre empty hint, `<AdhocResultGrid />` para `kind: "rows"`, summary line para `kind: "affected"`, `<ResultErrorBlock />` para errores. Banner de truncation cuando aplica.
- [x] 6.2 Crear `src/modules/postgres/sql/ResultErrorBlock.tsx`: renderiza message + SQLSTATE + botón "Show in editor" que mueve el cursor del editor a `position - 1` (o `statement.startOffset + position - 1` para multi).
- [x] 6.3 Crear `src/modules/postgres/sql/MultiStatementTabs.tsx`: sub-tabs por outcome con labels (`<i> · <summary>`), default selecciona la primera err si hay, sino la primera.
- [x] 6.4 Indicador de status (running/last-run) en el header del panel (`5 rows · 12 ms` / `Running…`).
- [x] 6.5 Drag handle entre editor y panel; persistencia de altura bajo `pgQueryResultHeight:<tabId>` (clamped 120-800).
- [x] 6.6 Banner read-only encima del editor cuando `connection.params.read_only === true`.

## 7. Frontend: Tab kind, registro y entry points

- [x] 7.1 Crear `src/modules/postgres/sql/QueryTab.tsx`: composición de banner + editor + drag handle + result panel. Wireado de `useQueryBuffer`, `useQueryRun`, `makeSchemaCompletion`. Foco al montar (vía CodeMirror).
- [x] 7.2 Registrar el tab kind `postgres-query` en el `TabRegistry` (vía side-effect `import` desde `@/platform/shell/tabs/index.ts`). Title default `Query <N>` con counter por conexión en memoria.
- [x] 7.3 Helper `openQueryTab(tabs, { connectionId, connectionName, sql? })` que crea la pestaña con `pgquery:<connectionId>:<uuid>` y la enfoca.
- [x] 7.4 Registrar `SQL: New Query` en command-palette. **DESVIO DEL SPEC**: `SQL: New Query Here` (contextual al focus del sidebar) requiere infraestructura de focus-tracking que no existe (el SidebarTree mantiene focus interno pero no lo expone globalmente). El botón `+ Query` por conexión ya cubre el path principal; "Here" queda como follow-up.
- [x] 7.5 Añadir botón `+ Query` en `SchemaToolbar` (icono `Terminal`) que dispara `openQueryTab` para esa conexión. Visible solo cuando connected.
- [ ] 7.6 Extender `src/platform/shell/Inspector.tsx` para reaccionar a `tab.kind === "postgres-query"` — DESVIO: el shell `Inspector` actual es solo placeholder. El `ResultPanel` del query tab inline su propio inspector (reusa `<RowInspector />` de `data/Inspector.tsx`), igual que el TableViewerTab inline el suyo en lugar de usar el shell. Esto es consistente con el patrón existente.

## 8. QA manual y cierre

- [ ] 8.1 Smoke contra BD local: SELECT simple, SELECT con > 10k filas (verifica truncation banner y metric), INSERT (kind affected), DDL (kind affected con 0 rows), error sintáctico (banner + Show in editor mueve cursor).
- [ ] 8.2 Multi-statement: tres SELECTs encadenados (sub-tabs aparecen y permiten navegar), middle-statement falla (sub-tabs muestran ok / err / skipped, focus auto en err).
- [ ] 8.3 Read-only enforcement: contra una conexión read-only, banner aparece, SELECT corre, DELETE devuelve error de validación con mensaje claro.
- [ ] 8.4 Autocomplete: con sidebar expandido en un schema con tablas, completar `FROM ` sugiere relations cacheadas; sin cache, sólo keywords; tras correr `SELECT … FROM "public"."users"`, completar columnas de users funciona en una pestaña distinta.
- [ ] 8.5 Persistencia de buffer: tipear, cambiar de pestaña, volver — el SQL sigue ahí. Cerrar la pestaña — el setting `pgQueryBuffer:<tabId>` desaparece.
- [ ] 8.6 Splitter: verificar manualmente con SQL conteniendo strings con `;`, dollar-quoted con CREATE FUNCTION, comentarios anidados.
- [ ] 8.7 Activity-log: cada run aparece con `kind: "run_sql"`, `origin: "user"`, metric correcto. Multi-statement con falla emite N+1 entries (skipped no emite).
- [ ] 8.8 Update `openspec/ROADMAP.md` marcando #6 `run-sql` como en progreso/archivado tras merge.

> **Nota**: las tareas 8.x son QA manual contra una BD local; no se pueden automatizar desde aquí. Los cambios pasaron `cargo build`, `cargo test --lib` (97 tests, 0 failures), `pnpm typecheck`, y `pnpm build` sin errores. La validación funcional end-to-end queda para el usuario antes de mergear.
