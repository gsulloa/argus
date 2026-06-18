## Why

Saving a new DynamoDB connection persists the row but the sidebar Connections list does not refresh — the new entry only appears after the app is closed and reopened. The Postgres form already gets this right; the Dynamo form bypasses the `useConnections()` context and calls `connectionsApi.create()` directly, so the React state that backs the sidebar is never updated. This violates the `dynamo-connection` spec scenario "Filling and saving an access-keys connection" which requires the new connection to appear in the sidebar after Save.

## What Changes

- Refactor `src/modules/dynamo/ConnectionForm.tsx` to call `create()` / `update()` from `useConnections()` instead of `connectionsApi.create()` / `connectionsApi.update()` directly, mirroring the working Postgres pattern.
- Stop importing `connectionsApi` from the Dynamo form (it should only be consumed through the context hook).
- Wire `onSaved` / `onConnected` callbacks through `DynamoFormController` so the controller can react to a successful save the same way the Postgres controller does (e.g. for the future "Save & Connect" flow), without coupling refresh behavior to the controller.
- Verify behavior end-to-end: after Save (and after Save & Connect) the sidebar shows the new Dynamo connection without an app restart.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `dynamo-connection`: add a requirement that the Dynamo connection form MUST persist via the `useConnections()` context (not the raw `connectionsApi`) so the sidebar list reflects creates/updates/duplicates within the same app session without a restart. This codifies the regression contract that the existing "Filling and saving an access-keys connection" scenario already implies ("the connection appears in the sidebar").

## Impact

- **Code:** `src/modules/dynamo/ConnectionForm.tsx`, `src/modules/dynamo/FormController.tsx`. No backend / Rust changes. No schema or IPC contract changes.
- **Behavior:** Dynamo connection list now refreshes immediately on create/update/duplicate, matching Postgres and the existing spec.
- **Risk:** Low. The change replaces a direct API call with the already-tested context method that wraps the same API plus a `refresh()`.
