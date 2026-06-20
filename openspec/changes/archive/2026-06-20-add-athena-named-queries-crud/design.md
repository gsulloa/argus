## Context

Phase 1 (`athena-named-queries`, archived `2026-06-19-add-athena-named-queries`) shipped read-only NamedQuery support:

- `named_queries.rs` exposes `athena_list_named_queries` (account-wide, all workgroups) and `athena_get_named_query` (with body), both acquiring the pooled client via `AthenaClientRegistry::acquire`.
- `SchemaTree.tsx` renders a lazy "Named Queries" branch grouped by workgroup; clicking a leaf calls `athena_get_named_query` then `openAthenaQueryTab(tabs, { connectionId, connectionName, sql })`.
- `globalSchemaCache.ts` caches the listing per connection and exposes `invalidate(connectionId)`.
- `AthenaQueryPayload` is `{ connectionId, connectionName, initialSql }`; `QueryTab.tsx` already computes `isReadOnly = getActive(connectionId)?.read_only`.

Phase 2 adds write operations. Two facts from the codebase constrain the design:

1. **Athena has no backend write-gate today.** Every other engine rejects mutations server-side when read-only (`dynamo/client.rs:94`, `postgres/pool.rs:213`, `mysql/pool.rs:195`, `mssql/edit.rs:491`) with `AppError::Validation("connection is read-only")`. Athena exposes `read_only` only for display; the pool already has `AthenaClientRegistry::read_only_for(id) -> Option<bool>`. Phase 2 introduces the first Athena write-gate.
2. **AWS `UpdateNamedQuery` is narrow.** Its inputs are `NamedQueryId`, `Name`, `QueryString`, `Description` only — there is **no** `Database` or `WorkGroup` parameter. A NamedQuery cannot be moved between databases or workgroups after creation. `CreateNamedQuery` takes `Name`, `Database`, `QueryString`, `Description?`, `WorkGroup?`. `DeleteNamedQuery` takes `NamedQueryId`.

## Goals / Non-Goals

**Goals:**
- Create, update, and delete NamedQueries from within Argus, gated by `read_only` both in UI and backend.
- Let a query tab "remember its origin" so the toolbar offers Update-in-place vs. Create-new.
- Surface partial-IAM failures inline at the point of action; never probe permissions a priori.
- Keep the branch listing fresh: invalidate + refetch after each successful mutation.

**Non-Goals:**
- Cross-workgroup operations beyond Create's workgroup picker (Update/Delete act on the query's own id).
- Catalogs other than `AwsDataCatalog`.
- Moving a NamedQuery's database or workgroup after creation (AWS does not support it).
- CloudWatch or other engines.

## Decisions

### D1 — Workgroup on Create: picker defaulting to the connection's workgroup
The connection's `AthenaParams.workgroup` (required, defaults `"primary"`) seeds the picker, but the user may choose another. Rationale: phase 1's model is account-wide and a query's workgroup is intrinsic to it; forcing the connection's workgroup would surprise users who browse queries from many workgroups in one tree. The picker is populated from the workgroups already enumerated for the listing (or, minimally, the connection's workgroup as the sole pre-filled option). *Alternative considered:* silently use the connection workgroup — rejected as too hidden given the cross-workgroup tree.

### D2 — Database on Create: default to the tab's active database
The modal pre-fills `database` from the tab's current context (the active database the editor is scoped to) and leaves it editable. Rationale: most "save this query" flows happen while working inside a database; defaulting there minimizes typing. *Alternative:* connection default or forced pick-from-list — rejected as more friction for the common case.

### D3 — One modal, database field hidden in Update mode
A single `NamedQueryModal` serves both flows. In Create mode it shows name / description / database / workgroup. In Update mode (`origin` present) it shows name / description only — database and workgroup are immutable per AWS and are displayed read-only (or omitted). Rationale: avoids two near-duplicate components; the AWS API shape *is* the difference, so mode-gating the fields models it directly. *Alternative:* two modals — rejected as duplication.

### D4 — Tab origin linkage via optional `AthenaQueryPayload.origin`
Extend the payload with:

```ts
origin?: {
  namedQueryId: string;
  name: string;
  description?: string;
  database: string;
  workGroup: string;
}
```

- Clicking a branch leaf (and the context-menu **Edit**) opens a tab with `origin` set from the NamedQuery.
- Toolbar button: `origin == null` → "Save as Named Query" (Create); `origin != null` → "Update '<name>'" (Update).
- **After a successful Create, the originating tab adopts the new id as its `origin`** so the next save is an Update. This requires updating the live tab payload (via the tabs registry) post-create; if in-place payload mutation is not supported by the registry, the fallback is to set local component state mirroring `origin` that supersedes the payload. The chosen mechanism is a small implementation detail captured in tasks.

`isPayload` stays backward compatible: `origin` is optional, so existing/persisted tabs without it remain valid Create tabs.

### D5 — Backend write-gate mirrors the other engines
Each new command, after `acquire`, checks read-only and returns the canonical error before any AWS call:

```rust
if registry.read_only_for(&id).await == Some(true) {
    return Err(AppError::Validation("connection is read-only".into()));
}
```

Rationale: defense in depth + consistency with dynamo/postgres/mysql/mssql; the UI hides the buttons but the backend is the source of truth. AWS SDK errors map through the existing `sdk_err_to_app`, so access-denied (partial IAM) flows back as `AppError::Aws` and is rendered inline by the caller.

### D6 — Command surface
Three commands in `named_queries.rs`, returning the affected/created summary so the frontend can update the tab origin and cache without a full refetch when convenient:

- `athena_create_named_query(id, name, query_string, database, work_group, description?) -> NamedQueryDetail` (or at least `{ named_query_id, work_group, database }`).
- `athena_update_named_query(id, named_query_id, name, query_string, description?) -> ()`.
- `athena_delete_named_query(id, named_query_id) -> ()`.

After any success the frontend calls `athenaSchemaCache.invalidate(connectionId)` and the branch refetches on next render/expand.

### D7 — Context menu = Edit + Delete; Delete confirms
The ⋯ menu on a NamedQuery node offers **Edit** (open/focus a linked tab — same effect as click) and **Delete** (confirmation modal showing the query name, then `athena_delete_named_query`). When the connection is read-only, both the Save/Update toolbar action and the Delete menu item are hidden/disabled; Edit (read path) remains available.

## Risks / Trade-offs

- **Tab payload mutation after Create** → If the tabs registry does not support in-place payload updates, fall back to component-local origin state; either way "save again becomes Update" must hold. Captured as an explicit task with a verification step.
- **Workgroup picker source** → If enumerating workgroups for the picker is costly or fails, degrade to a single pre-filled option (the connection's workgroup) rather than blocking Create.
- **Stale branch after mutation** → Mitigated by `invalidate(connectionId)` + refetch; the same path phase 1 already uses on disconnect/refresh.
- **Partial IAM (write verbs missing)** → No a-priori probe; the AWS access-denied error surfaces inline at the action. Consistent with phase 1; users with list-only IAM see actions but get a clear error on use.
- **Concurrent edits / external deletion** → Update/Delete against an id deleted in the console returns an AWS error surfaced inline; acceptable for v1 (no optimistic-lock handling).

## Migration Plan

Additive only. New optional payload field is backward compatible with persisted tabs. New IAM verbs (`athena:CreateNamedQuery`, `athena:UpdateNamedQuery`, `athena:DeleteNamedQuery`) are required only for the new actions; absent them, listing/get still work and writes fail inline. No data migration. Rollback = revert the change; existing read-only behavior is untouched.

## Open Questions

- None blocking. Tab-payload update mechanism (registry mutation vs. local state) to be settled during implementation per D4.
