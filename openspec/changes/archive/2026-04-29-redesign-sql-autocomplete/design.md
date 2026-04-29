## Context

El editor SQL hoy monta su autocomplete así:

```ts
// QueryEditor.tsx
const completionExtension = completionSource
  ? autocompletion({ override: [completionSource] })   // ← REEMPLAZA todas las fuentes
  : autocompletion();
```

donde `completionSource = makeSchemaCompletion(connectionId)` (en `sql/autocomplete.ts`).

Esa fuente custom usa regex (`matchBefore(/[A-Za-z_."`]+$/)`) y heurísticas posicionales (`lastKeywordContext`, `lastReferencedRelation`). Tiene tres branches mutuamente excluyentes (`<schema>.`, `FROM/JOIN`, `columns`) y siempre retorna `null` fuera de esos casos.

Los problemas observados:
- Greedy match incluye `.`: tipear `public.us` produce `before.text = "public.us"`. Filter fuzzy de CM compara contra labels `"public.users"`, `"analytics.events"`, etc. Solo `public.users` hace match prefix-fuerte; el resto cae fuera. **Aparece una sola sugerencia.**
- `override` quita los keywords del SQL — el usuario nunca ve `SELECT`, `WHERE`, etc.
- Identificadores con dígitos rompen.
- No hay alias-aware (`SELECT u.id FROM users u`), no hay CTE-aware.

Mientras tanto, `@codemirror/lang-sql` exporta:
```ts
keywordCompletionSource(dialect: SQLDialect, upperCase?: boolean): CompletionSource
schemaCompletionSource(config: { schema: SQLNamespace, dialect, … }): CompletionSource
```

`schemaCompletionSource` usa el parser real del lenguaje y maneja:
- `<schema>.<partial>` con anclaje correcto del `from`.
- alias resolution (`FROM users u` → `u.` ofrece columnas de users).
- CTE introspection (`WITH name AS (…)` → `name` aparece como tabla).
- Default schema (`defaultSchema: "public"` → tablas de public sin qualifier).

`SQLNamespace` shape:
```ts
type SQLNamespace =
  | { [name: string]: SQLNamespace }
  | { self: Completion; children: SQLNamespace }
  | readonly (Completion | string)[];
```

Caso típico que vamos a usar: `{ "public": { "users": [Completion, …], "orders": [...] }, "analytics": { … } }`.

Las hojas pueden ser `string` o `Completion` ricos con `{ label, type, detail, info }`. Vamos a usar el shape rico para mostrar `data_type` en el detail.

**Constraints**:
- No regresiones de syntax highlighting / indent / comment toggle. Eso vive en `sql({ dialect })` y no se debe reconfigurar.
- Reconfigures del compartimento deben ser baratos — debounce y stable namespace shape.
- Bulk fetch no debe bloquear nada que el usuario hace (sidebar, viewer, run).
- Skip `pg_*` y `information_schema` por defecto del bulk — ahorrarse ~10k columnas que nadie autocompleta.

## Goals / Non-Goals

**Goals**:
- Eliminar `makeSchemaCompletion` y todo su regex.
- Componer tres fuentes (`keyword + schema + docIdent`) vía `autocompletion({ override: [...] })`.
- Pre-cargar columnas en bulk por schema en background, alimentando un namespace global.
- Reconfigurar el autocomplete de forma reactiva cuando el cache crece, sin recrear el lang.
- Document-identifier source debe ser AST-driven (no regex), reconociendo CTEs, aliases declarados, table refs.
- Backend: comando `postgres_list_columns_bulk` con info adicional (defaults, comments) para tooltips ricos.

**Non-Goals**:
- Snippets completions (templates `INSERT INTO …`).
- Linter / column-validity highlighting.
- Bulk fetch de signatures de funciones para autocomplete de funciones.
- Pre-cargar cross-connection.
- Cancel / cancelar el bulk por user gesture.
- Persistir el namespace entre sesiones.

## Decisions

### 1. Componer tres fuentes con `override`

```ts
import { keywordCompletionSource, schemaCompletionSource, sql, PostgreSQL } from "@codemirror/lang-sql";
import { autocompletion } from "@codemirror/autocomplete";

const sources: CompletionSource[] = [
  keywordCompletionSource(PostgreSQL, /*upperCase=*/ true),
  schemaCompletionSource({ dialect: PostgreSQL, schema: currentNamespace }),
  documentIdentifierSource,  // AST-driven, propio
];

autocompletion({
  override: sources,
  // defaults: activateOnTyping: true, maxRenderedOptions: 100, …
});
```

Las tres fuentes corren en paralelo y CM merge sus resultados. Cada una declara su `from` correcto, así el filter funciona.

**Por qué `override` y no añadir vía language data**: queremos control explícito de las tres fuentes. `sql({ schema: … })` también funcionaría (auto-añade keyword + schema source) pero perderíamos la posibilidad de añadir el documentIdentifierSource sin perder los otros. Con `override` lo tenemos en una sola lista y reconfigurar es trivial.

**Trade-off**: si en el futuro queremos añadir source extras (snippets), va en la misma lista — no es un problema.

### 2. Reconfigure dinámico vía Compartment

El editor mantiene **dos compartimentos**:
- `langCompartment` con `sql({ dialect: PostgreSQL })` — **estático**. Nunca se reconfigura.
- `autocompleteCompartment` con `autocompletion({ override: [...] })` — **dinámico**. Se reconfigura cuando el namespace cambia.

```ts
// QueryTab.tsx
useEffect(() => {
  const unsubscribe = globalSchemaCache.subscribe(() => {
    scheduleReconfigure();  // debounced 100ms
  });
  return unsubscribe;
}, [...]);

function reconfigure() {
  const ns = globalSchemaCache.getNamespace(connectionId);
  if (sameNamespace(ns, lastNs)) return;  // shape equality skip
  lastNs = ns;
  view.dispatch({
    effects: autocompleteCompartment.reconfigure(buildAutocomplete(ns)),
  });
}
```

**Por qué dos compartimentos**: el `sql({ dialect })` lleva consigo el parser, syntax highlighting y configuración del lenguaje. Reconfigurarlo dispara un re-parse del documento entero — flicker y costo. Reconfigurar SOLO el autocompletion es barato.

**Equality check de namespace**: comparamos las llaves top-level del schema y, para cada schema, las llaves de relations. Si nada cambió, no dispatch. Esto evita reconfigures cuando el subscribe notifica por una columna recordada que no afecta el namespace agrupado (ej. cache de columnas para un viewer abierto antes).

### 3. Document identifier source — AST-driven via `syntaxTree`

`@codemirror/language` expone `syntaxTree(state): Tree`. El parser de `lang-sql` etiqueta nodes con tipos como `Statement`, `CommonTableExpression`, `Identifier`, `Definer` (alias), etc. Walk del árbol para extraer:

- **Alias declarados**: nodes en `Statement` donde el padre es un `FromClause` o `JoinClause` y la sintaxis es `<table> [AS] <alias>`. El alias se extrae del nodo identifier que sigue al table ref.
- **CTE names**: nodes `CommonTableExpression` (o el nombre que use el parser de Postgres dialect) — el primer identifier es el name.
- **Table refs**: `Identifier` que aparecen en `FromClause` (sin alias) — los nombres de tablas usadas, útiles aunque ya estén en el namespace porque permite completar antes de que el bulk fetch caiga.

```ts
function documentIdentifierSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/\w*/);
  if (!word) return null;
  if (word.from === word.to && !context.explicit) return null;

  const tree = syntaxTree(context.state);
  const idents = collectDocumentIdents(tree, context.state.doc);

  return {
    from: word.from,
    options: idents.map((id) => ({ label: id.name, type: id.type, detail: id.detail })),
    validFor: /^\w*$/,
  };
}
```

`collectDocumentIdents`:
1. Walk `tree.cursor()`.
2. Identifica nodes `CommonTableExpression` → name → push como `type: "class", detail: "CTE"`.
3. Identifica nodes en `FromClause` / `JoinClause` con alias → push como `type: "variable", detail: "alias of <table>"`.
4. Dedupe por nombre, preserva el primero.

**Riesgo**: el parser de lang-sql puede no exponer estos nombres directamente; los node types pueden variar entre dialectos. Mitigación durante implementación: imprimir el árbol para una query de ejemplo y ajustar. Si el AST está demasiado opaco, V1 fallback es **un walker que filtra Identifier nodes que estén dentro de un nodo padre con tipo conteniendo "From" o "Cte"**, sin caer a regex puro.

**Por qué no regex**: las decisiones del usuario eligieron AST-rico. Regex pierde con strings, comentarios, dollar-quoted bodies, palabras reservadas — todo lo que el parser ya resuelve.

### 4. Backend bulk: shape + query

```rust
#[derive(Debug, Serialize)]
pub struct BulkColumnInfo {
    pub name: String,
    pub data_type: String,
    pub ordinal_position: i32,
    pub is_nullable: bool,
    pub default_value: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ColumnsBulkResult {
    pub schema: String,
    pub columns_by_relation: BTreeMap<String, Vec<BulkColumnInfo>>,
}
```

Query SQL (una sola, devuelve flat rows; group en Rust):
```sql
SELECT
    c.relname,
    a.attname,
    pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
    a.attnum::int4 AS ordinal_position,
    NOT a.attnotnull AS is_nullable,
    pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value,
    pg_catalog.col_description(c.oid, a.attnum) AS comment
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_attrdef d
    ON d.adrelid = c.oid AND d.adnum = a.attnum
WHERE n.nspname = $1
  AND c.relkind IN ('r','v','m','p','f')
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY c.relname, a.attnum;
```

- **Una query**: minimiza round-trips. Group by `relname` en Rust (`BTreeMap<String, Vec<...>>`), preserva `attnum` order para `ORDER BY` lexicográfico no-roto.
- **Timeout 8s**, mismo patrón que `list_structure` con `pg_cancel_backend` en expiración.
- **Activity-log**: `kind: "list_columns_bulk"`, `origin: "auto"` (es background-fetch, no user-driven), `metric: { kind: "items", value: <total cols> }` on success.

### 5. Trigger del bulk: dentro de `useSchemaTree`

Después de `dispatch({ type: "relationsLoaded", schema, payload })`:

```ts
if (!isSystemSchema(schema)) {
  void runFetchColumnsBulk(schema);   // fire-and-forget
}
```

`runFetchColumnsBulk` es **idempotente**: si la cache global ya tiene columns para ese schema, no fetch. Si está in-flight, no fetch (track con un Set in-mem).

Reglas:
- `isSystemSchema(name)`: `name === "information_schema"` o `name.startsWith("pg_")`.
- Si la `relations` falla, no se dispara el bulk (depende de relations exitoso).
- Si el bulk falla, log warn, set un flag de "bulk error" en la cache para no reintentar automáticamente. El usuario puede invalidar el schema (refresh palette) para reintentar.

### 6. Cache extension: `recordColumnsBulk` + `getNamespace`

```ts
globalSchemaCache.recordColumnsBulk(connectionId, schema, columnsByRelation: Map<string, BulkColumnInfo[]>) {
  // populate columnsByRelation map; one mutation, one notify.
}

globalSchemaCache.getNamespace(connectionId): SQLNamespace {
  const out: Record<string, Record<string, Completion[]>> = {};
  for (const [schemaName, relMap] of cache[connectionId].columnsByRelation) {
    if (isSystemSchema(schemaName)) continue;
    out[schemaName] = {};
    for (const [relName, cols] of relMap) {
      out[schemaName][relName] = cols.map((c) => ({
        label: c.name,
        type: "property",
        detail: c.data_type,
        info: c.comment ?? undefined,  // CodeMirror muestra `info` en panel lateral
      }));
    }
  }
  return out;
}
```

**Equality check** (para evitar reconfigure innecesario): hash de "schema-name → relation-names" stringified. Si el hash es igual, skip.

### 7. Hint del result panel

Mantenemos `Press ⌘↩ to run · Tab to autocomplete`. El cambio interno no requiere actualización del hint (es la misma promesa, mejor cumplida).

## Risks / Trade-offs

- **Bulk fetch pesado en data warehouses** → mitigación: timeout 8s, error es no-bloqueante, fallback a keywords + idents. Si recurrente, V1.5 puede agregar paginación o filtrar por pattern.
- **`schemaCompletionSource` esperaba un namespace estable** → el reconfigure dinámico está soportado por el flujo de Compartment, pero confirmamos durante implementación que el source no cachea internamente el namespace de forma que requiera re-instanciar. Si lo hace, instanciar nuevo `schemaCompletionSource({ schema })` es barato (es solo una closure sobre el config).
- **AST walker para CTEs / aliases puede ser frágil** → los node types del parser SQL pueden cambiar entre versiones. Mitigación: walker defensivo (chequeos `node.type.name`) y tests con queries representativas. Si node types no cooperan, fallback a regex para esa pieza específica y dejar TODO.
- **Conflicto entre keywordCompletionSource y schemaCompletionSource para identifiers que son keywords reservados** (ej. una tabla llamada `order`) → cada source declara su `from` correcto y se merge. Los keywords aparecen como type="keyword", la tabla como type="class". Se distinguen visualmente.
- **Doc-ident source duplica entries del schema source** (ej. CTE name + table real con mismo nombre) → CodeMirror dedupe por label automáticamente cuando los detalles coinciden; si no, el usuario ve dos rows distintas, lo cual es informativo. Aceptable.
- **Pre-cargar todos los schemas visibles puede penalizar startups en BDs con 50+ schemas visibles** → la default visible-schemas excluye system schemas. Si la cuenta sigue siendo alta, V1 mantiene fire-and-forget paralelo (limitado por pool max=4 → 4 en paralelo, el resto encola); si llega a ser un dolor, V1.5 introduce un máximo de bulk fetches concurrentes.
- **Reconfigure del autocomplete durante typing** → debounce 100ms basta. Si hay reportes de lag, subir a 200ms o sólo reconfigurar cuando el editor está idle.

## Migration Plan

Cambio aditivo + sustitutivo en frontend; aditivo en backend. Pasos:

1. **Backend**:
   - Crear `src-tauri/src/modules/postgres/columns.rs` con la query bulk + comando `postgres_list_columns_bulk`.
   - Extender `ActivityKind` con `ListColumnsBulk`. Tests del builder de query (no live tests).
   - Registrar el comando en `commands.rs` y `lib.rs`.
2. **Frontend cache**:
   - Extender `globalSchemaCache.ts` con `recordColumnsBulk`, `getNamespace`, `isSystemSchema` helper, e in-flight tracker.
   - `schemaApi.ts` (frontend wrapper): añadir `listColumnsBulk(connectionId, schema, origin?)`.
3. **Frontend autocomplete**:
   - Crear `src/modules/postgres/sql/completionSources.ts`:
     - `buildSchemaCompletionFromCache(connectionId)` — retorna `CompletionSource`.
     - `documentIdentifierSource` — usa `syntaxTree`.
     - `composeCompletionSources(connectionId): CompletionSource[]` — array con las tres.
   - Eliminar `src/modules/postgres/sql/autocomplete.ts`.
4. **Editor**:
   - Modificar `QueryEditor.tsx`:
     - Reemplazar la prop `completionSource` por algo que el componente derive del `connectionId` directamente, o pasar `connectionId` y construir las sources internamente.
     - Mantener el `Compartment` para autocomplete; el `lang-sql` queda en otro compartment (estático).
   - Modificar `QueryTab.tsx`:
     - Subscribirse a `globalSchemaCache`.
     - On change, debounced 100ms, dispatch `Compartment.reconfigure` con las sources nuevas.
5. **Schema tree trigger**:
   - Modificar `useSchemaTree.runFetchRelations` para disparar `loadColumnsBulk(schema)` en background tras `relationsLoaded`. Skip system schemas.
6. **QA**:
   - `pnpm typecheck` + `pnpm build`.
   - `cargo build` + `cargo test --lib`.
   - Manual contra una BD: tipear `SEL` → SELECT aparece. `SELECT * FROM ` → tablas. `SELECT u.` con `FROM users u` → cols de users. `WITH x AS (SELECT 1) SELECT * FROM x` → x aparece como CTE.

**Rollback**: revertir el commit. El comando bulk queda registrado pero sin caller; sin efecto.

## Open Questions

- **¿Boost para document idents sobre keywords y schema?** Probablemente sí — cuando el usuario tipea `u`, su alias `u` debería ser top-1 sobre `UPDATE`. CM6 lets us assign `boost` per Completion. V1 default: aliases / CTEs con boost +1, keywords sin boost.
- **¿Mostrar `comment` en el `info` panel del popup?** Sí, por defecto. Si el comment está vacío, el panel no aparece.
- **¿Refresh manual del bulk?** No por palette en V1. `Schema: Refresh` ya invalida toda la cache de la conexión y el bulk se vuelve a disparar al re-cargar relations. Suficiente.
- **¿Cap de cols por schema?** No por ahora. Si llega un usuario con un schema de 50k columnas, abrimos un follow-up.
- **¿Persistir el namespace entre sesiones?** No. Los catálogos cambian; mejor revalidar al conectar.
