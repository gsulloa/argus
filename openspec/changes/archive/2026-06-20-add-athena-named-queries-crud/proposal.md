## Why

Phase 1 made Athena NamedQueries read-only: the sidebar lists them across all workgroups and clicking one opens its SQL in a tab. Users can read saved queries but cannot manage them from Argus — to save a new query, rename one, fix its body, or delete it they must leave for the AWS console. Phase 2 closes that loop with full create / update / delete over the account's NamedQueries.

## What Changes

- **Create** — a "Save as Named Query" action in the Athena `QueryTab` toolbar takes the editor's current SQL and opens a modal asking for `name`, optional `description`, a `database` (defaulting to the tab's active database), and a `workgroup` (a picker defaulting to the connection's configured workgroup) → `athena:CreateNamedQuery`.
- **Update** — when a tab is linked to an origin NamedQuery, the toolbar action reads "Update '<name>'" instead and calls `athena:UpdateNamedQuery`, replacing `name` + `description` + `query_string` in place. The same modal is reused with the `database` field hidden (AWS cannot move a NamedQuery's database or workgroup on update).
- **Tab origin linkage** — clicking a NamedQuery node in the branch opens a tab linked to that query's id; a successful Create also re-links the originating tab to the new id, so the next save becomes an Update.
- **Delete** — an Edit/Delete context menu (⋯) on each NamedQuery node in the branch; Delete shows a confirmation modal with the query name → `athena:DeleteNamedQuery`. Edit opens (or focuses) the query in a linked tab.
- **read-only gating** — all three mutations are blocked when the connection is `read_only`: hidden/disabled in the UI **and** rejected server-side (Athena currently has no backend write-gate; this change adds one).
- **Partial-IAM handling** — no a-priori permission probing; AWS access-denied errors surface inline at the point of action, consistent with phase 1's listing behavior.
- **Cache invalidation** — the per-connection NamedQueries listing cache is invalidated and the branch re-fetched after every successful create / update / delete.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `athena-named-queries`: adds create, update, and delete of NamedQueries (backend commands gated by `read_only`), tab-origin linkage to distinguish Update from Create, and the branch context menu with delete confirmation. Phase 1's listing/get/branch requirements are unchanged.

## Impact

- **Backend** — `packages/app/src-tauri/src/modules/athena/named_queries.rs`: three new Tauri commands (`athena_create_named_query`, `athena_update_named_query`, `athena_delete_named_query`), each acquiring the pooled client and checking `AthenaClientRegistry::read_only_for` before mutating. Command registration in the Tauri builder.
- **Frontend** — `modules/athena/api.ts` (three new wrappers); `sql/QueryTab.tsx` + `AthenaQueryPayload` (optional `origin`, toolbar Save/Update button + modal); `openAthenaQueryTab.ts` (carry `origin`); `schema/SchemaTree.tsx` (context menu, delete confirmation, click links origin); `schema/globalSchemaCache.ts` (invalidate after mutation); `types.ts` (new request/response types).
- **IAM** — operators need `athena:CreateNamedQuery`, `athena:UpdateNamedQuery`, `athena:DeleteNamedQuery` in addition to the phase-1 list/get verbs. Documented in README AI/Athena section.
- **No breaking changes** — phase 1 behavior is preserved; new payload field is optional.
