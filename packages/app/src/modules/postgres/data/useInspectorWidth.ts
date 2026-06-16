import { useCallback } from "react";
import { useSetting } from "@/platform/settings/useSetting";

const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;
const SETTINGS_KEY = "pgInspectorWidth";

export interface UseInspectorWidthResult {
  width: number;
  setWidth(next: number): void;
  min: number;
  max: number;
}

/** Global (not per-relation) inspector width preference. */
export function useInspectorWidth(): UseInspectorWidthResult {
  const [value, set] = useSetting<number>(SETTINGS_KEY, DEFAULT_WIDTH);

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
