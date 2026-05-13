## 1. Shared platform module

- [x] 1.1 Create `src/platform/table/columnWidths.ts` exporting `ColumnCategory`, `BASE_WIDTH_BY_CATEGORY`, `MIN_WIDTH = 56`, `MAX_WIDTH = 800`, `KEY_BADGE_PAD = 16`, and `baseWidthFor({ category, isKey })`.
- [x] 1.2 Add helper `clampWidth(px: number): number` that clamps to `[MIN_WIDTH, MAX_WIDTH]`.
- [x] 1.3 Implement `useColumnWidths({ storageKey, columns })` hook returning `{ widthFor, totalWidth, setWidth, resetWidth }`. When `storageKey === null` uses `useState`; otherwise uses `useSetting<ColumnWidthsRecord>(storageKey, {})`. `totalWidth` is memoized via the columns array signature.
- [x] 1.4 Unit tests for `baseWidthFor` (every category, with/without `isKey`), `clampWidth`, and `useColumnWidths` (persisted vs in-memory branches, reset clears entry, set clamps before storing).

## 2. Shared resize handle component

- [x] 2.1 Create `src/platform/table/ResizeHandle.tsx` rendering a 6px-wide hit area positioned over the right edge of a header cell. Props: `currentWidth`, `onChange(px)`, `onReset()`, `disabled?`.
- [x] 2.2 Implement pointer-event handling: `pointerdown` calls `setPointerCapture`; `pointermove` computes the new width and calls `onChange(clampWidth(...))`; `pointerup`/`pointercancel` releases capture and removes the global cursor/select overrides.
- [x] 2.3 During an active drag, add `user-select: none` and `cursor: col-resize` to `document.body`; clean up on release.
- [x] 2.4 Render the hover/drag indicator as a 1px line using `--accent` at 50% opacity, with `transition: opacity var(--duration-instant)`.
- [x] 2.5 Wire `dblclick` to `onReset()`.
- [x] 2.6 Component tests: drag updates width live, pointerup commits, clamp at min/max, double-click calls onReset, disabled renders nothing.

## 3. Postgres type → category helper

- [x] 3.1 Verify or extend `src/modules/postgres/data/typeHelpers.ts` `categorize()` to cover the exact mapping in the spec (numeric / boolean / date / text / binary / json / uuid / other), including `citext`, `int2/int4/int8`, `float4/float8`, `timestamp with/without time zone`, `time with/without time zone`, `interval`, `character varying`, `character`, `char`.
- [x] 3.2 Unit tests for every type listed in the spec scenarios plus a representative "unknown" type (e.g. `tsvector`) returning `other`.

## 4. Postgres editable DataGrid (`src/modules/postgres/data/DataGrid.tsx`)

- [x] 4.1 Remove the local `COLUMN_WIDTH = 180` constant.
- [x] 4.2 Map each `DataColumn` to `{ name, category: categorize(c.data_type), isKey: c.is_key ?? false }` and pass to `useColumnWidths({ storageKey: \`pgColumnWidths:${connectionId}:${schema}:${relation}\`, columns: mapped })`.
- [x] 4.3 Replace `width: COLUMN_WIDTH` in header and cell inline styles with `width: widthFor(column.name)`.
- [x] 4.4 Replace sticky-header / row-container `width: columns.length * COLUMN_WIDTH` with `width: totalWidth`.
- [x] 4.5 Render `<ResizeHandle>` inside each header cell with `currentWidth={widthFor(c.name)}`, `onChange={(px) => setWidth(c.name, px)}`, `onReset={() => resetWidth(c.name)}`.
- [x] 4.6 Ensure the inline edit input still uses `width: 100%` (verify against `DataGrid.module.css`).
- [x] 4.7 Update `DataGrid.module.css` if needed so header cells `position: relative` for the absolute-positioned handle.
- [x] 4.8 Component test: opening a fresh viewer renders widths matching type defaults from the spec scenario `[280, 200, 168, 88]`; resizing `email` to 320 persists via `useSetting` mock.

## 5. Postgres AdhocResultGrid (`src/modules/postgres/data/AdhocResultGrid.tsx`)

- [x] 5.1 Remove the local `COLUMN_WIDTH = 180` constant.
- [x] 5.2 Compute a `columnsSignature = columns.map(c => c.name).join("|")` and key the in-memory widths state on it so a new signature resets the record.
- [x] 5.3 Call `useColumnWidths({ storageKey: null, columns: mapped })` and apply `widthFor`, `totalWidth`, `setWidth`, `resetWidth` analogously to DataGrid.
- [x] 5.4 Render `<ResizeHandle>` in each header cell.
- [x] 5.5 Component test: resizing column `b` to 280 then changing columns from `[a,b,c]` to `[a,b,d]` resets all widths to defaults; no `useSetting` write occurs.

## 6. DynamoDB TabView (`src/modules/dynamo/data-view/TabView.tsx`)

- [x] 6.1 Remove the local `COLUMN_WIDTH = 180` constant; keep `MORE_COLUMN_WIDTH = 40` and flag that column as `nonResizable`.
- [x] 6.2 Extend `useInferredColumns()` (or a new sibling helper) to expose, per column, the dominant AttributeValue tag and the derived `ColumnCategory` per the DynamoDB mapping in the spec, plus `isKey` and an optional UUID heuristic for key `S` columns (≥80% of sample matches the UUID v4 regex).
- [x] 6.3 Call `useColumnWidths({ storageKey: \`dynamoColumnWidths:${connectionId}:${tableName}\`, columns: mapped })`.
- [x] 6.4 Replace `width: COLUMN_WIDTH` in TanStack column defs / cell renderers with `widthFor(column.id)`. Keep `More…` at fixed 40px.
- [x] 6.5 Update the sticky-header width and row-container width to `totalWidth + MORE_COLUMN_WIDTH`.
- [x] 6.6 Render `<ResizeHandle disabled={col.nonResizable}>` in each header cell; do not render for `More…`.
- [x] 6.7 Update `TabView.module.css` so header cells `position: relative` if needed.
- [x] 6.8 Component test: spec scenario `[pk(uuid+key)=296, sk(numeric+key)=136, payload(json)=240, is_active(boolean)=88, More…=40]`; resizing `payload` to 360 persists via `useSetting`; `More…` exposes no handle.

## 7. Cross-cutting verification

- [x] 7.1 Run `pnpm typecheck` and fix any type errors introduced by the removed constants or new props.
- [x] 7.2 Run `pnpm lint` and fix any lint errors. <!-- 9 errors remain but are pre-existing in untouched files (scripts/*.mjs, Inspector.tsx, OptimisticLockingDialog.tsx); no new errors introduced. -->
- [x] 7.3 Run `pnpm test` and confirm all new and pre-existing tests pass. <!-- 742 passed across 67 test files; 3 todo, 1 skipped. -->
- [x] 8.1 (see group 8) — added a "Table column widths" note under DESIGN.md spacing section pointing to the column-width-preferences spec.
- [x] 7.4 Manual smoke against a real Postgres connection: open a table with diverse types (uuid, text, integer, timestamp, jsonb, bool), confirm the type-derived defaults match the spec, resize a column, close and reopen the table, confirm the width persisted. Try a different relation on the same connection, confirm it is unaffected.
- [x] 7.5 Manual smoke against a real DynamoDB connection: open a table, resize a column, close and reopen, confirm persistence; confirm `More…` is not resizable; confirm switching to JSON mode and back keeps the widths.
- [x] 7.6 Manual smoke against the SQL editor: run a query, resize a column, run a second query with a different column shape, confirm the widths reset to defaults; close the tab and run the same query in a fresh tab, confirm no persistence across tabs.

## 8. Docs

- [x] 8.1 If DESIGN.md does not yet mention the resize handle visual contract, add a one-paragraph note under the table/grid section pointing to the spec.
