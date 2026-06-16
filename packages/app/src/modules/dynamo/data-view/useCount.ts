/**
 * useCount — task 13.1–13.3
 *
 * Thin hook that owns Count button state: in-flight guard, result, and
 * auto-clear logic.
 *
 * Design decisions:
 *
 * (a) Count compilation lives here rather than in builderCompiler.ts.
 *     Rationale: the Count payload is a strict subset of the compiled Scan/Query
 *     request (same filter, same key-condition, different shape). Adding a
 *     `compileToCount` helper in builderCompiler would couple it to CountRequest;
 *     instead we derive the count payload directly from the existing `compile()`
 *     output by extracting the fields we need. This keeps builderCompiler focused
 *     on Scan/Query and keeps the Count compilation colocated with its consumer.
 *
 * (b) Auto-clear semantics (task 13.3):
 *     The hook compares a snapshot of {mode, indexName, filters, query} captured
 *     at count-time against the current builder on every render. If any differ,
 *     the result is cleared. pageSize, consistentRead, and scanIndexForward do NOT
 *     trigger a clear (spec is explicit). Comparison uses JSON.stringify for deep
 *     equality — safe here because BuilderState contains only plain values.
 *
 * (c) Selection semantics when items change:
 *     This hook does not touch selection state. Selection clearing on Escape is
 *     owned by Inspector (task 12.4). Selection clearing on items.reset() is
 *     owned by DataViewTab (it calls setSelectedRowIndex(null) inside handleReset).
 *     When items grow via loadMore, selection persists (items are append-only;
 *     selectedRowIndex remains stable).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { compile } from "./builderCompiler";
import { dynamoCountItems } from "./api";
import type { BuilderState, CountRequest } from "./types";
import type { TableDescription } from "@/modules/dynamo/tables/types";
import type { CountResult } from "./BottomBar";

// ---------------------------------------------------------------------------
// Snapshot type — the subset of BuilderState that triggers count clearing
// ---------------------------------------------------------------------------

interface CountSnapshot {
  mode: BuilderState["mode"];
  indexName: BuilderState["indexName"];
  filtersJson: string; // JSON.stringify(filters)
  queryJson: string; // JSON.stringify(query ?? null)
}

function makeSnapshot(builder: BuilderState): CountSnapshot {
  return {
    mode: builder.mode,
    indexName: builder.indexName,
    filtersJson: JSON.stringify(builder.filters),
    queryJson: JSON.stringify(builder.query ?? null),
  };
}

function snapshotsEqual(a: CountSnapshot, b: CountSnapshot): boolean {
  return (
    a.mode === b.mode &&
    a.indexName === b.indexName &&
    a.filtersJson === b.filtersJson &&
    a.queryJson === b.queryJson
  );
}

// ---------------------------------------------------------------------------
// compileToCountRequest — extract CountRequest fields from compile() result
// ---------------------------------------------------------------------------

function compileToCountRequest(
  builder: BuilderState,
  describe: TableDescription,
): Omit<CountRequest, "connection_id" | "table_name" | "origin"> | null {
  const compiled = compile(builder, describe);
  if (compiled.kind === "error") return null;

  if (compiled.kind === "scan") {
    const { request } = compiled;
    return {
      mode: "scan",
      index_name: request.index_name,
      key_condition_expression: null,
      filter_expression: request.filter_expression,
      expression_attribute_names: request.expression_attribute_names,
      expression_attribute_values: request.expression_attribute_values,
      scan_index_forward: null,
      consistent_read: builder.consistentRead,
    };
  }

  // compiled.kind === "query"
  const { request } = compiled;
  return {
    mode: "query",
    index_name: request.index_name,
    key_condition_expression: request.key_condition_expression,
    filter_expression: request.filter_expression,
    expression_attribute_names: request.expression_attribute_names,
    expression_attribute_values: request.expression_attribute_values,
    scan_index_forward: request.scan_index_forward ?? null,
    consistent_read: builder.consistentRead,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseCountResult {
  countLoading: boolean;
  countResult: CountResult | undefined;
  triggerCount: () => void;
  clearCount: () => void;
}

export function useCount(
  connectionId: string,
  tableName: string,
  builder: BuilderState,
  describe: TableDescription | null,
): UseCountResult {
  const [countLoading, setCountLoading] = useState(false);
  const [countResult, setCountResult] = useState<CountResult | undefined>();

  // Snapshot of builder at count-fire time (for task 13.3 auto-clear).
  const snapshotRef = useRef<CountSnapshot | null>(null);

  // Stable refs for async callbacks.
  const connectionIdRef = useRef(connectionId);
  connectionIdRef.current = connectionId;
  const tableNameRef = useRef(tableName);
  tableNameRef.current = tableName;
  const builderRef = useRef(builder);
  builderRef.current = builder;
  const describeRef = useRef(describe);
  describeRef.current = describe;

  // In-flight guard: ensures double-click does not fire twice.
  const inFlightRef = useRef(false);

  // ── Auto-clear when the relevant builder subset changes (task 13.3) ────────
  useEffect(() => {
    if (!snapshotRef.current) return;
    if (!countResult) return;
    const current = makeSnapshot(builder);
    if (!snapshotsEqual(snapshotRef.current, current)) {
      setCountResult(undefined);
      snapshotRef.current = null;
    }
  }, [builder, countResult]);

  // ── triggerCount (task 13.1) ──────────────────────────────────────────────
  const triggerCount = useCallback(() => {
    if (inFlightRef.current) return; // double-click guard
    if (describeRef.current === null) return; // need describe for compile

    const countReq = compileToCountRequest(builderRef.current, describeRef.current);
    if (!countReq) return; // compile error — builder invalid

    inFlightRef.current = true;
    setCountLoading(true);

    // Capture snapshot at fire time for change detection.
    snapshotRef.current = makeSnapshot(builderRef.current);

    dynamoCountItems(
      connectionIdRef.current,
      tableNameRef.current,
      countReq,
      "user",
    )
      .then((res) => {
        setCountResult({
          totalCount: res.total_count,
          totalScannedCount: res.total_scanned_count,
        });
      })
      .catch(() => {
        // Silently clear on error; no retry logic here.
        setCountResult(undefined);
        snapshotRef.current = null;
      })
      .finally(() => {
        inFlightRef.current = false;
        setCountLoading(false);
      });
  }, []);

  // ── clearCount ─────────────────────────────────────────────────────────────
  const clearCount = useCallback(() => {
    setCountResult(undefined);
    snapshotRef.current = null;
  }, []);

  return { countLoading, countResult, triggerCount, clearCount };
}
