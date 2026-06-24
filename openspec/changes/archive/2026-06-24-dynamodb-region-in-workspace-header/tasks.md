## 1. Resolve the DynamoDB region in the identity header

- [x] 1.1 In `packages/app/src/platform/shell/WorkspaceShell.tsx`, within `ConnectionIdentityHeader`, import and call `useActiveDynamoConnections()` to get `getActive`.
- [x] 1.2 Compute a `region` value only when `connection.kind === "dynamodb"`: prefer `getActive(connectionId)?.region`, fall back to the DynamoDB `connection.params.region`, else `null` (guard params access behind the `dynamodb` kind check, following the existing engine-specific params pattern).
- [x] 1.3 Ensure the hook is always called unconditionally (React rules of hooks) and that non-DynamoDB connections resolve `region` to `null`.

## 2. Render the region in the metadata row

- [x] 2.1 In the `identityMeta` row, render a region element between the engine label and the env dot, only when `region` is truthy.
- [x] 2.2 Add a `title` attribute (e.g. `AWS region: <region>`) to the region element, mirroring the env dot's `title` usage.
- [x] 2.3 Add an `identityRegion` class in `packages/app/src/platform/shell/WorkspaceShell.module.css`, styled per `DESIGN.md` as quiet metadata (consistent with `identityEngine` color/typography and the existing row gap).

## 3. Verify

- [x] 3.1 Focus an active DynamoDB connection and confirm the runtime region (e.g. `us-east-1`) appears alongside the engine label and env dot. — verified manually.
- [x] 3.2 Confirm an inactive DynamoDB connection shows the params region, and a connection with no resolvable region shows no region element and no error. — verified manually.
- [x] 3.3 Confirm non-DynamoDB engines (Postgres, MySQL, MSSQL, Athena, CloudWatch) headers are visually unchanged. — verified manually.
- [x] 3.4 Run the frontend type-check/lint and confirm the header matches `DESIGN.md` (typography, spacing, color). — `pnpm typecheck` (tsc --noEmit) passes clean; chip reuses `--text-xs` / `--text-subtle` tokens per DESIGN.md.
