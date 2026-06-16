/**
 * Vanilla external store for saved queries.
 *
 * Design: follows the React useSyncExternalStore contract — subscribers are
 * notified synchronously after every state change. The store is a singleton
 * module-level object so it can be used outside React (e.g. boot sequence)
 * without needing a Provider.
 *
 * Pattern rationale: the project does not use Zustand or any third-party
 * state library. Other stateful modules (connections, activity log) use React
 * Context + useReducer/useState. We follow the same spirit but expose a
 * vanilla subscribe/getSnapshot pair so `useSyncExternalStore` can drive
 * React re-renders without wrapping the entire tree in a Provider — useful
 * because saved-queries state is needed by both the sidebar panel and future
 * editor integrations at different levels of the component tree.
 */

import { savedQueriesApi, type UpdateQueryPatch } from "./api";
import { buildTree, type SavedQuery, type SavedQueryFolder, type TreeNode } from "./types";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface SavedQueriesState {
  folders: SavedQueryFolder[];
  queries: SavedQuery[];
  tree: TreeNode[];
  loading: boolean;
  error: string | null;
}

function computeState(
  folders: SavedQueryFolder[],
  queries: SavedQuery[],
  loading: boolean,
  error: string | null,
): SavedQueriesState {
  return { folders, queries, tree: buildTree(folders, queries), loading, error };
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

let state: SavedQueriesState = computeState([], [], true, null);
const listeners = new Set<() => void>();

function setState(next: Partial<Omit<SavedQueriesState, "tree">>): void {
  const folders = next.folders ?? state.folders;
  const queries = next.queries ?? state.queries;
  const loading = next.loading ?? state.loading;
  const error = next.error ?? null;
  state = computeState(folders, queries, loading, error);
  listeners.forEach((l) => l());
}

async function refresh(): Promise<void> {
  try {
    const { folders, queries } = await savedQueriesApi.list();
    setState({ folders, queries, loading: false, error: null });
  } catch (e) {
    setState({ loading: false, error: (e as Error).message ?? String(e) });
  }
}

// ---------------------------------------------------------------------------
// External store interface (React.useSyncExternalStore contract)
// ---------------------------------------------------------------------------

export const savedQueriesStore = {
  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** Snapshot of current state. Must be stable reference when unchanged. */
  getSnapshot(): SavedQueriesState {
    return state;
  },

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  /** Load all folders and queries from the backend. Call once at app boot. */
  async loadAll(): Promise<void> {
    setState({ loading: true, error: null });
    await refresh();
  },

  // -------------------------------------------------------------------------
  // Folder actions
  // -------------------------------------------------------------------------

  async createFolder(
    parentId: string | null | undefined,
    name: string,
  ): Promise<SavedQueryFolder> {
    const folder = await savedQueriesApi.folderCreate({
      parent_id: parentId ?? undefined,
      name,
    });
    await refresh();
    return folder;
  },

  async updateFolder(id: string, name: string): Promise<SavedQueryFolder> {
    const folder = await savedQueriesApi.folderUpdate({ id, name });
    await refresh();
    return folder;
  },

  async moveFolder(
    id: string,
    targetParentId: string | null,
    targetSortOrder?: number,
  ): Promise<void> {
    await savedQueriesApi.folderMove({
      id,
      target_parent_id: targetParentId,
      target_sort_order: targetSortOrder,
    });
    await refresh();
  },

  async deleteFolder(id: string): Promise<{ folders_deleted: number; queries_deleted: number }> {
    const result = await savedQueriesApi.folderDelete({ id });
    await refresh();
    return result;
  },

  // -------------------------------------------------------------------------
  // Query actions
  // -------------------------------------------------------------------------

  async createQuery(
    folderId: string | null | undefined,
    name: string,
    sql: string,
    lastConnectionId?: string,
  ): Promise<SavedQuery> {
    const query = await savedQueriesApi.create({
      folder_id: folderId ?? null,
      name,
      sql,
      last_connection_id: lastConnectionId,
    });
    await refresh();
    return query;
  },

  async updateQuery(id: string, patch: UpdateQueryPatch): Promise<SavedQuery> {
    const query = await savedQueriesApi.update(id, patch);
    await refresh();
    return query;
  },

  async moveQuery(
    id: string,
    targetFolderId: string | null,
    targetSortOrder?: number,
  ): Promise<void> {
    await savedQueriesApi.move({
      id,
      target_folder_id: targetFolderId,
      target_sort_order: targetSortOrder,
    });
    await refresh();
  },

  async deleteQuery(id: string): Promise<void> {
    await savedQueriesApi.delete({ id });
    await refresh();
  },

  async duplicateQuery(id: string): Promise<SavedQuery> {
    const query = await savedQueriesApi.duplicate({ id });
    await refresh();
    return query;
  },
};
