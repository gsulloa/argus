# Argus — Roadmap DynamoDB (V2)

Plan detallado de los `change` que conforman la V2.1: soporte para DynamoDB. Misma tesis que el roadmap V1: cada change es una rebanada vertical funcional, **nada toca el módulo Postgres**, todo nuevo aterriza en `src/modules/dynamo/` y `src-tauri/src/modules/dynamo/`. Este es el primer paso real de Argus hacia ser multi-source: si la abstracción se cuela donde no debe (es decir, si para soportar Dynamo terminas modificando Postgres), para, repensa, y ajusta `connection-registry` o `app-shell` en lugar de mezclar dominios.

---

## V2.1 — DynamoDB

```
9.  add-dynamo-connection         ⏳  AWS credential chain, perfil/región/endpoint
10. browse-dynamo-tables          ⏳  lista de tablas + describe (KeySchema, GSIs, LSIs)
11. view-dynamo-items             ⏳  scan/query, vistas Tabla/JSON, paginación
                                       por LastEvaluatedKey, query builder simple
12. edit-dynamo-items             ⏳  put/update/delete atómicos, sin diff multi-row,
                                       optimistic locking opcional
13. run-partiql                   ⏳  editor PartiQL, autocomplete tablas/atributos,
                                       resultados Tabla/JSON, paginación NextToken
```

Después del #12 ya tienes una herramienta utilizable para reemplazar NoSQL Workbench / la consola AWS en tu uso diario. El #13 es el pulido para usuarios que viven en queries.

---

## Decisiones transversales

Antes de partir los changes, estas decisiones aplican a todo el módulo Dynamo. Cualquier change que las contradiga es señal de mala factorización.

### Credenciales

Dos formas soportadas, escogibles desde el form de conexión:

1. **Access keys**: form simple con `aws_access_key_id`, `aws_secret_access_key`, y `aws_session_token` opcional (para credenciales STS de duración limitada, p.ej. salidas de `aws sts assume-role` o de un broker corporativo). Se guardan en keychain (servicio `argus`, account `connection:<id>`) reusando el cache de keychain en proceso ya implementado.
2. **AWS profile (incluye SSO local)**: lee `~/.aws/credentials` y `~/.aws/config`, presenta dropdown con los profiles encontrados. Si el profile tiene `sso_session` o `sso_start_url`, el SDK resuelve credenciales contra el cache local (`~/.aws/sso/cache/*.json`) que ya mantiene `aws sso login` — no reimplementamos SSO. Almacenamos solo el `profile name` en `params`; las credenciales nunca pasan por keychain en este modo (las resuelve el SDK al vuelo).

**Re-prompt en token expirado (modo Access keys con session token)**: si una operación falla con `ExpiredToken` / `ExpiredTokenException` / `InvalidClientTokenId` por session token vencido, marcamos la conexión como `needs_credentials`, mostramos un toast accionable ("Session token expired — re-enter credentials"), y abrimos automáticamente el mismo dialog de edición de credenciales con los campos `access_key_id`/`secret_access_key` precargados desde keychain y `session_token` vacío y focuseado. Al guardar, las nuevas credenciales reemplazan las viejas en keychain y la conexión se reintenta sola; las pestañas abiertas conservan su estado. En **modo Profile con SSO** este flujo no aplica: si el cache SSO expiró, mostramos un error accionable con el comando exacto (`aws sso login --profile <name>`) — no podemos refrescarlo desde la app sin abrir un browser.

No soportamos credential helpers custom ni `credential_process` en V2.1. Si llegan a hacer falta, change separado.

### Región

Campo dedicado y obligatorio en `params`, **no derivada del profile**. Un mismo profile puede usarse contra varias regiones; forzar al usuario a duplicar profiles en `~/.aws/config` para cambiar región es UX de ingeniero, no de producto. Dropdown completo (lista estática de regiones AWS publicadas, refrescable cuando salgan nuevas).

### Endpoint custom

Campo opcional `endpoint_url` (texto libre). Casos: DynamoDB Local (`http://localhost:8000`), LocalStack (`http://localhost:4566`), VPC endpoints, mocks de testing. Si está seteado, se pasa al SDK builder y se desactiva la validación TLS estricta solo cuando el host es `localhost`/`127.0.0.1`.

### SDK Rust

`aws-sdk-dynamodb` oficial, fijado a la versión estable más reciente al momento de implementar #9 (al menos `1.x`). También `aws-sdk-sts` para `GetCallerIdentity` en el test connection y `aws-config` para resolver profiles. Versionado pinneado en `Cargo.toml`.

### Read-only

Igual que Postgres: flag `read_only: bool` por conexión. UI deshabilita botones de edición; backend rechaza `putItem`, `updateItem`, `deleteItem`, `executePartiQL` con statements no-SELECT. Defensa en profundidad — no se confía solo en el frontend.

### Modelo mental UI

Dynamo no tiene schemas. La jerarquía del sidebar es plana:

```
└─ Connection (region, account)
   └─ Tables
      ├─ table-foo
      ├─ table-bar
      └─ ...
```

No hay equivalente al picker de schemas de Postgres. La región y el account ID se muestran como subtítulo de la conexión (igual que `db_name@host` en Postgres).

### Items heterogéneos

Cada item de una tabla puede tener atributos distintos. La UI ofrece dos modos siempre:

- **Tabla**: columnas inferidas. Algoritmo: PK y SK (si existe) primero; luego top-N atributos ordenados por frecuencia de aparición en el sample cargado; columna final "More…" que abre el item completo. Tipos primitivos se renderizan inline, tipos complejos (`L`, `M`, `B`, `SS`, `NS`, `BS`) muestran un resumen tipo `[3 items]` y se expanden en el panel lateral.
- **JSON**: cada item como bloque JSON pretty-printed con CodeMirror read-only. Ideal cuando el shape varía mucho.

Toggle en la barra superior persiste por tabla (`settings` key `dynamoView:<connectionId>:<table>`).

### Consistencia

Todas las lecturas (`Scan`, `Query`, `GetItem`) por default son **eventualmente consistentes** (más baratas, más rápidas). Toggle visible "Consistent read" por query/scan. PartiQL acepta el mismo toggle.

### Sin transacciones generalizadas

Dynamo tiene `TransactWriteItems` pero está limitado a 100 ops y misma región/cuenta. Para V2.1 no replicamos el "diff preview + commit" de Postgres: cada `put`/`update`/`delete` es atómica e independiente, y se commitea sola con confirmación explícita por operación destructiva. Si en la práctica el usuario pide multi-op transaccional, hay un crossroads (`dynamo-batch-operations`) que cubre `BatchWriteItem`. `TransactWriteItems` se difiere hasta que haya un caso de uso real.

---

### 9. `add-dynamo-connection` ⏳

**Meta**: Crear/editar/borrar conexiones reales de DynamoDB con AWS profile, SSO, o access keys; test sincrónico via STS; toggle read-only.
**Capacidades nuevas**: `dynamo-connection` (módulo Dynamo en `src/modules/dynamo/` y `src-tauri/src/modules/dynamo/`).
**Capacidades modificadas**: `connection-registry` (acepta `kind: "dynamodb"` con params específicos validados).
**Depende de**: 8 (V1 cerrado, no toca código Postgres).
**Incluye**:

- Form con dos modos exclusivos (radio en la parte superior):
  - **Access keys**: inputs `aws_access_key_id`, `aws_secret_access_key`, `aws_session_token` opcional. Validación: keys con formato esperado (`AKIA…` / `ASIA…` para session tokens). Hint en el form: "Si pegas un session token, las credenciales tienen una duración limitada — Argus te re-pedirá las nuevas cuando expiren".
  - **AWS profile**: dropdown con profiles leídos en runtime de `~/.aws/credentials` y `~/.aws/config` (comando `dynamo.listAwsProfiles() -> { name, sso: bool, region?: string }[]`). Si el profile elegido tiene `sso_session` / `sso_start_url`, badge "SSO" inline + texto auxiliar "Requiere `aws sso login --profile <name>` activo en tu terminal".
- Campo región: dropdown completo de regiones AWS, obligatorio. Si el profile trae región default, se pre-rellena pero se puede sobrescribir.
- Campo endpoint custom: opcional, validado como URL bien formada.
- Toggle `read_only: bool`.
- Comando `dynamo.testConnection(params, secret) -> { latencyMs, identityArn, accountId, region }` que arma un cliente STS efímero, ejecuta `GetCallerIdentity`, mide latencia, devuelve el ARN y account ID. Errores diferenciados:
  - `ExpiredToken` / `ExpiredTokenException` (modo access keys con session token): mensaje "Session token expired" + botón "Re-enter credentials" que abre el editor con los campos precargados (ver decisión transversal de re-prompt).
  - SSO expirado (modo profile): mensaje accionable con el comando exacto `aws sso login --profile <name>` y botón "Copy command".
  - Resto: mensaje de error crudo del SDK con código de error visible.
- Comandos `dynamo.connect(id)` / `dynamo.disconnect(id)` que mantienen un cliente `aws-sdk-dynamodb` cacheado por conexión activa (igual patrón que `pool.rs` en Postgres pero con SDK client).
- Comando `dynamo.updateCredentials(connectionId, { aws_access_key_id, aws_secret_access_key, aws_session_token? })` que reemplaza el secret en keychain, invalida el cliente cacheado y limpia el flag `needs_credentials`. Usado por el flujo de re-prompt.
- Detector de expiración en runtime: cualquier comando Dynamo que retorne `ExpiredToken*` en modo access keys con session token dispara el flujo de re-prompt (toast + dialog precargado). Pestañas abiertas mantienen su estado; al guardar nuevas credenciales se reintenta la operación que falló.
- UI: dialog desde el "+" del sidebar reusando los primitivos del form Postgres; estados loading/error/success en el test. El mismo dialog se reusa para el re-prompt (modo "edit credentials only" oculta los demás campos).
- Persistencia: `params` JSON con `{ auth: "access_keys" | "profile", profile?, region, endpoint_url?, read_only, needs_credentials?: bool }`. Access keys (incluido session token) en keychain como JSON `{ access_key_id, secret_access_key, session_token? }`.
- Validaciones: región en lista válida, profile existe (si auth=profile), endpoint URL bien formada, read_only siempre explícito, access keys no vacías cuando auth=access_keys.

**Out of scope**: refrescar SSO desde la app (abrir browser y completar device flow), asume role manual (`role_arn` chaining), MFA prompts interactivos, credential helpers custom (`credential_process`), auto-refresh de session tokens vía broker externo.

---

### 10. `browse-dynamo-tables` ⏳

**Meta**: Sidebar muestra tablas bajo cada conexión Dynamo con búsqueda local; describe completo (KeySchema, GSIs, LSIs, billing, streams) accesible al click.
**Capacidades nuevas**: `dynamo-table-browser`.
**Capacidades modificadas**: `app-shell` (sidebar admite jerarquía plana sin nivel "schema" para conexiones de tipo dynamodb).
**Depende de**: 9.
**Incluye**:

- Comando `dynamo.listTables(connectionId, { paginationToken? }) -> { tables: string[], nextToken?: string }` paginado a 100 por request (límite del API). Concatenamos hasta llenar la lista o hasta cap configurable (default 1000).
- Comando `dynamo.describeTable(connectionId, tableName) -> TableDescription` con: `KeySchema`, `AttributeDefinitions`, `GlobalSecondaryIndexes`, `LocalSecondaryIndexes`, `ItemCount`, `TableSizeBytes`, `BillingMode` (`PROVISIONED` | `PAY_PER_REQUEST`), `StreamSpecification`, `TableStatus`, `CreationDateTime`.
- UI: árbol bajo conexión, sin nivel "schema". Search box local que filtra por nombre (no llama al API por cada tecla).
- Click en tabla: abre pestaña placeholder en el área central — el viewer real vive en #11.
- Indicadores en sidebar: ícono de tabla con badge si tiene streams activos, badge `on-demand` vs `provisioned`, badge `GSI×N` si tiene índices secundarios.
- Cache en memoria del describe por conexión, invalidable con un botón refresh por conexión y automáticamente tras una operación DDL futura (no aplica en V2.1).
- Atajo: `⌘K` filtra tablas vía la paleta global (`Tables: <query>`).

**Out of scope**: editar la estructura de la tabla (DDL), borrar tablas, ver métricas de CloudWatch. `dynamo-create-table` y `dynamo-table-metrics` son crossroads.

---

### 11. `view-dynamo-items` ⏳

**Meta**: Click en una tabla → vista de items con dos modos (Tabla/JSON), scan/query con paginación incremental, query builder simple sin DSL, panel inspector lateral.
**Capacidades nuevas**: `dynamo-data-view`.
**Capacidades modificadas**: `dynamo-table-browser` (la pestaña placeholder ahora es real).
**Depende de**: 10.
**Incluye**:

- Comando `dynamo.scan(connectionId, tableName, { limit, exclusiveStartKey?, filterExpression?, expressionAttributeValues?, expressionAttributeNames?, projectionExpression?, indexName?, consistentRead, select? }) -> { items: AttrMap[], lastEvaluatedKey?, scannedCount, count }`.
- Comando `dynamo.query(connectionId, tableName, { indexName?, keyConditionExpression, expressionAttributeValues, expressionAttributeNames?, filterExpression?, projectionExpression?, exclusiveStartKey?, limit, consistentRead, scanIndexForward? }) -> ...`.
- Comando `dynamo.countItems(connectionId, tableName, { filterExpression?, indexName?, consistentRead })` que ejecuta scan con `Select=COUNT` paginando completo. Botón explícito en la UI — no se cuenta automáticamente porque puede ser caro.
- UI con dos modos toggleables (persistido por tabla):
  - **Tabla**: TanStack Table + virtualizer. Columnas inferidas: PK, SK (si existe), luego top-10 atributos por frecuencia en el sample, columna final "More…". Tipos complejos (`L`, `M`, `B`, sets) se muestran como resumen y abren el panel lateral.
  - **JSON**: lista virtualizada de bloques CodeMirror read-only, uno por item, JSON pretty con expand/collapse. Click en un bloque lo selecciona y carga al panel inspector.
- Panel inspector lateral: item completo en JSON expandible (estilo Cloudflare DynamoDB console), con resaltado de PK/SK y badges de tipo por atributo (`S`, `N`, `B`, `BOOL`, `NULL`, `L`, `M`, `SS`, `NS`, `BS`).
- Paginación: scroll-to-load usando `LastEvaluatedKey`. Indicador "X items loaded" en la barra inferior. Botón "Load more" como fallback si el scroll-loader falla.
- Query builder simple sin DSL:
  - Selector de modo: **Scan** (default) o **Query**.
  - Si **Query**: dropdown `Index` (Primary + GSIs + LSIs); pickers `Partition key = <valor>` y opcional `Sort key <op> <valor>` con ops válidos (`=`, `<`, `<=`, `>`, `>=`, `between`, `begins_with`).
  - Sección "Filter" (aplica post-fetch tanto en Scan como en Query): rows de `attribute / operator / value` que se compilan a `FilterExpression` con `ExpressionAttributeNames`/`Values`. Sin tener que escribir el DSL.
  - Toggle "Consistent read".
  - Toggle "Reverse order" (mapea a `ScanIndexForward=false` en Query).
- Atajo `⌘R` ejecuta el query con los parámetros actuales; `⌘⇧R` resetea.
- Default 100 items por request, configurable por tabla (`settings` key `dynamoLimit:<connectionId>:<table>`).

**Out of scope**: edición (siguiente change), exportar resultados (`dynamo-export-items` crossroads), agrupar/agregar.

---

### 12. `edit-dynamo-items` ⏳

**Meta**: Edición de items con operaciones atómicas (put/update/delete), insert con form que requiere PK/SK, optimistic locking opcional vía ConditionExpression, sin diff preview multi-row.
**Capacidades nuevas**: `dynamo-data-edit`.
**Capacidades modificadas**: `dynamo-data-view` (modo Tabla acepta edit-in-place; respeta read-only flag).
**Depende de**: 11.
**Incluye**:

- Edit-in-place sobre el modo Tabla:
  - Doble click en celda → editor inline tipado por DynamoDB type (`S` → input, `N` → input numérico con validación, `BOOL` → toggle, `NULL` → switch que setea `NULL=true`, `L`/`M`/sets → abre el JSON editor del panel lateral).
  - Cambiar el tipo de un atributo es explícito: dropdown de tipo + valor, no inferencia mágica.
- Edit JSON completo en panel lateral: CodeMirror con highlight JSON, validación al guardar, error claro si el JSON es inválido o si cambia la PK/SK del item original (eso es delete+put, no update).
- Comandos backend:
  - `dynamo.putItem(connectionId, tableName, item, { conditionExpression?, expressionAttributeValues? })` — para insert y full-replace.
  - `dynamo.updateItem(connectionId, tableName, key, updates, { conditionExpression?, expressionAttributeValues? })` — donde `updates` es `{ set: {...}, remove: [...] }` que el backend compila a `UpdateExpression`.
  - `dynamo.deleteItem(connectionId, tableName, key, { conditionExpression?, expressionAttributeValues? })`.
- Insert: botón "+" en la barra superior abre form modal:
  - Inputs requeridos: PK (y SK si la tabla la tiene), tipados según `KeySchema` + `AttributeDefinitions`.
  - Sección opcional: añadir atributos arbitrarios con `name / type / value`.
  - Modo alternativo "Paste JSON" para pegar un item completo.
- Delete: seleccionar fila(s) + tecla `⌫` → confirmación modal lista los keys que se van a borrar (no hay rollback). Multi-select borra una a una con barra de progreso.
- Cada operación se commitea individualmente; sin "save all" tipo Postgres. Errores por op se muestran inline (toast por fila) sin bloquear las demás.
- Optimistic locking opcional: toggle "Use ConditionExpression on update" que añade `attribute_exists(<pk>) AND <version_attr> = <last_known>` si la tabla declara un atributo de versión. UI permite especificar el atributo de versión por tabla (persistido en `settings`).
- Read-only flag: backend rechaza con error explícito; frontend deshabilita botones y muestra badge "Read-only" en la pestaña.
- Indicador de cambios pendientes: aunque no haya batch, si el usuario empieza a editar y cambia de tab/tabla, advertencia "Discard changes?".

**Out of scope**: editor visual rico para tipos complejos (`L`/`M` editor con árbol drag-drop), bulk import (`dynamo-import-items` crossroads), `TransactWriteItems` multi-item.

---

### 13. `run-partiql` ⏳

**Meta**: Pestaña dedicada a ejecutar PartiQL contra DynamoDB con CodeMirror, autocomplete de tablas/atributos, resultados en grid o JSON, paginación por NextToken, multi-statement secuencial.
**Capacidades nuevas**: `dynamo-partiql-editor`.
**Capacidades modificadas**: `query-history` (acepta `kind: "dynamo-partiql"`).
**Depende de**: 10 (necesita la lista de tablas para autocomplete). Convive con 11/12 sin tocarlas.
**Incluye**:

- Tab kind `dynamo-query` con un editor CodeMirror por pestaña.
- Syntax highlighting: PartiQL es ANSI SQL-ish; reusar `lang-sql` de CodeMirror con tweaks (keywords adicionales `EXISTS`, funciones DynamoDB como `attribute_exists`, `contains`, `begins_with`, `size`). Si los tweaks se complican, fallback a `lang-sql` puro y vivir con highlight imperfecto en V2.1.
- Atajo `⌘↩` ejecuta selección o, si no hay selección, la statement bajo el cursor.
- Comando `dynamo.executePartiQL(connectionId, statement, { parameters?, consistentRead?, nextToken?, limit? }) -> { items: AttrMap[], nextToken?, consumedCapacity? }`.
- Resultado debajo del editor: reusa el viewer de #11 (modos Tabla/JSON), paginación por `NextToken` con scroll-to-load.
- Para statements no-SELECT (`INSERT`, `UPDATE`, `DELETE`): mensaje "Statement OK" con el `consumedCapacity` y un eco del WHERE matched. Read-only flag bloquea no-SELECT en backend.
- Autocomplete:
  - Nombres de tablas de la conexión activa.
  - Atributos del KeySchema de la tabla referenciada (parsing simple del `FROM "Table"` en el statement).
  - Snippets para patterns comunes: `SELECT * FROM "<table>" WHERE`, `UPDATE "<table>" SET <attr> = ? WHERE`, etc.
- Multi-statement: PartiQL no soporta múltiples en un request. Si el usuario escribe varias separadas por `;`, el editor las ejecuta secuencialmente y muestra resultados en sub-tabs internas (igual patrón que `run-sql` en Postgres).
- Indicador de tiempo de ejecución y `consumedCapacity` (si la conexión lo pidió con `ReturnConsumedCapacity=TOTAL`).
- Persiste en `query-history` con `kind: "dynamo-partiql"` y connection_id; este change extiende la capability `query-history` para aceptar el nuevo kind sin tocar el módulo Postgres.
- Toggle "Consistent read" en la barra superior del editor.

**Out of scope**: explain plan (DynamoDB no expone uno público), `EXECUTE TRANSACTION` PartiQL (`TransactWriteItems`), saved queries (`dynamo-saved-queries` o `saved-queries` global son crossroads).

---

## V2.2 — Mejoras opcionales DynamoDB

Crossroads. No están en la ruta crítica; se proponen cuando el dolor sea real:

- `dynamo-export-items` — exportar resultados (Scan, Query, PartiQL) a JSON / CSV / NDJSON.
- `dynamo-import-items` — bulk import desde JSON / NDJSON con validación contra `KeySchema`, dry-run y reporte de fallidos.
- `dynamo-streams-viewer` — leer registros del stream de una tabla en near-real-time (DynamoDB Streams, no Kinesis).
- `dynamo-batch-operations` — usar `BatchGetItem` / `BatchWriteItem` para bulk hasta 25 ops por call con backoff y reintentos.
- `dynamo-table-metrics` — embeber métricas básicas de CloudWatch para la tabla (`ConsumedReadCapacity`, `ConsumedWriteCapacity`, `ThrottledRequests`) sin construir un dashboard completo. Anticipa V2 CloudWatch.
- `dynamo-create-table` — DDL: crear tabla, borrar tabla, crear/borrar GSIs, switch BillingMode. Operaciones con confirmación fuerte.
- `dynamo-ttl-config` — leer y setear el TTL attribute de una tabla.
- `dynamo-saved-queries` — favoritos PartiQL con nombre + carpetas (si `saved-queries` general no llega antes; en ese caso este se descarta).

---

## Notas transversales

- **Cross-cutting**: ningún change V2 toca código de `src/modules/postgres/` ni `src-tauri/src/modules/postgres/`. Todo nuevo en `src/modules/dynamo/` y `src-tauri/src/modules/dynamo/`. Si descubres que necesitas modificar el módulo Postgres para soportar Dynamo, **es señal de que la abstracción se está colando donde no debe** — para, repensa, y mueve la primitiva compartida a `connection-registry`, `app-shell`, `command-palette`, o `query-history`.
- **Reuso del data-grid**: el grid de Postgres (`src/modules/postgres/grid/`) **no se copia y modifica**. Si #11 lo necesita reusar, la opción correcta es un change preliminar `extract-shared-data-grid` que mueva el componente a `src/components/data-grid/` con una API agnóstica de fuente (rows, columns, virtualizer). Ese change es prerrequisito de #11 si se opta por reusar; alternativa válida es escribir un grid Dynamo-específico desde cero (más simple en V2.1 dado que el shape es heterogéneo y la columna "More…" no existe en Postgres). Decisión a tomar al proponer #11; ambas opciones documentadas en su `design.md`.
- **Capability naming**: prefijos por dominio. Las capacidades nuevas de este roadmap son `dynamo-connection`, `dynamo-table-browser`, `dynamo-data-view`, `dynamo-data-edit`, `dynamo-partiql-editor`. Las modificadas (`connection-registry`, `app-shell`, `query-history`) mantienen su nombre sin prefijo.
- **Versionado de specs**: cuando un change modifica una capability existente (p.ej. #9 modifica `connection-registry`), el `spec.md` del change usa `## MODIFIED Requirements` con el bloque entero copiado y editado. Sin deltas parciales. Igual que V1.
- **Sesiones**: cada change debería caber en 1-2 sesiones. Si el `tasks.md` supera 60 ítems en `/opsx:propose`, partir el change en dos. Candidatos naturales de partición: #11 (query builder puede separarse del viewer básico), #12 (insert form puede separarse del edit-in-place).
- **No half-finished implementations**: si un change queda al 80% (p.ej. Scan funciona pero Query no), no se archiva. Se cierra completo o se reduce el scope explícitamente en el proposal antes de comenzar.
