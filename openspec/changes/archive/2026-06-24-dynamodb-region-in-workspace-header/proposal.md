## Why

In-app feedback (#184): when operating a DynamoDB connection, there is no quick way to see which AWS region the active connection targets. Region is the single most error-prone dimension across DynamoDB environments (e.g. `us-east-1` vs `us-west-2`), and confusing one region for another can lead to reading or editing the wrong data. The Workspace identity header already shows the engine label and a prod/non-prod dot, but never the region — so the user must open the connection form to confirm it.

## What Changes

- The Workspace sidebar identity header SHALL display the **active AWS region** (e.g. `us-east-1`) for a focused **DynamoDB** connection, alongside the existing engine label and environment dot.
- The region shown reflects the **active connection's runtime region** (`ActiveDynamoConnection.region`), so it matches what the app is actually querying — not stale form input.
- When the DynamoDB connection is not yet active (region unknown at runtime), the header falls back to the region configured in the connection params (`DynamoParams.region`); if neither is available, no region chip is shown (no error, no empty chip).
- Styling follows `DESIGN.md` and reuses the existing `identityMeta` row typography/spacing — the region is a quiet metadata chip, not a loud badge.
- Non-DynamoDB engines are unaffected; their header is unchanged in this change.

## Capabilities

### New Capabilities
<!-- None — this extends an existing capability. -->

### Modified Capabilities
- `dual-window-shell`: the "Workspace identity header" requirement is extended so the header surfaces the active AWS region for DynamoDB connections as connection metadata (in addition to the existing per-engine actions / engine label / environment indicator).

## Impact

- **Frontend**: `packages/app/src/platform/shell/WorkspaceShell.tsx` (`ConnectionIdentityHeader`) and `WorkspaceShell.module.css` (new metadata chip style under `identityMeta`).
- **Data sources**: reads `useActiveDynamoConnections()` (`ActiveDynamoConnection.region`) and `DynamoParams.region` from `modules/dynamo/types.ts` — no new backend commands, no schema changes.
- **No breaking changes**; no migrations; no API additions.
