/**
 * useTableModels — loads the dynamo_model docs for the open table.
 *
 * Mirrors the `useContextObject` pattern from src/modules/context/hooks.ts:
 *   - Uses the `listModels` api wrapper to call `context_list_models`.
 *   - Automatically re-fetches when the context folder's "object" or "manifest"
 *     events fire (folder watcher-driven live updates).
 *   - Returns `models: DynamoModel[]` and `isStd: boolean` (true when at least
 *     one model doc exists for the table).
 *
 * When `contextPath` is null/undefined (no context folder linked), the hook
 * returns an empty array immediately with `isStd: false` — the "By model"
 * toggle is hidden and no fetch is issued (D2: STD detection by presence of
 * model docs).
 *
 * Task 4.4: Adds optimistic overlay (pendingUpserts / pendingDeletes) so a
 * just-saved/just-deleted model is reflected immediately and reconciled when
 * the watcher-driven refresh lands.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useContextChangeListener } from "@/modules/context/eventBus";
import type { ContextChangeKind } from "@/modules/context/types";
import { listModels } from "./api";
import type { DynamoModel } from "./types";

// The same kinds as useContextObject — objects and manifest changes may
// affect model docs since they live in the context folder.
const KINDS: ContextChangeKind[] = ["object", "manifest"];

interface TableModelsResult {
  models: DynamoModel[];
  isStd: boolean;
  loading: boolean;
  error: Error | null;
  /** Optimistically mark a model as saved (upsert by name). */
  applyOptimisticSave(model: DynamoModel): void;
  /** Optimistically mark a model as deleted (remove by name). */
  applyOptimisticDelete(name: string): void;
}

/**
 * @param connectionId  The connection whose context folder to query.
 * @param tableName     The physical DynamoDB table name.
 * @param contextPath   The context folder path on disk (null → no folder linked).
 */
export function useTableModels(
  connectionId: string,
  tableName: string,
  contextPath: string | null | undefined,
): TableModelsResult {
  const enabled = !!contextPath;

  const [state, setState] = useState<{
    models: DynamoModel[];
    loading: boolean;
    error: Error | null;
  }>({ models: [], loading: false, error: null });

  // Optimistic overlay — stored in state so changes trigger re-renders.
  const [pendingUpserts, setPendingUpserts] = useState<Map<string, DynamoModel>>(
    () => new Map(),
  );
  const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(
    () => new Set(),
  );

  const refresh = useCallback(() => {
    if (!enabled) {
      setState({ models: [], loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    listModels(connectionId, tableName)
      .then((data) => {
        setState({ models: data, loading: false, error: null });

        // Reconcile: clear overlay entries that disk now agrees with.
        setPendingUpserts((prev) => {
          const next = new Map(prev);
          let changed = false;
          for (const [name, pendingModel] of next) {
            const diskModel = data.find((m) => m.name === name);
            if (
              diskModel &&
              JSON.stringify(diskModel.access_patterns) ===
                JSON.stringify(pendingModel.access_patterns)
            ) {
              next.delete(name);
              changed = true;
            }
          }
          return changed ? next : prev;
        });

        setPendingDeletes((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const name of next) {
            if (!data.find((m) => m.name === name)) {
              next.delete(name);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      })
      .catch((e: Error) =>
        setState({ models: [], loading: false, error: e }),
      );
  }, [enabled, connectionId, tableName]);

  // Initial fetch + re-fetch when deps change
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live re-fetch on folder watcher events (mirrors useContextObject)
  useContextChangeListener(contextPath, KINDS, refresh);

  // Merge: start from fetched models, drop deleted, upsert pending saves.
  const mergedModels = useMemo(() => {
    let result = state.models.filter((m) => !pendingDeletes.has(m.name));
    for (const [name, model] of pendingUpserts) {
      const idx = result.findIndex((m) => m.name === name);
      if (idx >= 0) {
        result = result.map((m, i) => (i === idx ? model : m));
      } else {
        result = [...result, model];
      }
    }
    return result;
  }, [state.models, pendingUpserts, pendingDeletes]);

  const applyOptimisticSave = useCallback((model: DynamoModel) => {
    setPendingUpserts((prev) => {
      const next = new Map(prev);
      next.set(model.name, model);
      return next;
    });
    setPendingDeletes((prev) => {
      if (!prev.has(model.name)) return prev;
      const next = new Set(prev);
      next.delete(model.name);
      return next;
    });
  }, []);

  const applyOptimisticDelete = useCallback((name: string) => {
    setPendingDeletes((prev) => {
      const next = new Set(prev);
      next.add(name);
      return next;
    });
    setPendingUpserts((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Map(prev);
      next.delete(name);
      return next;
    });
  }, []);

  return {
    models: mergedModels,
    isStd: mergedModels.length > 0,
    loading: state.loading,
    error: state.error,
    applyOptimisticSave,
    applyOptimisticDelete,
  };
}
