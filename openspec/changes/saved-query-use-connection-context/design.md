## Context

The first-save flow for SQL editors renders `SaveAsModal` (`packages/app/src/modules/saved-queries/SaveAsModal.tsx`), shared by the Postgres, MySQL, MSSQL, and Athena `QueryTab` components. The modal offers a **Name** field and a **Folder** tree picker built from the local `saved_query_folders` table, plus a `+ New folder…` affordance.

However, each editor's `handleSaveAsConfirm` destructures only `{ name }` from the modal result and calls `contextApi.saveQuery(connId, name, sql, { mode: "create" })` — the query is written to the **connection's linked context folder** on disk via the `context_save_query` command. The picked `folderId` is silently discarded. Every `QueryTab` also loads `savedQueries:lastUsedFolder` in `openSaveAsModal` purely to seed a picker whose value is never used.

The result is a prompt that asks the user to make a decision with no effect. The user wants the folder prompt gone: a new saved query should simply go to the connection's context folder.

## Goals / Non-Goals

**Goals:**
- Remove the folder picker (and `+ New folder…`) from the first-save modal across all four editors.
- Keep the Name field — a name is still required to derive the query file slug.
- Stop reading/persisting `savedQueries:lastUsedFolder` in the first-save path.
- Leave the observable save destination unchanged: the connection's context folder.

**Non-Goals:**
- No change to `context_save_query` or any backend/IPC command.
- No change to the Saved Queries panel, `saved_query_folders`, or how users organize already-saved queries there.
- No change to subsequent-save behavior or the dirty/close-confirm flows.
- No new context-folder linking UX — the existing "no linked context folder" toast is preserved.

## Decisions

**Decision: Reduce `SaveAsModal` to a Name-only dialog rather than deleting it.**
The modal is still needed to collect the query name (required, filesystem-slug source). Removing just the folder UI is the smallest change that satisfies the request and keeps the confirm contract simple.
- Alternative considered: drop the modal entirely and auto-name the query from the tab title. Rejected — users expect to name a query on first save, and auto-slugging the default "Untitled" title would produce poor filenames and silent collisions.

**Decision: Change `onConfirm` to `(result: { name: string }) => void`.**
Drop `folderId` from the result type and `defaultFolderId` from the props. All four callers already ignore `folderId`, so the caller changes are mechanical (remove the unused destructured field and the `defaultFolderId`/`defaultSaveFolder` plumbing).
- Alternative considered: keep the prop shape and just hide the UI. Rejected — leaves dead state and a misleading type; the whole point is to remove the vestigial concept.

**Decision: Remove the `savedQueries:lastUsedFolder` read from `openSaveAsModal` in each `QueryTab`.**
Nothing consumes the value once the picker is gone. The settings key itself can remain in storage harmlessly (still written/used by the Saved Queries panel if applicable); this change only stops the first-save path from reading it.

**Decision: Apply to Athena too, even though no `*-sql-editor` spec documents its folder picker.**
Athena shares `SaveAsModal`; the component change affects it automatically. The Athena `QueryTab` gets the same caller cleanup for consistency, tracked in tasks but with no spec delta.

## Risks / Trade-offs

- **[Stale CSS / dead component `FolderPickerNode`]** → Remove `FolderPickerNode` and the folder-specific classes from `SaveAsModal.module.css` in the same change to avoid leaving dead code.
- **[Users who relied on the folder picker to organize context queries]** → No real loss: the picker never affected where the query was saved. Context-folder layout is determined by the engine subtree, not this picker.
- **[Spec vs. code divergence surfaced]** → The pre-existing specs described `saved_queries_create`; the code already uses `context_save_query`. The modified requirements now describe the actual context-folder save for the first-save path, reducing (not adding) divergence.

## Migration Plan

Pure frontend refactor; no data migration and no rollout gating. Rollback is a straight revert of the component and caller edits. No persisted data shape changes.
