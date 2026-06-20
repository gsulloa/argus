## 1. Backend — write commands (read-only gated)

- [x] 1.1 Add request/response types in `named_queries.rs` as needed (reuse `NamedQueryDetail`; add a lightweight created-identity struct if `Detail` is heavier than needed).
- [x] 1.2 Implement `athena_create_named_query(id, name, query_string, database, work_group, description?)`: acquire pooled client; if `registry.read_only_for(&id).await == Some(true)` return `AppError::Validation("connection is read-only")` before any AWS call; call `athena:CreateNamedQuery`; map SDK errors via `sdk_err_to_app`; return the new `{ named_query_id, work_group, database }`.
- [x] 1.3 Implement `athena_update_named_query(id, named_query_id, name, query_string, description?)`: same acquire + read-only gate; call `athena:UpdateNamedQuery` (no database/workgroup params); map errors.
- [x] 1.4 Implement `athena_delete_named_query(id, named_query_id)`: same acquire + read-only gate; call `athena:DeleteNamedQuery`; map errors.
- [x] 1.5 Register the three commands in the Tauri builder (`invoke_handler`) alongside the existing athena named-query commands.
- [x] 1.6 Unit-test the read-only gate path for each command (mirror the dynamo/postgres `read-only` assertion pattern) and any new pure helpers.

## 2. Frontend — API + types

- [x] 2.1 Add `createNamedQuery`, `updateNamedQuery`, `deleteNamedQuery` wrappers to `modules/athena/api.ts` (route through `call`, snake/camel arg mapping consistent with existing wrappers).
- [x] 2.2 Add request/response types to `modules/athena/types.ts` (created-query identity; reuse `AthenaNamedQueryDetail`/`Summary` where possible).

## 3. Frontend — tab origin linkage

- [x] 3.1 Extend `AthenaQueryPayload` with optional `origin: { namedQueryId, name, description?, database, workGroup }`; keep `isPayload` backward compatible (origin optional).
- [x] 3.2 Update `openAthenaQueryTab` to accept and pass through an optional `origin`.
- [x] 3.3 In `SchemaTree.tsx`, set `origin` when opening a tab from a NamedQuery leaf (click) so opened tabs are linked.

## 4. Frontend — Save / Update toolbar + modal

- [x] 4.1 Build a `NamedQueryModal` serving both modes: Create shows name/description/editable database (pre-filled with the tab's active database)/workgroup picker (defaulting to connection workgroup); Update shows name/description only, database & workgroup non-editable.
- [x] 4.2 Add the conditional toolbar action in `QueryTab.tsx`: "Save as Named Query" when `origin` is null → Create; "Update '<name>'" when `origin` present → Update. Use the editor's current SQL as `query_string`.
- [x] 4.3 Gate the toolbar action on `isReadOnly` (hide/disable) — already-computed `getActive(connectionId)?.read_only`.
- [x] 4.4 After a successful Create, re-link the tab: adopt the returned id as `origin` (mutate tab payload via the registry, or component-local origin state if the registry can't mutate payload) so the next save is an Update. Verify the button flips to "Update".
- [x] 4.5 Surface AWS errors (including access-denied) inline via the existing toast/error path; no a-priori permission check.

## 5. Frontend — branch context menu + delete

- [x] 5.1 Add a ⋯ context menu to each NamedQuery leaf in `SchemaTree.tsx` with Edit and Delete (Edit = open/focus a linked tab, same as click).
- [x] 5.2 Implement Delete: confirmation modal showing the query name → `deleteNamedQuery`.
- [x] 5.3 Hide/disable Delete (and the toolbar Save/Update) when the connection is read-only; keep the read-only Edit/open path available.
- [x] 5.4 After a successful create / update / delete, call `athenaSchemaCache.invalidate(connectionId)` and trigger a branch re-fetch.

## 6. Docs + QA

- [x] 6.1 Document the new IAM verbs (`athena:CreateNamedQuery`, `athena:UpdateNamedQuery`, `athena:DeleteNamedQuery`) in README's Athena/AI section.
- [x] 6.2 QA: read-only connection (actions hidden/disabled, backend rejects); partial-IAM (write verb missing → inline error, listing still works); delete confirmation; Create→re-link→Update flow; cache refresh after each mutation.
- [x] 6.3 Verify against `DESIGN.md` — modal, context menu, and toolbar button styling (fonts, accent, border radii, no AI-slop).
