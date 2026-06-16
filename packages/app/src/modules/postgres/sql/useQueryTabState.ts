import { useCallback, useEffect, useRef, useState } from "react";
import { savedQueriesStore } from "@/modules/saved-queries/store";

/**
 * Per-tab runtime state for a `postgres-query` tab.
 *
 * Separates *current* (mutable, runtime) values from *saved* (snapshot of the
 * persisted record) values so that dirty-state comparisons are straightforward.
 *
 * NOTE: `savedQueryId` is also stored in the tab payload so that
 * `openQueryTab` can find an already-open tab without needing per-tab state.
 * This hook owns the authoritative runtime copy.
 *
 * Hydration: when `savedQueryId` is provided on init, the hook reads from
 * the saved-queries store to populate `savedSql`, `savedName`, and
 * `savedFolderId`. If the store is still loading, it subscribes and retries.
 */
export interface QueryTabState {
  /** The connection currently selected in the toolbar selector (runtime, mutable). */
  currentConnectionId: string | null;
  currentConnectionName: string | null;
  /** Bound saved-query id, or null if this is an ad-hoc scratch tab. */
  savedQueryId: string | null;
  /** SQL at the time of the last successful save (empty string if never saved). */
  savedSql: string;
  /** Name at the time of the last successful save (empty string if never saved). */
  savedName: string;
  /**
   * Folder the saved query lives in (null if never saved or at root).
   * Hydrated from the saved-queries store on mount when savedQueryId is set.
   */
  savedFolderId: string | null;
  /**
   * User-typed override of the tab title while the user is renaming inline.
   * null means the tab title is derived from savedName (or "Query N").
   * TODO(saved-queries fase 5): wire to the inline-rename flow.
   */
  editedName: string | null;
}

export interface QueryTabStateActions {
  setCurrentConnection(id: string | null, name: string | null): void;
  setSavedSnapshot(opts: {
    savedQueryId: string;
    savedSql: string;
    savedName: string;
    savedFolderId: string | null;
  }): void;
  /**
   * Alias for `setSavedSnapshot` — called after a successful save/create to
   * update the snapshot that dirty-state comparisons are made against.
   */
  setSaved(opts: {
    savedQueryId: string;
    savedSql: string;
    savedName: string;
    savedFolderId: string | null;
  }): void;
  /** Update savedSql/savedName after a subsequent save (overwrite). */
  updateSavedSnapshot(opts: { savedSql: string; savedName: string }): void;
  setEditedName(name: string | null): void;
}

export interface UseQueryTabStateResult {
  state: QueryTabState;
  actions: QueryTabStateActions;
}

export interface QueryTabStateInit {
  initialConnectionId?: string;
  initialConnectionName?: string;
  savedQueryId?: string;
}

export function useQueryTabState(init: QueryTabStateInit): UseQueryTabStateResult {
  const [state, setState] = useState<QueryTabState>(() => ({
    currentConnectionId: init.initialConnectionId ?? null,
    currentConnectionName: init.initialConnectionName ?? null,
    savedQueryId: init.savedQueryId ?? null,
    savedSql: "",
    savedName: "",
    savedFolderId: null,
    editedName: null,
  }));

  // Keep a stable ref to avoid stale closures in callbacks.
  const stateRef = useRef(state);
  stateRef.current = state;

  const setCurrentConnection = useCallback(
    (id: string | null, name: string | null) => {
      setState((prev) => ({ ...prev, currentConnectionId: id, currentConnectionName: name }));
    },
    [],
  );

  const setSavedSnapshot = useCallback(
    (opts: {
      savedQueryId: string;
      savedSql: string;
      savedName: string;
      savedFolderId: string | null;
    }) => {
      setState((prev) => ({
        ...prev,
        savedQueryId: opts.savedQueryId,
        savedSql: opts.savedSql,
        savedName: opts.savedName,
        savedFolderId: opts.savedFolderId,
      }));
    },
    [],
  );

  // Alias for setSavedSnapshot — used by save/create flows.
  const setSaved = setSavedSnapshot;

  const updateSavedSnapshot = useCallback(
    (opts: { savedSql: string; savedName: string }) => {
      setState((prev) => ({
        ...prev,
        savedSql: opts.savedSql,
        savedName: opts.savedName,
      }));
    },
    [],
  );

  const setEditedName = useCallback((name: string | null) => {
    setState((prev) => ({ ...prev, editedName: name }));
  }, []);

  // ---------------------------------------------------------------------------
  // 9.1 / Fase 5 hydration: when a savedQueryId is provided on mount, read the
  // saved-queries store to populate savedSql, savedName, and savedFolderId.
  // This runs once on mount (stable savedQueryId from init). If the store is
  // still loading, the effect subscribes and retries when data arrives.
  // ---------------------------------------------------------------------------
  const savedQueryId = init.savedQueryId;
  useEffect(() => {
    if (!savedQueryId) return;

    function tryHydrate() {
      const snapshot = savedQueriesStore.getSnapshot();
      if (snapshot.loading) return false; // not ready yet
      const q = snapshot.queries.find((x) => x.id === savedQueryId);
      if (!q) return true; // done (not found — treat as no-op)
      setSavedSnapshot({
        savedQueryId: q.id,
        savedSql: q.sql,
        savedName: q.name,
        savedFolderId: q.folder_id,
      });
      return true; // done
    }

    if (tryHydrate()) return;

    // Store is still loading — subscribe to wait for data.
    const unsub = savedQueriesStore.subscribe(() => {
      if (tryHydrate()) unsub();
    });
    return unsub;
  // Intentionally only run on mount (savedQueryId is stable from init).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const actions: QueryTabStateActions = {
    setCurrentConnection,
    setSavedSnapshot,
    setSaved,
    updateSavedSnapshot,
    setEditedName,
  };

  return { state, actions };
}

// ---------------------------------------------------------------------------
// isDirty — pure function for computing dirty state from tab state + current SQL.
//
// - Saved query tab: dirty when current SQL or current name differs from snapshot.
// - Ad-hoc tab (no savedQueryId): dirty when buffer is non-empty.
// ---------------------------------------------------------------------------

export function isDirty(state: QueryTabState, currentSql: string): boolean {
  if (state.savedQueryId) {
    const currentName = state.editedName ?? state.savedName;
    return currentSql !== state.savedSql || currentName !== state.savedName;
  }
  return currentSql.trim().length > 0;
}
