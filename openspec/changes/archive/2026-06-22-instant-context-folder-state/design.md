## Context

`ContextFolderRow` is a controlled component: it has no internal `contextPath` state and derives its render state (`none` | `linked` | `missing`) purely from the `contextPath` prop (`ContextFolderRow.tsx:192-197`). Its link/unlink/create handlers call the backend (`contextApi.linkFolder` / `unlink`, keyed by `connectionId`) — which persists `context_path` on the connection immediately — and then invoke `onChanged()`. The row never updates its own path; it waits for the parent to re-pass a fresh `contextPath`.

Each engine `ConnectionForm` mounts the row in edit mode like this (Postgres `ConnectionForm.tsx:475-486`, mirrored in mysql/mssql/dynamo/athena/cloudwatch):

```tsx
<ContextFolderRow
  key={contextTick}
  connectionId={initial.id}
  contextPath={initial.context_path ?? null}   // ← stale snapshot
  onChanged={() => {
    setContextTick((t) => t + 1);               // remount
    void refreshConnections();                  // refresh the registry store
  }}
/>
```

The bug: `contextPath` is read from the `initial` (Postgres/MySQL/MSSQL/Athena/CloudWatch) or `mode.connection` (Dynamo) **prop**, which is the snapshot the parent passed when the form opened. `onChanged` calls `refreshConnections()`, which updates the `useConnections()` store (`useConnections.tsx:43-59`) — but the form keeps rendering from the stale prop. The `contextTick` bump only remounts the row against the *same* stale `contextPath`, so `state` stays `"none"` and the **Sync schema…** button (rendered only in the `"linked"` branch) never appears. It only shows once the form is closed and reopened, because the parent then re-derives `initial`/`mode.connection` from the refreshed store. This is exactly the behavior in #174.

`useConnections()` is a reactive React context store; `refreshConnections()` calls `setItems(...)` and re-renders every consumer. `ConnectionForm` already calls `useConnections()` (it destructures `create`, `update`, `refresh`). So the live, post-link connection record is already available in the form — it just isn't the source for `contextPath`.

## Goals / Non-Goals

**Goals:**
- Linking / creating-and-linking / unlinking a context folder updates the row's state immediately within the open config window.
- Fix is uniform across all six engine `ConnectionForm`s.
- No backend, command, or on-disk-format changes.

**Non-Goals:**
- Allowing context-folder linking during the *create* (not-yet-saved) flow — the link command requires a persisted connection id; the "Save this connection first…" placeholder stays.
- Refactoring `ContextFolderRow` to hold internal state (it stays controlled).
- Any change to sync, manifest parsing, or registry subscription behavior.

## Decisions

### Decision: Source `contextPath` from the live registry record, not the opening snapshot

In each `ConnectionForm`, look up the current connection from `useConnections().items` by id and pass *its* `context_path` to `ContextFolderRow`:

```tsx
const { items, /* … */ refresh: refreshConnections } = useConnections();
const liveConn = items.find((c) => c.id === initial.id) ?? initial;
// …
<ContextFolderRow
  connectionId={initial.id}
  contextPath={liveConn.context_path ?? null}
  onChanged={() => { void refreshConnections(); }}
/>
```

Because `useConnections()` is reactive, `refreshConnections()` updates `items`, the form re-renders, `liveConn.context_path` becomes the new path, and the row's `state` flips to `"linked"` — all without closing the window. Fall back to `initial`/`mode.connection` when the id isn't found in the store yet (covers the brief window before the first refresh and the non-Tauri/empty-store case).

**Alternative considered — keep the `contextTick` remount, just feed it live data:** The `key={contextTick}` remount was the previous attempt to force fresh state; it doesn't help because the *data* was stale, not the component instance. Sourcing live data makes the remount unnecessary. We can drop `contextTick` (and its `setContextTick`) since the row reacts to the `contextPath` prop change on its own. Keeping it would be harmless but is dead weight; removing it is cleaner. Either is acceptable — the normative fix is the live data source.

**Alternative considered — make `ContextFolderRow` hold internal `contextPath` state seeded from the prop:** Rejected. It duplicates state that already lives authoritatively in the registry store, reintroduces a sync problem (prop vs. internal state), and spreads the fix into the shared component instead of fixing it once at the data source.

### Decision: Apply the same edit per engine, leave create-mode gating intact

All six forms share the identical pattern, so the same two-line change (derive `liveConn`, pass `liveConn.context_path`) applies to each. The create-mode branch ("Save this connection first to link a context folder") is unchanged because linking still requires a persisted connection id.

## Risks / Trade-offs

- **[`items.find` returns `undefined` transiently]** → Fall back to the opening snapshot (`?? initial` / `?? mode.connection`), so the row always has a defined source and never crashes; the live value takes over on the next render after refresh.
- **[Dynamo uses a different prop shape (`mode.connection`)]** → Handle per-form: derive `liveConn` from the correct snapshot field in each file rather than assuming a uniform prop name.
- **[Removing `contextTick` could affect an unrelated remount]** → `contextTick` is used only as the `ContextFolderRow` key in each form; confirm no other consumer before removing, otherwise leave it in place. Low risk.
- **[Edit-only fix doesn't address the user's "al agregar" wording]** → The reporter's flow routes through edit mode after the first save; the create flow remains intentionally gated. Documented as a non-goal.

## Migration Plan

Pure frontend behavior fix; no data migration, no rollback steps beyond reverting the diff. Verify by linking a folder in an open config window and confirming the **Sync schema…** button appears without closing the window, for at least Postgres and DynamoDB (the reporter's active engine).
