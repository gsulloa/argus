/**
 * §21.3 — Per-tab cache for MySQL table structure + DDL.
 *
 * Keyed on (connectionId, schema, relation). Resets when the key changes.
 * Both StructureSubtab and RawSubtab read from the same cache instance to
 * avoid double-fetching when both are mounted for the first time.
 *
 * Invalidation:
 *   - Schema: Refresh → caller calls refresh()
 *   - mysql:active-changed (disconnect) → caller calls reset() / component unmounts
 *   - applyTableEdits success → caller calls refresh()
 *
 * Mirror of src/modules/postgres/structure/useTableStructureCache.ts.
 */

import { useCallback, useRef, useState } from "react";
import { AppError } from "@/platform/errors/AppError";
import { structureApi } from "./api";
import type { TableStructureResult, TableDdlResult } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CacheStatus = "idle" | "loading" | "ready" | "error";

export interface StructureCacheState {
  status: CacheStatus;
  response: TableStructureResult | null;
  error: AppError | null;
}

export interface DdlCacheState {
  status: CacheStatus;
  ddl: string | null;
  error: AppError | null;
}

export interface TableStructureCache {
  structureState: StructureCacheState;
  ddlState: DdlCacheState;
  ensureStructureLoaded(origin: "auto" | "user"): Promise<void>;
  refreshStructure(origin: "auto" | "user"): Promise<void>;
  ensureDdlLoaded(origin: "auto" | "user"): Promise<void>;
  refreshDdl(origin: "auto" | "user"): Promise<void>;
}

// ---------------------------------------------------------------------------
// Initial states
// ---------------------------------------------------------------------------

const initialStructureState: StructureCacheState = {
  status: "idle",
  response: null,
  error: null,
};

const initialDdlState: DdlCacheState = {
  status: "idle",
  ddl: null,
  error: null,
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTableStructureCache(
  connectionId: string,
  schema: string,
  relation: string,
): TableStructureCache {
  const key = `${connectionId}|${schema}|${relation}`;
  const [lastKey, setLastKey] = useState(key);
  const [structureState, setStructureState] = useState<StructureCacheState>(initialStructureState);
  const [ddlState, setDdlState] = useState<DdlCacheState>(initialDdlState);
  const structureInflight = useRef<Promise<void> | null>(null);
  const ddlInflight = useRef<Promise<void> | null>(null);
  const generationRef = useRef(0);

  // Render-phase key reset (React "store information from previous renders" pattern).
  if (lastKey !== key) {
    setLastKey(key);
    setStructureState(initialStructureState);
    setDdlState(initialDdlState);
    generationRef.current += 1;
    structureInflight.current = null;
    ddlInflight.current = null;
  }

  // -------------------------------------------------------------------------
  // Structure
  // -------------------------------------------------------------------------

  const dispatchStructure = useCallback(
    async (origin: "auto" | "user") => {
      const gen = generationRef.current;
      try {
        const response = await structureApi.tableStructure(connectionId, schema, relation, origin);
        if (generationRef.current !== gen) return;
        setStructureState({ status: "ready", response, error: null });
      } catch (e) {
        if (generationRef.current !== gen) return;
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        setStructureState((prev) => ({
          status: "error",
          response: prev.response,
          error: err,
        }));
      }
    },
    [connectionId, schema, relation],
  );

  const ensureStructureLoaded = useCallback(
    async (origin: "auto" | "user") => {
      if (structureState.status === "ready") return;
      if (structureInflight.current) return structureInflight.current;
      setStructureState((prev) => ({ ...prev, status: "loading", error: null }));
      const p = dispatchStructure(origin).finally(() => {
        structureInflight.current = null;
      });
      structureInflight.current = p;
      return p;
    },
    [structureState.status, dispatchStructure],
  );

  const refreshStructure = useCallback(
    async (origin: "auto" | "user") => {
      setStructureState((prev) => ({ ...prev, status: "loading", error: null }));
      await dispatchStructure(origin);
    },
    [dispatchStructure],
  );

  // -------------------------------------------------------------------------
  // DDL
  // -------------------------------------------------------------------------

  const dispatchDdl = useCallback(
    async (origin: "auto" | "user") => {
      const gen = generationRef.current;
      try {
        const result: TableDdlResult = await structureApi.tableDdl(
          connectionId,
          schema,
          relation,
          origin,
        );
        if (generationRef.current !== gen) return;
        setDdlState({ status: "ready", ddl: result.ddl, error: null });
      } catch (e) {
        if (generationRef.current !== gen) return;
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        setDdlState((prev) => ({
          status: "error",
          ddl: prev.ddl,
          error: err,
        }));
      }
    },
    [connectionId, schema, relation],
  );

  const ensureDdlLoaded = useCallback(
    async (origin: "auto" | "user") => {
      if (ddlState.status === "ready") return;
      if (ddlInflight.current) return ddlInflight.current;
      setDdlState((prev) => ({ ...prev, status: "loading", error: null }));
      const p = dispatchDdl(origin).finally(() => {
        ddlInflight.current = null;
      });
      ddlInflight.current = p;
      return p;
    },
    [ddlState.status, dispatchDdl],
  );

  const refreshDdl = useCallback(
    async (origin: "auto" | "user") => {
      setDdlState((prev) => ({ ...prev, status: "loading", error: null }));
      await dispatchDdl(origin);
    },
    [dispatchDdl],
  );

  return {
    structureState,
    ddlState,
    ensureStructureLoaded,
    refreshStructure,
    ensureDdlLoaded,
    refreshDdl,
  };
}
