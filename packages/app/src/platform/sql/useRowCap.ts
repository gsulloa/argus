/**
 * Shared frontend primitive for the configurable SQL result row cap
 * (`openspec/changes/configurable-result-row-cap`).
 *
 * Mirrors the Rust constants in `src-tauri/src/platform/row_cap.rs`:
 * `DEFAULT_ROW_CAP` / `HARD_ROW_CAP` / the `sql.rowCap` setting key. The
 * frontend never enforces the cap itself — it only lets the user read and
 * write the setting that the backend resolves per statement — so the only
 * validation that matters here is keeping garbage out of the setting.
 */
import { useCallback } from "react";
import { useSetting } from "@/platform/settings/useSetting";

export const DEFAULT_ROW_CAP = 10000;
export const HARD_ROW_CAP = 1000000;
export const ROW_CAP_SETTING_KEY = "sql.rowCap";

/**
 * Validates a candidate row cap. Returns the value unchanged when it is a
 * finite integer in `[1, HARD_ROW_CAP]`, otherwise `null`. Callers must
 * reject `null` without writing the setting.
 */
export function clampRowCap(n: number): number | null {
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) {
    return null;
  }
  if (n < 1 || n > HARD_ROW_CAP) {
    return null;
  }
  return n;
}

/**
 * Wraps `useSetting<number>(ROW_CAP_SETTING_KEY, DEFAULT_ROW_CAP)`. The
 * returned setter silently rejects (no write, no throw) any value
 * `clampRowCap` would reject, so callers can wire it directly to untrusted
 * input (e.g. a custom numeric field) without pre-validating.
 */
export function useRowCap(): [number, (n: number) => void, boolean] {
  const [rowCap, setRawRowCap, loaded] = useSetting<number>(
    ROW_CAP_SETTING_KEY,
    DEFAULT_ROW_CAP,
  );

  const setRowCap = useCallback(
    (n: number) => {
      const clamped = clampRowCap(n);
      if (clamped === null) return;
      setRawRowCap(clamped);
    },
    [setRawRowCap],
  );

  return [rowCap, setRowCap, loaded];
}

/**
 * Abbreviated display form for the toolbar/menu: whole thousands render as
 * `"10k"`, whole millions as `"1M"`, everything else falls back to a
 * thousands-separated literal (`12345 -> "12,345"`).
 */
export function formatRowCapShort(n: number): string {
  if (Number.isInteger(n) && n !== 0 && n % 1_000_000 === 0) {
    return `${n / 1_000_000}M`;
  }
  if (Number.isInteger(n) && n !== 0 && n % 1000 === 0) {
    return `${n / 1000}k`;
  }
  return n.toLocaleString();
}
