## Context

La v1 de esta feature (tasks 1–4, ya implementadas) listaba las NamedQueries **solo del workgroup configurado en la conexión** (`AcquiredClient.workgroup`). En pruebas contra una cuenta real (perfil `Argus`, cuenta `862361086694`) el branch salió vacío: la conexión apuntaba a `primary` (0 queries) mientras las saved queries vivían en el workgroup `argus-analytics` (2 queries: `visits-per-day`, `downloads-by-platform-version`, creadas por el PR #136). Las NamedQueries de AWS están scoped por workgroup, pero el usuario las piensa a nivel cuenta, y la consola de AWS sí permite cambiar de workgroup para verlas todas.

**Estado actual relevante** (de la v1 ya implementada):

- `athena_list_named_queries(id)` (`modules/athena/named_queries.rs`): `acquire` → `list_named_queries(work_group)` paginado → `chunk_ids` (≤50) → `batch_get_named_query` con retry de `unprocessed` → `sort_summaries_by_name`. Helpers puros `chunk_ids` / `sort_summaries_by_name` ya testeados.
- `athena_get_named_query(id, named_query_id)`: `get_named_query` → `NamedQueryDetail` con `query_string`. Resuelve por ID, **independiente del workgroup**.
- `NamedQuery` (SDK `aws-sdk-athena` 1.105) ya expone `.work_group()` en cada item, así que el agrupamiento no requiere llamadas extra.
- `BatchGetNamedQuery` resuelve por ID account-wide: NO hay que repetirlo por workgroup; basta agregar todos los IDs y batchear.
- Frontend: `athenaSchemaCache` cachea `namedQueries` por conexión; `SchemaTree.tsx` renderiza el branch como hoja-lista plana, integra search/filter, lazy-load, estados loading/empty/error y refresh.

**Constraints**:

- No abrir conexiones nuevas: reusar el cliente del pool.
- El workgroup de la conexión deja de determinar el scope; sigue usándose para ejecutar queries (eso no cambia).
- Mantener el payload del listado liviano (sin `query_string`).
- Respetar DESIGN.md: el agrupamiento por workgroup reusa el mismo patrón de grupo del árbol (igual que "databases"), sin nuevos colores/radios.

## Goals / Non-Goals

**Goals**:

- `athena_list_named_queries` enumera **todos los workgroups** (`ListWorkGroups`) e itera `ListNamedQueries` por cada uno, agregando IDs.
- Resolver el conjunto agregado con `BatchGetNamedQuery` en lotes de ≤50 (sin repetir por workgroup).
- Orden por `(work_group, name)` case-insensitive.
- Árbol agrupado por workgroup: un sub-nodo por workgroup con ≥1 query (los vacíos se omiten), con contador.
- Robustez: un workgroup cuyo `ListNamedQueries` falle se omite sin romper el resto.

**Non-Goals**:

- CRUD (sigue en fase 2 / issue #137).
- Catálogos distintos a `AwsDataCatalog`.
- Mostrar workgroups vacíos (ruido innecesario).
- Filtrar por estado del workgroup (`ENABLED`/`DISABLED`): se incluyen ambos; solo se omite el que rechace el listado.

## Decisions

### Decisión: scope = todos los workgroups (revierte la decisión #3 de la v1)

La v1 limitaba al workgroup de la conexión. Se invierte: el listado enumera la cuenta completa. Razón: el modelo mental del usuario es "mis saved queries de la cuenta", y la conexión suele apuntar a un único workgroup que no necesariamente coincide. La consola de AWS ofrece la misma vista cross-workgroup (cambiando de workgroup). Trade-off aceptado: más llamadas (`ListWorkGroups` + un `ListNamedQueries` por workgroup) y un permiso IAM extra (`athena:ListWorkGroups`).

### Decisión: BatchGetNamedQuery sobre el conjunto agregado

`BatchGetNamedQuery` resuelve por ID sin filtro de workgroup. Se acumulan los IDs de todos los workgroups y se batchea una sola vez (chunks de ≤50). Evita N×(batches por workgroup) y reusa los helpers `chunk_ids` / retry de `unprocessed` ya existentes. El `work_group` viene en cada `NamedQuery`, así que el agrupamiento es puramente de presentación.

### Decisión: agrupar por workgroup en el árbol, omitir vacíos

Estructura: `Named Queries` → (sub-nodo por workgroup con ≥1 query) → (hoja por query). Se omiten workgroups vacíos para no listar `primary (0)` y similares. Si la cuenta no tiene ninguna NamedQuery, el branch muestra el estado vacío "Sin named queries en la cuenta". El sort `(work_group, name)` del backend deja los grupos y sus hijos ya ordenados; el frontend solo parte por `work_group`.

### Decisión: tolerar workgroups no enumerables

Un workgroup `DISABLED` o sin permiso puede rechazar `ListNamedQueries`. En vez de fallar todo el listado, ese workgroup se omite (se loggea/ignora el error puntual) y se devuelven los demás. El error global solo se propaga si falla `ListWorkGroups` mismo (sin él no hay nada que iterar).

## Risks / Trade-offs

- **Más llamadas AWS**: cuentas con muchos workgroups generan más round-trips. Mitigación: lazy-load al expandir (no en connect) + cache del resultado completo por conexión. Aceptable para el caso típico (pocos workgroups).
- **Permiso IAM nuevo** (`athena:ListWorkGroups`): si falta, el branch muestra error inline; el resto del árbol sigue. Documentado en el proposal.
- **Ambigüedad de scope al ejecutar**: una query de `argus-analytics` abierta en un tab cuya conexión usa workgroup `primary` se ejecutará bajo `primary`. En v1 esto es aceptable (abrir = precargar SQL); cambiar el workgroup de ejecución por-query queda fuera de alcance.

## Migration / Rollout

Es un amend de un change no shipeado (no archivado): no hay migración. El backend cambia el cuerpo de `athena_list_named_queries` (mismo signature y mismo tipo de retorno `Vec<NamedQuerySummary>`), así que el frontend de la v1 sigue compilando; solo el `SchemaTree` cambia de lista plana a agrupada por workgroup. Tests de helpers puros se mantienen y se amplía el de orden a `(work_group, name)`.
