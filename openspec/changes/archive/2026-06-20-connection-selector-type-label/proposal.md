## Why

The connection selector dropdown in the SQL editor toolbar lists every registered connection across all engines (Postgres, MySQL, MSSQL, DynamoDB, Athena) by name and status dot only. When connections from different engines share similar names — or a user is unsure which engine a connection targets — name alone is ambiguous, and there is no engine icon in this control to disambiguate. Surfacing the engine type as text removes that ambiguity at the point of selection.

## What Changes

- Each item in the connection selector dropdown now renders the human-readable engine type (e.g. `PostgreSQL`, `MySQL`, `SQL Server`, `DynamoDB`, `Athena`) as a muted, right-aligned label beside the connection name.
- The label reuses the existing `engineLabel(kind)` helper (`@/platform/shell/ConnectionRail`); no new label strings are introduced.
- Styling follows the design system: neutral `--text-subtle`, 10px, no accent color, `flex-shrink: 0` so it never collapses the name's ellipsis.
- The trigger button (collapsed state) is unchanged — only the open dropdown list gains the type label.

## Capabilities

### New Capabilities
<!-- None — this extends an existing capability. -->

### Modified Capabilities
- `postgres-sql-editor`: the "Connection selector in editor toolbar" requirement gains a behavior — each dropdown item displays the connection's engine type label alongside the name and status dot.

## Impact

- `packages/app/src/modules/postgres/sql/ConnectionSelector.tsx` — renders the type label per item; imports `engineLabel`.
- `packages/app/src/modules/postgres/sql/ConnectionSelector.module.css` — adds the `.itemType` style.
- No backend, API, or data-model changes. No new dependencies. Purely additive UI; no breaking changes.
