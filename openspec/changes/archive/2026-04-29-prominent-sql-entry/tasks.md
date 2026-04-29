## 1. SchemaTree: split actions into primary + secondary

- [x] 1.1 En `src/modules/postgres/schema/SchemaTree.tsx`, extraer el botón `+ Query` (icono `Terminal`) actual del componente `SchemaToolbar` a un nuevo export `SchemaPrimaryActions({ connectionId })`. El componente reusa `useTabs()` + `useConnections()` para obtener el `connectionName` y dispara `openQueryTab`.
- [x] 1.2 Actualizar `SchemaToolbar` para que ya NO incluya el botón SQL — solo refresh + `<VisibleSchemasPicker />`. El export se mantiene.
- [x] 1.3 Actualizar el tooltip del botón SQL en `SchemaPrimaryActions` a `New SQL query · ⌘↩ runs` (atributo `title` y `aria-label` separados o coherentes; el `aria-label` puede quedarse simple como `New SQL query`).

## 2. Sidebar: render del slot primary y context menu

- [x] 2.1 En `src/platform/shell/Sidebar.tsx`, importar `SchemaPrimaryActions` (además de `SchemaToolbar`) desde `@/modules/postgres`.
- [x] 2.2 Re-exportar `SchemaPrimaryActions` desde `src/modules/postgres/index.ts` (junto a `SchemaToolbar`).
- [x] 2.3 Modificar el JSX de la fila de conexión para que, cuando `isPostgres && active`, renderice DOS slots: `<span className={styles.rowPrimary}><SchemaPrimaryActions … /></span>` (siempre visible) y `<span className={styles.rowToolbar}><SchemaToolbar … /></span>` (hover-only existente).
- [x] 2.4 Importar `openQueryTab` y `useTabs` en `Sidebar.tsx`. Añadir un `ContextMenu.Item` con label `New SQL Query` al inicio del `<ContextMenu.Content>` de la fila de conexión, condicionalmente cuando `isPostgres && active`. Inmediatamente después del item, un `<ContextMenu.Separator />`.
- [x] 2.5 El handler del item llama a `openQueryTab(tabs, { connectionId: connection.id, connectionName: connection.name })`.

## 3. Sidebar CSS

- [x] 3.1 En `src/platform/shell/Sidebar.module.css`, añadir la regla `.rowPrimary { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; }`.
- [x] 3.2 Verificar que la regla `.row:hover .rowToolbar { opacity: 1 }` permanece y solo afecta al toolbar secundario.
- [x] 3.3 Añadido estilo `.contextSeparator { height: 1px; background: var(--border); margin: 4px 0; }` para el `<ContextMenu.Separator />`.

## 4. Validación

- [x] 4.1 `pnpm typecheck` y `pnpm build` sin errores.
- [ ] 4.2 Manual QA:
  - Conectar a una BD Postgres → el icono `Terminal` aparece **inmediatamente** sin necesitar hover; refresh + visibility-picker siguen apareciendo solo en hover.
  - Click en el icono → abre un query tab nuevo con el editor focuseado.
  - Click-derecho sobre la fila conectada → `New SQL Query` aparece arriba con separator, luego Edit / Duplicate / Delete. Seleccionarlo abre un query tab.
  - Desconectar → el icono SQL desaparece. Click-derecho ya no muestra `New SQL Query`.
  - Tooltip del icono dice `New SQL query · ⌘↩ runs`.
