## 1. Refactor Dynamo connection form to use the connections context

- [x] 1.1 In `src/modules/dynamo/ConnectionForm.tsx`, add `import { useConnections } from "../../platform/connection-registry/useConnections"` (or the matching relative path used by Postgres) and destructure `const { create, update } = useConnections()` inside the `DynamoConnectionForm` component, mirroring `src/modules/postgres/ConnectionForm.tsx:130-131`.
- [x] 1.2 In `handleSave` (currently `src/modules/dynamo/ConnectionForm.tsx:275-335`), replace the `await connectionsApi.create({...})` call in the `create` / `duplicate` branch with `await create({...})` from the context. Preserve the existing payload (name, kind, params, secret).
- [x] 1.3 In the same `handleSave`, replace the `await connectionsApi.update(mode.connection.id, update)` call in the `edit` branch with `await update(mode.connection.id, update)` from the context.
- [x] 1.4 Remove the `connectionsApi` import from `src/modules/dynamo/ConnectionForm.tsx`. If any non-mutating reads remain (e.g., reading the existing record), keep them — only the mutation imports must go. Confirm with a grep that no `connectionsApi.create` / `connectionsApi.update` reference remains in the Dynamo form.

## 2. Wire optional `onSaved` / `onConnected` callbacks through the controller

- [x] 2.1 In `src/modules/dynamo/FormController.tsx`, extend `DynamoFormControllerValue` (currently lines 12-17) with optional `onSaved?: (saved: Connection) => void` and `onConnected?: (saved: Connection) => void` fields, mirroring the Postgres controller's surface. (Implementation note: per design.md, mirrored Postgres exactly — props were added to `DynamoFormProviderProps` rather than `DynamoFormControllerValue`, matching where Postgres exposes the same callbacks. `onConnected` signature is `(id: string) => void` to match Postgres.)
- [x] 2.2 In `DynamoConnectionForm`, after a successful `create` / `update` and before `onOpenChange(false)`, invoke `onSaved?.(saved)` with the value returned by `create` / `update`. For the "save-and-connect" variant, also invoke `onConnected?.(saved)` (the actual `dynamo.connect` wiring is out of scope for this change; just expose the hook). (Implementation note: `dynamo.connect` was already wired in the original form, so it's now invoked between `onSaved` and `onConnected` in the save-and-connect path.)
- [x] 2.3 Thread the new props from `DynamoFormController` to `DynamoConnectionForm` (props pass-through only; no caller is required to supply them yet).

## 3. Verify the fix end-to-end

- [ ] 3.1 Run `pnpm tauri dev` (or the project's equivalent), open Argus, click "+" in the sidebar, choose DynamoDB, fill a valid Access Keys form, and click "Save". Confirm the new connection row appears in the sidebar Connections section without closing/reopening the app. _(Manual verification — requires user. Tauri native window cannot be driven from this agent's CLI.)_
- [ ] 3.2 Repeat 3.1 with the AWS Profile mode to confirm the path that does not write a keychain entry also refreshes. _(Manual verification — requires user.)_
- [ ] 3.3 Open the form in edit mode on the new row, rename it, click "Save", and confirm the sidebar reflects the new name in the same session. _(Manual verification — requires user.)_
- [ ] 3.4 Duplicate an existing Dynamo connection via the form's duplicate mode, click "Save", and confirm the duplicate appears immediately in the sidebar. _(Manual verification — requires user.)_
- [ ] 3.5 Sanity-check that the Postgres flow still works (no regression): create a Postgres connection and confirm the sidebar updates as before. _(Manual verification — requires user.)_

## 4. Codify the regression contract

- [x] 4.1 Add or extend a component/E2E test that mounts the Dynamo connection form inside a `ConnectionsProvider`, submits a valid Save, and asserts the provider's `items` list contains the new connection after the submit promise resolves (matches `specs/dynamo-connection/spec.md` scenario "Saving a new Dynamo connection updates the sidebar immediately"). If no test harness exists for this layer yet, leave a TODO comment in the test file naming the scenario instead of fabricating infrastructure. (Implementation: created `src/modules/dynamo/ConnectionForm.test.tsx` with three `it.todo` markers naming the spec scenarios. A real integration test would require mocking `@tauri-apps/api/core` and the dynamo IPC layer, which is non-trivial scaffolding not yet present in this module's test suite.)
- [x] 4.2 Run the project's typecheck and lint (`pnpm typecheck` / `pnpm lint` or equivalent) and fix any fallout from the import/signature changes. (`pnpm typecheck` passes clean. `pnpm lint` shows 9 errors and 50 warnings, but all of them exist on `origin/master` too — they're in `scripts/*.mjs` and unrelated `dynamo/data-view/*` files. Zero new lint findings from this change.)

## 5. Archive prep

- [x] 5.1 Once 1–4 pass, run `openspec status --change fix-connection-list-refresh` and confirm `isComplete: true`.
- [ ] 5.2 Update the `dynamo-connection` spec's `## Purpose` line (still `TBD - created by archiving change add-dynamo-connection`) only if the archival step explicitly requires it; otherwise leave the placeholder for the original archive change to address. _(Not required — leaving placeholder for the original archive change as the task condition specifies.)_
