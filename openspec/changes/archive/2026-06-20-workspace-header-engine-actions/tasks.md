## 1. Extract DynamoRefreshButton into the dynamo module

- [x] 1.1 Move `DynamoRefreshButton` from its inline definition in `packages/app/src/platform/shell/ConnectionRow.tsx` (~lines 979–999) to `packages/app/src/modules/dynamo/tables/DynamoRefreshButton.tsx`, preserving its `{ connectionId }` props and `useDynamoTableCache` behavior.
- [x] 1.2 Re-export `DynamoRefreshButton` from `@/modules/dynamo/tables` (alongside `DynamoConnectionSubtree`).
- [x] 1.3 Update `ConnectionRow.tsx` to import `DynamoRefreshButton` from the dynamo module and remove the inline definition.

## 2. Build the per-engine header-actions dispatcher

- [x] 2.1 Create `packages/app/src/platform/shell/ConnectionHeaderActions.tsx` that reads the connection via `useConnections()` and switches on `connection.kind`, returning `null` when the connection is not found.
- [x] 2.2 Wire each engine case to its exported action components: Postgres (`SchemaPrimaryActions` + `SchemaToolbar`), MySQL (`MysqlSchemaPrimaryActions` + `MysqlSchemaToolbar`), MSSQL (`MssqlSchemaPrimaryActions` + `MssqlSchemaToolbar`), Athena (`AthenaSchemaPrimaryActions` + `AthenaSchemaToolbar`), DynamoDB (`DynamoRefreshButton`).
- [x] 2.3 Add a `default` case that returns `null` (covers `cloudwatch` and any future engine without header actions).

## 3. Render actions in the Workspace identity header

- [x] 3.1 In `WorkspaceShell.tsx` `ConnectionIdentityHeader`, render `<ConnectionHeaderActions connectionId={connectionId} />` inside a new `.identityActions` slot placed after `.identityBody`.
- [x] 3.2 Add `.identityActions` to `WorkspaceShell.module.css` (`display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; margin-left: auto;`) so multiple actions space correctly and right-align.
- [x] 3.3 Confirm against `DESIGN.md` that reused button icon sizes, hover states, and accent color read correctly in the header (always-visible, unlike the hover-revealed row toolbar); adjust the slot styling only if needed.

## 4. Tests

- [x] 4.1 Add a `ConnectionHeaderActions` test verifying each engine renders the expected actions (Postgres/MySQL/MSSQL: query + refresh + visible-schemas picker; Athena: query + refresh; DynamoDB: refresh only).
- [x] 4.2 Add a test for the default case: an engine kind with no header actions (e.g. `cloudwatch`) renders nothing and does not error.
- [x] 4.3 Run the existing `ConnectionRow` and `WorkspaceShell`/sidebar test suites and confirm they remain green after the `DynamoRefreshButton` extraction.

## 5. Verification

- [ ] 5.1 Run the app (`/run`) and, with each engine focused in the Workspace, confirm: New SQL query opens a query tab bound to the focused connection; Refresh reloads the `ConnectionSubtree` schema tree; the visible-schemas picker filters the tree (Postgres/MySQL/MSSQL).
- [ ] 5.2 Verify the header layout at a narrow sidebar width — actions stay visible and the connection name truncates with ellipsis rather than pushing actions off-screen.
