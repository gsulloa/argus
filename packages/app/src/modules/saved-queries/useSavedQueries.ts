import { useSyncExternalStore } from "react";
import { savedQueriesStore } from "./store";
import type { TreeNode, SavedQuery, SavedQueryFolder } from "./types";
import type { UpdateQueryPatch } from "./api";

export interface SavedQueriesActions {
  loadAll: () => Promise<void>;
  // Folder
  createFolder: (parentId: string | null | undefined, name: string) => Promise<SavedQueryFolder>;
  updateFolder: (id: string, name: string) => Promise<SavedQueryFolder>;
  moveFolder: (id: string, targetParentId: string | null, targetSortOrder?: number) => Promise<void>;
  deleteFolder: (id: string) => Promise<{ folders_deleted: number; queries_deleted: number }>;
  // Query
  createQuery: (
    folderId: string | null | undefined,
    name: string,
    sql: string,
    lastConnectionId?: string,
  ) => Promise<SavedQuery>;
  updateQuery: (id: string, patch: UpdateQueryPatch) => Promise<SavedQuery>;
  moveQuery: (id: string, targetFolderId: string | null, targetSortOrder?: number) => Promise<void>;
  deleteQuery: (id: string) => Promise<void>;
  duplicateQuery: (id: string) => Promise<SavedQuery>;
}

export interface UseSavedQueriesResult {
  /** Full flat list of folders (mirrors backend response). */
  folders: SavedQueryFolder[];
  /** Full flat list of queries (mirrors backend response). */
  queries: SavedQuery[];
  /** Nested tree derived from folders + queries. */
  tree: TreeNode[];
  /** True while the initial or subsequent load is in progress. */
  loading: boolean;
  /** Error message if the last load failed, null otherwise. */
  error: string | null;
  actions: SavedQueriesActions;
}

/** Stable actions object — never changes identity between renders. */
const actions: SavedQueriesActions = {
  loadAll: () => savedQueriesStore.loadAll(),
  createFolder: (parentId, name) => savedQueriesStore.createFolder(parentId, name),
  updateFolder: (id, name) => savedQueriesStore.updateFolder(id, name),
  moveFolder: (id, targetParentId, targetSortOrder) =>
    savedQueriesStore.moveFolder(id, targetParentId, targetSortOrder),
  deleteFolder: (id) => savedQueriesStore.deleteFolder(id),
  createQuery: (folderId, name, sql, lastConnectionId) =>
    savedQueriesStore.createQuery(folderId, name, sql, lastConnectionId),
  updateQuery: (id, patch) => savedQueriesStore.updateQuery(id, patch),
  moveQuery: (id, targetFolderId, targetSortOrder) =>
    savedQueriesStore.moveQuery(id, targetFolderId, targetSortOrder),
  deleteQuery: (id) => savedQueriesStore.deleteQuery(id),
  duplicateQuery: (id) => savedQueriesStore.duplicateQuery(id),
};

/**
 * Subscribe to the saved-queries store and return the current tree + actions.
 *
 * Uses `useSyncExternalStore` to ensure tearing-free reads in concurrent mode.
 * The actions object is stable (module-level singleton) so it never causes
 * unnecessary re-renders in child components that only consume actions.
 */
export function useSavedQueries(): UseSavedQueriesResult {
  const snapshot = useSyncExternalStore(
    savedQueriesStore.subscribe,
    savedQueriesStore.getSnapshot,
    // Server snapshot: return empty state (Tauri apps never SSR, but vitest
    // may run outside a Tauri context).
    savedQueriesStore.getSnapshot,
  );

  return {
    folders: snapshot.folders,
    queries: snapshot.queries,
    tree: snapshot.tree,
    loading: snapshot.loading,
    error: snapshot.error,
    actions,
  };
}
