## Context

El schema browser actual (capability `postgres-schema-browser`, ya en master) usa un comando único `postgres_list_objects(id, schema)` que dispara `tokio::try_join!` con 6 queries de catálogo en paralelo sobre **un solo cliente**: `fetch_data` (pg_class), `list_functions` (pg_proc + pg_get_function_arguments por OID), `list_types`, `list_extensions`, `list_indexes` (pg_index sin filtro de tabla), `list_triggers` (pg_trigger + pg_get_function_arguments por OID). Hay un timeout total de 15s con `pg_cancel_backend` best-effort y un auto-retry frontend en SQLSTATE 57014.

**El síntoma**: el usuario reporta que con 11 schemas visibles, **siempre los mismos 4** nunca terminan de cargar. El patrón determinista descarta pool starvation y apunta a contenido pesado en alguna query — probablemente `pg_get_function_arguments` por OID en schemas con muchas funciones overloaded (típico Hasura/PostgREST), o `pg_index` sin filtro en schemas con tablas particionadas.

**El problema estructural**: `tokio::try_join!` cancela las 6 queries cuando una falla. Aunque 5 hubieran terminado en <1s, el usuario ve "Loading..." → "Slow — retrying..." → "Failed to load." sin ver ningún dato. Y la carga inicial paga el costo de queries que el usuario aún no necesita ver — los índices/triggers de cada tabla, las firmas de cada función — todo upfront.

**Constraints**:

- El módulo Postgres debe seguir autocontenido (`src-tauri/src/modules/postgres/`, `src/modules/postgres/`).
- Mantener consistencia con el patrón ya establecido por el schema browser actual: `tokio::time::timeout` + `pg_cancel_backend`, errores tipados (`AppError::Postgres { code: Some("57014") }`).
- El cache frontend sigue en memoria, no persistido. La invalidación cross-session vía palette `Schema: Refresh` ya existe.
- El árbol consume `SidebarTree`, que ya tiene callbacks `onExpand` por nodo — el lazy loading se monta encima sin tocar la primitiva del platform.

## Goals / Non-Goals

**Goals**:

- El árbol del schema queda visible/usable en <1s incluso para los 4 schemas patológicos (porque el initial load solo trae relations).
- Cuando el usuario expande `Structure` o una tabla, el grupo carga en su propio espacio sin bloquear el resto.
- Si una de las queries internas de un grupo falla por timeout, las demás del mismo fetch surfacean igual; el usuario ve "Functions: failed (Retry)" en lugar de un schema entero en error.
- Reducir la cantidad de queries internas por fetch a un máximo de 3 (en `postgres_list_structure`); el initial fetch (`postgres_list_relations`) ejecuta una sola query.
- Timeout individual por query: 8s. Timeout total por comando: 10s. Más estricto que los 15s actuales — viable porque cada comando es más chico.

**Non-Goals**:

- Cambiar `POOL_MAX_SIZE` o `RecyclingMethod`: con el rediseño la presión sobre el pool baja drásticamente. Si reaparece, lo abordamos en cambio aparte.
- Agregar timeout en `pools.acquire()`: misma lógica.
- Persistir el cache cross-session.
- Resolver la lentitud del data-grid (`row_to_json`, OFFSET deep): cambio aparte.
- Mostrar firmas de funciones eager en el árbol — la rebanada acepta que el árbol muestre solo nombres de funciones; el detalle se ve al activar el nodo.
- Backwards compatibility con `postgres_list_objects` — no hay consumers externos.

## Decisions

### 1. Tres comandos por-grupo en lugar de uno con `kinds: Vec<...>`

Splitting por comandos:

- `postgres_list_relations(id, schema) -> RelationsResult`
- `postgres_list_structure(id, schema) -> StructureResult`
- `postgres_list_table_extras(id, schema, relation) -> TableExtrasResult`
- `postgres_get_function_signature(id, schema, function_name, arg_types) -> FunctionSignature`

**Por qué**: Tipos de retorno fuertes y específicos por endpoint (ej. `RelationsResult` tiene exactamente `tables/views/materialized_views`, no `Option<...>` para grupos no pedidos). Los call-sites del frontend son auto-documentados. Las firmas de Tauri permiten al frontend tipar exacto vía `dataApi.listRelations(...)`. Mantenibilidad y testabilidad por encima de DRY.

**Alternativas descartadas**:

- *Un comando con `kinds: Vec<Kind>` y `Option<...>` por grupo*: tipo de retorno laxo, validación dinámica, peor TS inference.
- *Mantener `postgres_list_objects` y agregar params*: arrastra el bug del all-or-nothing y la query de funciones cara.

**Trade-off aceptado**: 4 endpoints en `tauri::generate_handler!` en lugar de 1. Es código de configuración trivial.

### 2. Partial-result envelope por comando

Cada comando que internamente corre múltiples queries retorna:

```rust
pub struct StructureResult {
    pub schema: String,
    pub functions: Option<Vec<FunctionInfo>>,
    pub types: Option<Vec<TypeInfo>>,
    pub extensions: Option<Vec<ExtensionInfo>>,
    pub failures: Vec<KindFailure>,  // empty when all loaded
}

pub struct KindFailure {
    pub kind: String,        // "functions" | "types" | "extensions"
    pub code: Option<String>, // SQLSTATE if Postgres error
    pub message: String,
}
```

`postgres_list_relations` sigue siendo monolítico (una sola query, sin partial-state) y retorna `RelationsResult { schema, tables, views, materialized_views }` directamente.

**Por qué**: El partial-result solo aporta cuando hay >1 query interna. Una sola query es éxito o error, sin caso parcial.

**Trade-off**: Inconsistencia visual entre los retornos de los comandos (`relations` no tiene `failures`, los demás sí). Aceptable: la asimetría refleja realidad estructural.

### 3. `tokio::join!` (no `try_join!`) con `Result` por query

Reemplazo dentro de cada comando multi-query:

```rust
let (functions_r, types_r, extensions_r) = tokio::join!(
    timeout(PER_QUERY, list_functions(&client, &schema)),
    timeout(PER_QUERY, list_types(&client, &schema)),
    timeout(PER_QUERY, list_extensions(&client, &schema)),
);
```

`functions_r: Result<AppResult<Vec<FunctionInfo>>, Elapsed>` — luego se "aplana" a `Some(vec)` o se acumula en `failures`. Un `pg_cancel_backend` se dispara solo si el timeout total del comando vence (no por query individual; el cliente está compartido y un cancel global aborta TODO el pipeline).

**Por qué**: La semántica de `try_join!` (todo se cancela si uno falla) es exactamente lo que queremos eliminar. `join!` espera a todos.

**Trade-off**: Si una query local cuelga >8s, su slot de pipeline queda esperando hasta el `PER_QUERY` timeout. El TOTAL_TIMEOUT (10s) está dimensionado un poco arriba del PER_QUERY para dejar margen al overhead de pipeline + decode.

### 4. Permission-denied sigue degradando a `Vec::new()` (no a `failures`)

El helper `try_kind` actual del schema.rs convierte SQLSTATE 42501 (insufficient_privilege) en `Ok(Vec::new())` con un `tracing::warn!`. Lo mantenemos.

**Por qué**: Permission-denied es estructural y permanente para esa sesión — un retry no lo cambia. Mostrarlo como "failed (Retry)" sería frustrante. Una lista vacía con explicación silenciosa en logs es lo correcto. Solo timeouts y errores transitorios entran al `failures` envelope.

### 5. Lazy loading granularity: schema → group → table

Niveles de carga:

```
1. Schema visible en sidebar (visibility picker)
   ↓ eager
2. postgres_list_relations  → tablas/vistas/matviews aparecen
   ↓ on-expand del grupo "Structure"
3. postgres_list_structure  → funciones/tipos/extensiones aparecen
   ↓ on-expand de una tabla
4. postgres_list_table_extras  → indexes/triggers de esa tabla
   ↓ on-activate de una función
5. postgres_get_function_signature  → para tooltip / pestaña detalle
```

**Por qué nivel 2 es eager**: la query es barata (un solo `pg_class` JOIN `pg_namespace`) y el usuario casi siempre quiere ver tablas. Lazy aquí degradaría la UX por un beneficio marginal.

**Por qué nivel 3 es lazy**: estos grupos son menos consultados. Si el usuario nunca expande `Structure`, nunca pagamos por funciones/tipos/extensiones.

**Por qué nivel 4 es per-table**: la query del schema entero traía cientos de índices que el usuario probablemente nunca ve. Per-table = una query con `WHERE relname = $2`, instantánea.

**Por qué nivel 5 es solo on-activate**: las firmas son texto largo, su único consumer es la tooltip o la pestaña detalle. No las traemos hasta que se necesitan.

### 6. Sin auto-retry en lazy fetches

Auto-retry SQLSTATE 57014 sobrevive solo en `postgres_list_relations`.

**Por qué**: Para el path eager (schema apenas se hace visible) el auto-retry es UX defensiva — el usuario no expandió nada activamente. Para los lazy fetches el usuario hizo un click consciente; si falla, le mostramos un botón explícito "Retry". Sin sorpresas de espera larga, sin telemetría confusa de retries duplicados.

### 7. Estado del frontend: `Map<schema, GroupCacheEntry>`

```ts
type GroupState<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "loaded"; payload: T; failures: KindFailure[] }
  | { state: "error"; error: AppError };

interface GroupCacheEntry {
  relations: GroupState<RelationsResult>;
  structure: GroupState<StructureResult>;
  tableExtras: Map<string /* table */, GroupState<TableExtrasResult>>;
}
```

El reducer `useSchemaTree.ts` actualiza la entrada de un solo grupo en `objectsLoading` / `objectsLoaded` / `objectsFailed`. La entrada del schema en el `Map` se crea perezosamente cuando se dispara el primer fetch.

**Por qué**: Estado por-grupo es lo que la UX exige (un grupo en error sin afectar otros). El `Map<schema, ...>` se mantiene como nivel superior para que el `Schema: Refresh` pueda invalidar todo el connection en una operación.

### 8. UI: render por-grupo con placeholder propio

Cada grupo tiene un placeholder que refleja **su** estado:

- `Data` (relations): `Loading…` / lista de items / `Failed to load. (Retry)` (con auto-retry interno antes).
- `Structure` (lazy): `(expand to load)` cuando idle / `Loading…` / lista parcial con `Functions failed (retry)` inline si hay failures / `Failed (Retry)` si todo el comando falló.
- Per-table indexes/triggers: idénticamente lazy.

El nodo del schema mismo deja de tener un estado global. Si el usuario quiere refrescar todo el schema, hay un menú "Refresh schema" en el contexto del nodo (no parte de esta rebanada — sigue siendo `Schema: Refresh` palette en V1).

### 9. Eager `postgres_list_relations` para todos los visible schemas

El comportamiento del `useEffect` actual (`SchemaTree.tsx:379-384` en master) se mantiene en espíritu: cuando un schema aparece en `visibility.visible`, se dispara su `relations` fetch. Antes era `getObjects`; ahora es `getRelations`.

**Por qué**: el costo es bajo (una query de `pg_class`) y el usuario siempre va a ver tablas. La UX de "el sidebar tarda en mostrar tablas" sería peor que la del estado actual.

**Pool**: con max=4, hasta 4 schemas en paralelo. Los demás esperan en `pool.get()`. Como cada `relations` debería tomar <1s, la cascada termina rápida y no hay pressure visible. Si aparece dolor, lo abordamos por separado (no scope).

### 10. Función `pg_get_function_arguments` se usa solo en signature getter

`SQL_LIST_FUNCTIONS` deja de incluir `pg_get_function_arguments(p.oid)` y `pg_get_function_result(p.oid)`. La query nueva trae solo `proname`, `oid`, `lanname`, `description`. La firma se construye lazy con `postgres_get_function_signature(id, schema, name, arg_types)` cuando el usuario hace hover sobre el nodo de la función o abre su pestaña.

**Por qué**: estas dos llamadas son las queries-veneno principales. En schemas con cientos de overloaded functions (típicos en codebases generados), el cost-per-row es alto. Diferirlas a click-time es el cambio que más mueve la aguja de performance.

**Trade-off**: el árbol pierde la capacidad de mostrar la firma como label del nodo. La función `f(int)` y `f(text)` aparecerían como dos nodos `f`. Para mantener identidad única, el `id` del nodo incluye el `oid`. La UI muestra un sufijo discreto cuando hay overloads (e.g. `f`, `f (#2)` o un mini-badge `2 overloads`). Decisión de UX a refinar al implementar.

## Risks / Trade-offs

**[Riesgo]** Schemas con miles de tablas: `postgres_list_relations` se vuelve la query lenta. → **Mitigación**: la query actual ya escala razonablemente porque `pg_class` JOIN `pg_namespace` con índices sobre `nspname` tiene plan rápido (<500ms para 10k relations). Si aparece dolor, se puede paginar la lista en el futuro. No es problema de esta rebanada.

**[Riesgo]** El usuario espera ver firmas de funciones inline en el árbol y pierde esa info. → **Mitigación**: el nodo muestra un badge de overload cuando hay >1 función con el mismo nombre, y la pestaña de la función muestra firma completa. Es regresión visual aceptable comparada con que los 4 schemas no carguen para nada.

**[Riesgo]** Per-table `list_table_extras` multiplica round-trips si el usuario expande muchas tablas. → **Mitigación**: cada query individual es muy barata (filtro `relname = $2`); el cache mantiene los resultados; en la práctica el usuario expande pocas tablas por sesión. La alternativa (fetch en bulk al cargar el schema) es justo lo que estamos quitando por las razones que motivan este cambio.

**[Riesgo]** Cambiar los IPC commands rompe handlers internos no detectados. → **Mitigación**: el `tauri::generate_handler!` macro falla en compile-time si se referencia un comando inexistente. Grep por `postgres_list_objects` localizará call-sites antes del cambio.

**[Riesgo]** Auto-retry quitado en lazy fetches degrada UX en redes flaky. → **Mitigación**: el botón Retry inline está siempre visible cuando hay failure. Recovery toma 1 click en lugar de espera ciega de 30s. Es mejor UX, no peor.

**[Trade-off]** Performance del initial-load mejora, pero el costo total acumulado (relations + structure + per-table) puede ser ligeramente mayor que el bulk actual cuando el usuario expande TODO. **Aceptado**: el caso "expandir todo" es raro; el caso "ver una tabla" es constante. Optimizamos por lo común.

## Migration Plan

1. Implementar los 4 nuevos comandos en backend + tipos compartidos. Tests unitarios en `schema.rs` se reescriben.
2. Implementar el reducer + state machine nuevos en frontend. Mantener `useSchemaTree` como punto de entrada (la API pública del hook para `SchemaTree.tsx` se mantiene parcialmente compatible: cambia de `getObjects(schema)` a `getRelations(schema)` + helpers para los demás grupos).
3. Refactorizar `SchemaTree.tsx` para invocar los lazy fetches en `onExpand`. La `SidebarTree` primitive ya soporta eso vía la prop `onToggle`.
4. Eliminar `postgres_list_objects` del backend, frontend, y `tauri::generate_handler!`. Borrar `runFetch` + reducer state legacy.
5. Validar live contra los 4 schemas problemáticos: confirmar que cargan instantáneo y que `Structure` carga con failures parciales (functions failed, types/extensions ok) si la query de funciones es la lenta.

**Rollback**: `git revert` directo. No hay state persistido nuevo, no hay schema migration en SQLite, ningún consumer externo.

## Open Questions

- **¿Cómo se identifica un nodo de función overloaded en el árbol?** Opciones: (a) un nodo por OID con label `name` y un badge contador en el primero; (b) un solo nodo `name` con drill-down a un sub-árbol "Overloads"; (c) label con sufijo `(#N)`. Decisión a tomar al implementar la UI; no bloquea la propuesta.
- **¿Hay que exponer el botón "Refresh group" en cada grupo?** El `Schema: Refresh` palette ya cubre el flujo. Para esta rebanada, el botón Retry de un grupo en error invalida solo ese grupo y re-fetch — equivalente práctico a un refresh manual. Si surge demanda, se agrega después.
