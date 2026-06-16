/**
 * useInspectorWidth — Dynamo-specific inspector width persistence.
 *
 * Mirrors the Postgres useInspectorWidth pattern exactly but uses a
 * Dynamo-specific storage key so the two modules never share width state.
 *
 * Storage key format: `dynamoInspectorWidth:<connectionId>:<tableName>`
 * Width is per-table, not global.
 */

import { useCallback } from "react";
import { useSetting } from "@/platform/settings/useSetting";

const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 240;
const MAX_WIDTH = 720;

export interface UseDynamoInspectorWidthResult {
  width: number;
  setWidth(next: number): void;
  min: number;
  max: number;
}

export function useDynamoInspectorWidth(
  connectionId: string,
  tableName: string,
): UseDynamoInspectorWidthResult {
  const key = `dynamoInspectorWidth:${connectionId}:${tableName}`;
  const [value, set] = useSetting<number>(key, DEFAULT_WIDTH);

  const setWidth = useCallback(
    (next: number) => {
      const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(next)));
      set(clamped);
    },
    [set],
  );

  return {
    width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, value)),
    setWidth,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
  };
}
