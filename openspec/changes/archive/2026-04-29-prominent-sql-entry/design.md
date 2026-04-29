## Context

Hoy el sidebar de Argus renderiza cada conexión Postgres así:

```tsx
<div className={styles.row}>
  <button onClick={toggleConnect}>...connection name + active dot...</button>
  {isPostgres && active && (
    <span className={styles.rowToolbar}>
      <SchemaToolbar connectionId={connection.id} />  // [+ Query] [Refresh] [Visibility picker]
    </span>
  )}
</div>
```

con CSS:

```css
.rowToolbar { opacity: 0; transition: opacity 100ms; }
.row:hover .rowToolbar { opacity: 1; }
```

El resultado: los tres botones (`+ Query`, refresh, visibility picker) son **invisibles hasta que el usuario hace hover** sobre la fila. Para schemas-refresh y visibility-picker eso es razonable (acciones secundarias, casi de mantenimiento). Para `+ Query` es **el path principal** de "ejecuto SQL en esta conexión" y debe ser permanentemente discoverable.

El context menu actual del clic-derecho lista `Edit / Duplicate / Delete` y NO incluye una entrada para SQL.

`run-sql` también dejó la palette command `SQL: New Query` (vía `usePostgresCommands`), pero el path teclado-only es secundario; el usuario que recién llega no descubre la palette antes que el sidebar.

**Constraints**:
- No re-diseñar el sidebar; cambios visuales mínimos y consistentes con el resto del sidebar.
- No competir con la "active dot" verde — el botón debe ser tono neutro, no `--accent`.
- Mantener refresh + visibility-picker hover-only (su discoverabilidad actual no es el problema).
- Cambios localizados a `Sidebar.tsx`, `Sidebar.module.css`, `SchemaTree.tsx`. Sin tocar el resto del módulo.

## Goals / Non-Goals

**Goals**:

- El botón `+ Query` (icono terminal) es siempre visible cuando la conexión Postgres está conectada — sin hover.
- El context menu de la fila de conexión incluye `New SQL Query` cuando la conexión está activa.
- Refresh y visibility-picker mantienen su comportamiento hover-only.
- Tooltip enriquecido con la pista del atajo de ejecución (`⌘↩`).
- Cambios visuales discretos, alineados con el resto del sidebar.

**Non-Goals**:

- Atajo global `⌘N` para new query.
- FAB / dock en el centro de la pantalla.
- Welcome tab CTA.
- Cambiar el icono o el color del botón a `--accent`.
- Mostrar el botón en conexiones inactivas (no tiene sentido — abrir SQL contra una conexión sin pool simplemente fallaría).
- Refactor mayor del sidebar.

## Decisions

### 1. Dos slots: "primary actions" (siempre visible) y "secondary toolbar" (hover-only)

La fila de conexión pasa de tener un único `rowToolbar` (todo hover) a tener dos slots:

```tsx
<div className={styles.row}>
  <button onClick={toggleConnect}>...</button>
  {isPostgres && active && (
    <>
      <span className={styles.rowPrimary}>      {/* siempre visible */}
        <SchemaPrimaryActions connectionId={...} />  {/* botón + Query */}
      </span>
      <span className={styles.rowToolbar}>      {/* hover-only */}
        <SchemaToolbar connectionId={...} />     {/* refresh + visibility picker */}
      </span>
    </>
  )}
</div>
```

CSS:
```css
.rowPrimary { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; }
.rowToolbar { /* sin cambios — sigue opacity:0/1 en hover */ }
```

**Por qué dos slots**: la separación visual también separa la jerarquía de acciones. El usuario ve el `+ Query` siempre; cuando pasa el mouse, descubre las acciones secundarias.

**Alternativa descartada**: un solo slot sin hover gate. Demasiado ruido visual con tres iconos siempre presentes (un sidebar denso ya tiene mucha cosa visible).

### 2. `SchemaTree` exporta dos componentes distintos

Hoy `SchemaTree.tsx` exporta `SchemaTree` y `SchemaToolbar`. Cambiamos a:

```tsx
export function SchemaPrimaryActions({ connectionId }: { connectionId: string }) {
  // botón "+ Query" (Terminal icon)
}

export function SchemaToolbar({ connectionId }: { connectionId: string }) {
  // refresh + visibility picker (sin el botón SQL)
}
```

Ambos consumen `useTabs()` / `useConnections()` / `useSchemaTree()` según necesiten. La división es por slot, no por dependencia.

**Por qué**: lo más simple. Cada componente tiene un responsabilidad y un consumidor. El Sidebar elige qué renderizar en qué slot.

**Alternativa descartada**: un único componente `SchemaActions` con prop `slot: "primary" | "secondary"`. Más código condicional adentro, no aporta sobre dos componentes simples.

### 3. Tooltip más informativo

El tooltip pasa de `New SQL query` a `New SQL query · ⌘↩ runs`. Sin sobrecargar — solo el atajo más útil. (No mostramos `Mod-Shift-Enter` porque es secundario.)

### 4. Context menu: `New SQL Query` en la cima, separator antes de Edit

```tsx
<ContextMenu.Content>
  {isPostgres && active && (
    <>
      <ContextMenu.Item onSelect={openQuery}>New SQL Query</ContextMenu.Item>
      <ContextMenu.Separator />
    </>
  )}
  <ContextMenu.Item onSelect={editConnection}>Edit</ContextMenu.Item>
  <ContextMenu.Item onSelect={duplicate}>Duplicate</ContextMenu.Item>
  <ContextMenu.Item danger onSelect={deleteConnection}>Delete</ContextMenu.Item>
</ContextMenu.Content>
```

**Por qué arriba y no al final**: el orden semántico va de "lo más usado / más constructivo" a "lo destructivo". `New SQL Query` es la acción primaria de cualquier connection conectada; `Delete` es la destructiva al final.

**Implementación**: el handler reutiliza `openQueryTab(tabs, { connectionId, connectionName })` — el mismo helper que el botón. Sin lógica duplicada.

### 5. Sin estilos accent

El botón mantiene `var(--text-muted)` → `var(--text)` en hover. No `--accent`. Razón: el sidebar ya usa accent para el dot de "active" y para items seleccionados; añadirle accent al `+ Query` competiría visualmente y daría lectura "este botón está activo".

### 6. Conexiones inactivas: nada cambia

La fila de una conexión Postgres sin pool conectado:
- No muestra ningún slot de acciones (igual que hoy).
- En context menu, no aparece `New SQL Query` (la condición `isPostgres && active` lo guarda).

**Por qué**: abrir una pestaña SQL contra una conexión sin pool resulta en errores al primer ⌘↩. Mejor no ofrecer la acción si no se puede ejecutar.

## Risks / Trade-offs

- **Densidad visual del sidebar** → un icono más siempre visible aumenta la densidad. Mitigación: tono muted, mismo tamaño que los demás, sin label. La alternativa (mantener hover-only) es peor: el feature es invisible.
- **Conexiones que se conectan brevemente y se desconectan** → el botón aparece/desaparece en transitions. Aceptable; el usuario lo verá cuando importa (durante la conexión activa).
- **Context menu se vuelve más largo** → solo 1 item nuevo, en la cima. No es un problema. Mitigación: el separator marca la transición de "abrir nueva cosa" a "modificar la conexión".
- **El usuario sigue sin saber qué hace el icono Terminal** → el tooltip lo cubre. Si más adelante hay quejas, considerar añadir un label `Query` al lado del icono. V1: solo icono, en línea con el resto del sidebar.

## Migration Plan

Cambio aditivo, frontend-only. Pasos:

1. Editar `src/modules/postgres/schema/SchemaTree.tsx`:
   - Extraer el botón `+ Query` actual (dentro de `SchemaToolbar`) a un nuevo export `SchemaPrimaryActions`.
   - `SchemaToolbar` queda con refresh + visibility-picker.
2. Editar `src/platform/shell/Sidebar.tsx`:
   - Añadir el slot `<span className={styles.rowPrimary}>` con `<SchemaPrimaryActions />`, antes del `<span className={styles.rowToolbar}>`.
   - Añadir el ítem `New SQL Query` al `ContextMenu.Content` (con separator). El handler usa `openQueryTab` y `useTabs()`.
   - Importar `openQueryTab` desde `@/modules/postgres/sql` (o re-exportar desde `@/modules/postgres`).
3. Editar `src/platform/shell/Sidebar.module.css`:
   - Añadir `.rowPrimary { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; }`.
   - El selector `.row:hover .rowToolbar { opacity: 1 }` permanece — solo afecta al toolbar secundario.
4. Actualizar tooltip del botón `+ Query` a `New SQL query · ⌘↩ runs`.
5. `pnpm typecheck` + `pnpm build`.
6. QA manual: conectar a una BD, verificar que el icono `+ Query` se ve sin hover; clic abre el query tab. Click-derecho sobre la fila → `New SQL Query` aparece y abre el tab. Refresh + visibility-picker siguen aparecen en hover.

**Rollback**: revertir el commit. No hay datos persistidos al feature.

## Open Questions

- **¿Mostrar también un label de texto `Query` al lado del icono?** Lo dejamos como follow-up si el icono solo no es suficientemente claro tras el cambio.
- **¿Añadir `New SQL Query` también al menú palette de la conexión** (algo como un sub-menu)? La palette ya tiene `SQL: New Query` general; añadir per-connection en palette es ruido, lo dejamos out.
- **¿Mostrar el botón en una conexión inactiva como "ofrecer conectar y abrir"?** No: dos pasos en uno opaco. Si el usuario quiere abrir SQL, primero conecta.
