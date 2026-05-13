## Context

Argus tiene hoy tres grillas tabulares con el mismo problema:

1. `src/modules/postgres/data/DataGrid.tsx` — grilla editable del table viewer.
2. `src/modules/postgres/data/AdhocResultGrid.tsx` — grilla read-only consumida por el SQL editor.
3. `src/modules/dynamo/data-view/TabView.tsx` — grilla TanStack para items DynamoDB.

Las tres declaran `const COLUMN_WIDTH = 180` y lo aplican como `style={{ width: COLUMN_WIDTH }}` en cada header y celda. El ancho total del header sticky se calcula como `columns.length * COLUMN_WIDTH`. No hay handle de resize ni persistencia.

La metadata de tipo ya existe:
- Postgres: `DataColumn.data_type` (string crudo del catálogo) + helper `categorize()` en `src/modules/postgres/data/typeHelpers.ts` que retorna `"numeric" | "boolean" | "date" | "text" | "binary" | "json" | "uuid" | "other"`.
- DynamoDB: `useInferredColumns()` infiere el "AttributeValue tag" dominante (`S | N | BOOL | NULL | L | M | B | SS | NS | BS`) para cada columna.

La persistencia ya tiene patrón establecido: `useSetting<T>(key, default)` en `src/platform/settings/useSetting.ts`, con cache en memoria y escritura debounced (150ms) a disco vía Tauri. Ya hay claves por tabla (`pgTableLimit:*`, `dynamoView:*`, filtros, etc.).

DESIGN.md define `--hairline`, `--duration-instant` (80ms), `--duration-short` (120ms), `--surface-2`, y la densidad compacta de celda (5px 12px). No hay token para "handle de resize" todavía.

## Goals / Non-Goals

**Goals:**
- Cada columna de las tres grillas tiene un ancho independiente, modificable arrastrando el borde derecho del header.
- El ancho inicial de cada columna depende del tipo del valor (categoría semántica), no es un valor único global.
- Los anchos personalizados se persisten por tabla (Postgres y DynamoDB) usando el patrón existente de `useSetting()`.
- Doble-click en el handle resetea esa columna al ancho base por tipo.
- El visual del handle es coherente con DESIGN.md (hairline, sin animaciones gratuitas, motion `--duration-instant`).
- El header sticky y el cálculo de `totalWidth` se mantienen consistentes con los anchos efectivos para que el scroll horizontal funcione correctamente.

**Non-Goals:**
- Reordenar columnas con drag (sigue siendo otra capability futura).
- Ocultar/mostrar columnas o configurar visibilidad.
- Autosize tipo "fit to content" inspeccionando filas (puede ser una iteración futura, posiblemente como acción de doble-click alternativa o context menu).
- Persistir anchos en la grilla ad-hoc del SQL editor (el shape del result cambia query a query — sólo persistimos in-memory mientras vive el tab).
- Cambiar la librería de tablas (Postgres sigue con virtualización custom; DynamoDB sigue con TanStack).
- Compartir anchos entre conexiones distintas que apuntan a la misma tabla.

## Decisions

### 1. Anchos base por tipo

Un mapa único, exportado desde un módulo nuevo `src/platform/table/columnWidths.ts`:

```ts
export const BASE_WIDTH_BY_CATEGORY: Record<ColumnCategory, number> = {
  boolean: 88,
  numeric: 120,
  date: 168,        // timestamp con tz cabe sin truncar
  uuid: 280,        // uuid completo
  text: 200,
  json: 240,
  binary: 140,
  other: 180,       // fallback = ancho actual
};

export const MIN_WIDTH = 56;
export const MAX_WIDTH = 800;
```

Para DynamoDB las categorías son: `BOOL → boolean`, `N → numeric`, `S → text` (uuid si el atributo es PK/SK y el sample matchea regex de uuid en >80% de los casos), `B → binary`, `NULL → boolean` (ancho corto), tipos complejos `L|M|SS|NS|BS → json`. Marcadores de PK/SK añaden +16px al ancho base (espacio para el badge).

**Alternativas consideradas:**
- *Heurística de contenido (medir el sample real)*: rechazado para v1 porque requiere medir DOM o estimar caracteres, costo asíncrono al primer render, y el sample puede mentir (`SELECT * LIMIT 5` vs realidad). El usuario igual puede ajustar manualmente.
- *Un solo ancho fijo distinto por tipo en cada grilla*: rechazado por duplicación; preferimos una única fuente de verdad reutilizable.

### 2. Modelo de datos del override

```ts
type ColumnWidthsRecord = Record<string, number>;  // columnName → px
```

Sólo guardamos overrides. Si una columna no aparece en el record, se computa `baseWidthFor(column)` en tiempo de render. Ventaja: cambiar los defaults en código se refleja inmediatamente para usuarios que no personalizaron; el record no se llena de valores redundantes.

### 3. Claves de persistencia

- Postgres table viewer: `pgColumnWidths:<connectionId>:<schema>:<relation>` (sigue el patrón de `pgTableLimit:*`).
- DynamoDB: `dynamoColumnWidths:<connectionId>:<tableName>` (sigue el patrón de `dynamoView:*`).
- SQL editor ad-hoc grid: **no persiste a disco**. Vive como `useState` dentro del componente `<AdhocResultGrid />` y se resetea cuando cambian `columns` (clave de estado = signature de `columns.map(c => c.name).join("|")`).

### 4. Hook compartido

```ts
function useColumnWidths(opts: {
  storageKey: string | null;   // null = in-memory only
  columns: Array<{ name: string; category: ColumnCategory; extraPad?: number }>;
}): {
  widthFor: (name: string) => number;
  totalWidth: number;
  setWidth: (name: string, px: number) => void;
  resetWidth: (name: string) => void;
};
```

Cuando `storageKey` es `null` usa `useState`; cuando es string usa `useSetting<ColumnWidthsRecord>(storageKey, {})`. Eso da una sola superficie para los tres consumers.

### 5. UX del resize handle

- Zona arrastrable: 6px sobre el borde derecho del header (3px hacia dentro, 3px hacia fuera), siempre presente pero invisible.
- Hover: aparece una línea vertical de 1px usando `--accent` con 50% de opacidad y `transition: opacity var(--duration-instant)`.
- `cursor: col-resize` mientras está sobre la zona y mientras se arrastra.
- Drag: durante el arrastre usamos `pointermove` global con `pointerId` capturado; durante el drag agregamos `user-select: none` y `cursor: col-resize` al `body`.
- Reset: doble-click sobre la zona del handle → `resetWidth(name)`.
- Clamp: el ancho se clampea a `[MIN_WIDTH, MAX_WIDTH]` antes de persistir.
- Debounce de persistencia: lo da `useSetting()` (150ms) gratis; el estado local se actualiza en cada `pointermove` para feedback inmediato.

**Alternativas consideradas:**
- *react-resizable / @tanstack/react-table column-resize built-in*: TanStack lo trae pero sólo lo usa DynamoDB; introducirlo en Postgres requeriría meter TanStack ahí también. Como ya tenemos toda la infra de virtualización custom en Postgres, una implementación manual de ~80 líneas es más barata que migrar.
- *Resize de toda la fila desde un overlay separado*: rechazado, complica el sticky header.

### 6. Recalculo del header sticky

Hoy: `style={{ width: Math.max(columns.length * COLUMN_WIDTH, 1) }}`.
Después: `style={{ width: totalWidth }}` donde `totalWidth = sum(widthFor(c.name) for c in columns)`.

Cada celda recibe `style={{ width: widthFor(column.name), flex: "0 0 auto" }}`. El `flex: 0 0 auto` ya existe en los `*.module.css`.

### 7. Edge cases

- **Reordering de columnas no implementado todavía**: las claves del record son por nombre de columna, así que el reorden futuro funcionará sin migración.
- **Cambio de schema (columna renombrada en DB)**: el record vieja queda con keys huérfanas; no es problema funcional (se ignoran). Una limpieza opcional puede correr al hidratar: filtrar keys que ya no están en `columns`. Lo dejaremos para una iteración si crece.
- **DynamoDB columna "More…"**: ancho fijo `40px`, no resizable. Lo marca un flag `nonResizable` en la spec de columna.
- **Edit mode en Postgres**: el input inline ocupa el ancho de la celda; no cambia (sigue usando `width: 100%`).
- **Scroll horizontal del overlay de edición**: el contenedor de la fila ya hace overflow correctamente con `width: totalWidth`.

### 8. Tests

- Unit: `baseWidthFor(category, isKey)` retorna los valores correctos para cada combinación.
- Unit: `useColumnWidths` con storageKey null usa estado local; con string llama a `useSetting` (mock).
- Unit: clamp a min/max; reset borra la entry y vuelve a usar default por tipo.
- Component (vitest + testing-library): arrastrar el handle 50px a la derecha aumenta el width en 50px y dispara persistencia (en modo persistido).
- Component: doble-click resetea.
- Snapshot/visual: header sticky alinea con celdas tras un resize (medir `totalWidth` vs suma).

## Risks / Trade-offs

- **[Riesgo] Layout shift al primer render mientras se hidrata `useSetting`** → Mitigación: el hook ya devuelve `loaded: boolean`; si `loaded === false` y la grilla es persistida, renderizamos con defaults (no esperamos). El usuario ve el ancho personalizado en cuanto el disco resuelve (típicamente <1 frame). Diferencia visual mínima porque defaults por tipo ya son razonables.
- **[Riesgo] `pointermove` global durante el drag interfiere con otros listeners** → Mitigación: usamos `setPointerCapture` sobre el handle; sólo el elemento que capturó recibe los moves, y limpiamos en `pointerup/pointercancel`.
- **[Trade-off] No persistir ad-hoc grid widths** → Si el usuario reescribe la misma query, pierde su ajuste. Alternativa: hash del shape de columnas. Demasiado para v1; el usuario puede ajustar otra vez en segundos.
- **[Trade-off] No autosize por contenido** → Algunos usuarios pueden esperar "double-click hace fit-to-content". Documentamos que doble-click = reset al default por tipo. Si la queja se materializa, agregamos `Alt+doble-click` o context menu para autosize.
- **[Riesgo] El record persistido crece sin límite con columnas viejas renombradas** → Mitigación opcional v1.1: poda al hidratar (filtrar keys que ya no aparecen en `columns`). Costo de no hacerlo es bytes irrisorios.
- **[Riesgo] DynamoDB infiere categoría por sample; un cambio de sample podría cambiar la categoría inferida** → Mitigación: la categoría sólo afecta el *default*; cuando el usuario tiene un override persistido, ese gana siempre.
