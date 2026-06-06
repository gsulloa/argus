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
 */

import { useCallback, useEffect, useState } from "react";
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

  const refresh = useCallback(() => {
    if (!enabled) {
      setState({ models: [], loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    listModels(connectionId, tableName)
      .then((data) => setState({ models: data, loading: false, error: null }))
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

  return {
    models: state.models,
    isStd: state.models.length > 0,
    loading: state.loading,
    error: state.error,
  };
}
