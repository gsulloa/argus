## Why

El autocompletado custom del editor SQL (`makeSchemaCompletion` en `sql/autocomplete.ts`) tiene problemas estructurales que se manifestaron como **"sale una sola sugerencia a la vez"**:

- `matchBefore(/[A-Za-z_."`]+$/)` es greedy y come puntos: cuando el usuario escribe `public.us`, captura `"public.us"` como un solo token en vez de `"us"`. El filtro fuzzy de CodeMirror compara `"public.us"` contra labels como `"public.users"` (match) y `"analytics.events"` (no match) — pocas opciones sobreviven.
- Con `autocompletion({ override: [customSource] })` reemplazamos las **fuentes default**, así que **no hay autocomplete de keywords** (`SELECT`, `FROM`, `WHERE`…). El usuario no obtiene nada hasta que escribe en un contexto reconocido por nuestras heurísticas de regex.
- Identificadores con dígitos (`users_2024`, `t1`) rompen el regex.
- No hay scoping AST-aware: `SELECT u.id FROM users u` no ofrece columnas de `users` cuando el usuario escribe `u.`.
- No hay reconocimiento de CTEs (`WITH recent AS (…) SELECT * FROM rec…`) ni temp tables.

`@codemirror/lang-sql` ya exporta dos fuentes de fábrica que resuelven la mayoría de esto canónicamente: `keywordCompletionSource(dialect)` y `schemaCompletionSource({ schema })`. La segunda usa el parser real del lenguaje para FROM-scoping, alias, qualified names, y CTE awareness.

Esta rebanada **descarta `makeSchemaCompletion`** y compone las fuentes de `lang-sql` con un tercer source AST-driven para identificadores del documento. Además, **pre-carga columnas en bulk** por schema en background, así apenas el usuario hace visible un schema en el sidebar, el editor SQL ya tiene el árbol de columnas listo.

## What Changes

### Backend (Postgres / activity-log)

- **Nuevo comando IPC `postgres_list_columns_bulk(connection_id, schema, origin?)`** que retorna columnas de **todas** las relaciones (tablas, views, mat-views, partitioned, foreign) de un schema en una sola query. Shape:

  ```rust
  struct ColumnsBulkResult {
      schema: String,
      columns_by_relation: BTreeMap<String, Vec<BulkColumnInfo>>,
  }
  struct BulkColumnInfo {
      name: String,
      data_type: String,         // pg_catalog.format_type
      ordinal_position: i32,
      is_nullable: bool,
      default_value: Option<String>,  // NEW vs DataColumn — útil para autocomplete tooltip
      comment: Option<String>,        // NEW — pg_description, surface en tooltip
  }
  ```

- Una sola query a `pg_attribute` joineada con `pg_class`, `pg_namespace`, `pg_attrdef`, `pg_description`, filtrada por `nspname = $1`, `relkind IN ('r','v','m','p','f')`, `attnum > 0`, `NOT attisdropped`. Group by relname en Rust.
- Timeout 8s con `pg_cancel_backend`-equivalent, mismo patrón que `list_structure`.
- `activity-log`: nuevo `ActivityKind::ListColumnsBulk`, metric `Items { value: total cols }`.
- Skip implícito: el comando NO se llama para `pg_*` ni `information_schema` (regla del frontend, no del backend — el comando funciona si se invoca, pero el caller no lo hace).

### Frontend (schema browser cache)

- **`globalSchemaCache.recordColumnsBulk(connectionId, schema, columnsByRelation)`** — nuevo método que ingesta el resultado del bulk. Internamente itera y poblar `columnsByRelation.get(schema)` con cada relation → columns. Notifica subscribers una sola vez al final.
- **`globalSchemaCache.getNamespace(connectionId): SQLNamespace`** — derivar la estructura `{ "<schema>": { "<relation>": [col, …] } }` que `lang-sql` consume. Excluye schemas system. Stable shape para que la equality check evite reconfigures innecesarios.
- **`useSchemaTree`** dispara `loadColumnsBulk(schema)` en background después de `relationsLoaded` exitoso. No-op para schemas system. Fire-and-forget — no bloquea ni al sidebar ni al usuario.

### Frontend (autocomplete redesign)

- **Eliminar `src/modules/postgres/sql/autocomplete.ts`** (`makeSchemaCompletion` y todo su regex). 
- **Nuevo `src/modules/postgres/sql/completionSources.ts`** que exporta:
  - Una fábrica que, dado el `connectionId`, retorna las **tres fuentes de completion** componiendo:
    - `keywordCompletionSource(PostgreSQL, true)` (de `lang-sql`).
    - `schemaCompletionSource({ dialect: PostgreSQL, schema: namespace })` (de `lang-sql`), donde `namespace` se construye desde `globalSchemaCache.getNamespace(connectionId)`.
    - `documentIdentifierSource` propio que usa `syntaxTree(state)` de `@codemirror/language` para extraer **aliases reales** (`FROM x AS alias`, `JOIN y alias`), **CTE names** (`WITH name AS (...)`, `WITH RECURSIVE`), y otros identificadores declarados en el documento — NO regex.
- **`QueryEditor`** consume las tres como una sola lista en `autocompletion({ override: [...] })`. Cuando el `globalSchemaCache` cambia, **reconfigure solo del compartimento de autocompletion** vía `Compartment.reconfigure(...)`, debounced 100ms para evitar thrash. El compartimento de `sql({ dialect })` queda estático — no se re-instancia, así no se rompe el syntax tree ni el highlight.
- **`QueryTab`** se subscribe a `globalSchemaCache` (el método `subscribe` que ya existe) y dispatch del effect `Compartment.reconfigure` al `EditorView` cuando el namespace cambia.

### Hint update

- El placeholder del result panel actualizado: `Press ⌘↩ to run · Tab to autocomplete (keywords, tables, columns, document idents)` — opcional. Mantenemos el corto si el render se ve apretado.

## Capabilities

### New Capabilities

- `postgres-columns-cache`: comando `postgres_list_columns_bulk`, ciclo de vida del bulk (trigger por schema visibility, error handling, cache shape), y los nuevos campos `default_value` / `comment` en el column info expuesto al frontend. Esto es funcionalidad nueva y específica que justifica su propia capability — no es un sub-detalle de `postgres-schema-browser` (cuya responsabilidad es navegar el catálogo) ni de `postgres-sql-editor` (cuyo dominio es el editor).

### Modified Capabilities

- `postgres-sql-editor`: el spec del editor SQL pasa de "completion source custom basado en regex" a "tres fuentes compuestas: keywords + schemaCompletionSource de lang-sql + documentIdentifierSource AST-aware. Reconfigure dinámico vía Compartment".
- `activity-log`: nuevo discriminante `list_columns_bulk` en `kind`, mapeado a `metric: { kind: "items", value: total cols }` en éxito.

## Impact

- **Backend**: nuevo módulo / sección en `src-tauri/src/modules/postgres/columns.rs` (o extender `schema.rs` — decidir durante implementación) con la query bulk y el comando. Registrar en `commands.rs` y `lib.rs::invoke_handler`. Tests unitarios mockeando rows.
- **Frontend**:
  - Nuevo `src/modules/postgres/sql/completionSources.ts` con la composición de tres fuentes y el namespace builder.
  - Eliminar `src/modules/postgres/sql/autocomplete.ts`.
  - Modificar `QueryEditor.tsx` para usar el compartimento de autocomplete y reconfigure on cache update.
  - Modificar `QueryTab.tsx` para subscribirse al cache y disparar reconfigure.
  - Modificar `useSchemaTree.ts` para disparar `loadColumnsBulk` después de `relationsLoaded`.
  - Modificar `globalSchemaCache.ts` para añadir `recordColumnsBulk` y `getNamespace`.
  - Nuevo command en `schemaApi.ts` (frontend wrapper del IPC).
- **Settings / persistencia**: ninguna nueva. La cache vive en memoria.
- **Atajos**: sin cambios.
- **Riesgos**:
  - Bulk fetch sobre schemas con miles de columnas (sucede en data warehouses) puede ser pesado. Mitigación: timeout 8s, cap implícito por la query SQL (no LIMIT, pero el shape es predecible). Si llega a ser un problema, V1.5 introduce LIMIT por relation.
  - `schemaCompletionSource` puede sugerir columnas de relations que el usuario no piensa usar, ruido. Mitigación: lang-sql ya hace FROM-scoping, así que solo sugiere columnas de las relations referenciadas en el FROM clause. Las "todas las tablas" se sugieren solo en el contexto FROM/JOIN.
  - Reconfigure del compartimento durante el typing puede causar lag o flicker. Mitigación: debounce 100ms; el sql() base no se reconfigura.
  - El AST de lang-sql puede no exponer cómodamente CTE names — el `syntaxTree` puede requerir un walker custom. Si la complejidad excede V1, hacer fallback a regex para esa parte específica y dejarlo documentado como follow-up.
- **Out of scope**:
  - Bulk fetch de funciones / argumentos para autocomplete de funciones.
  - Highlight de columnas inválidas in-line (linter).
  - Snippet completions (templates `INSERT INTO …`, `CREATE TABLE …`).
  - Cross-connection autocomplete.
  - Trigger explícito de bulk desde la palette (`Schema: Reload columns`).
