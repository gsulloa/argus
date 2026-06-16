/**
 * Shared column-width utilities for Argus grids.
 *
 * ColumnCategory is duplicated from src/modules/postgres/data/typeHelpers.ts.
 * The two definitions MUST stay in sync. If you add a variant here, also add
 * it in typeHelpers.ts (and vice-versa). A future refactor can canonicalize
 * this type to a shared location; for now the duplication is intentional to
 * avoid circular imports between platform and modules layers.
 */

import { useMemo, useState } from "react";
import { useSetting } from "@/platform/settings/useSetting";

// ---------------------------------------------------------------------------
// Category type
// ---------------------------------------------------------------------------

export type ColumnCategory =
  | "numeric"
  | "boolean"
  | "date"
  | "text"
  | "binary"
  | "json"
  | "uuid"
  | "other";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MIN_WIDTH = 56;
export const MAX_WIDTH = 800;
export const KEY_BADGE_PAD = 16;

export const BASE_WIDTH_BY_CATEGORY: Record<ColumnCategory, number> = {
  boolean: 88,
  numeric: 120,
  date: 168,
  uuid: 280,
  text: 200,
  json: 240,
  binary: 140,
  other: 180,
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Returns the base pixel width for a column, optionally adding KEY_BADGE_PAD
 * when the column is a primary-key / partition-key indicator.
 */
export function baseWidthFor({
  category,
  isKey,
}: {
  category: ColumnCategory;
  isKey?: boolean;
}): number {
  return BASE_WIDTH_BY_CATEGORY[category] + (isKey ? KEY_BADGE_PAD : 0);
}

/**
 * Clamps a pixel value to the valid resize range [MIN_WIDTH, MAX_WIDTH].
 */
export function clampWidth(px: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, px));
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type ColumnWidthsRecord = Record<string, number>;

export type ColumnSpec = {
  name: string;
  category: ColumnCategory;
  isKey?: boolean;
  /** Column that cannot be resized (e.g. DynamoDB "More…"). */
  nonResizable?: boolean;
  /** Fixed pixel width — overrides everything, not stored in the record. */
  fixedWidth?: number;
  /**
   * Measured header floor (computed externally by the caller — e.g. via an
   * off-DOM canvas of the column name in the header font). When set, the
   * default-width branch returns `max(typeBaseWidth, floorWidth)` so long
   * names don't ellipsis-truncate at type-derived defaults. User overrides
   * and `fixedWidth` still win.
   */
  floorWidth?: number;
};

/**
 * Manages per-column widths for a grid.
 *
 * When `storageKey` is `null` the record lives in component state (in-memory
 * only — used by ad-hoc SQL result grids whose column shape changes per
 * query). When `storageKey` is a string the record is persisted via
 * `useSetting<ColumnWidthsRecord>` (memory-cached + debounced 150ms to disk).
 */
export function useColumnWidths(opts: {
  storageKey: string | null;
  columns: ColumnSpec[];
}): {
  widthFor: (name: string) => number;
  totalWidth: number;
  setWidth: (name: string, px: number) => void;
  resetWidth: (name: string) => void;
} {
  const { storageKey, columns } = opts;

  // --- In-memory branch (storageKey === null) ---
  // We must call hooks unconditionally; use a sentinel key when in-memory mode
  // so the useSetting path is still invoked but effectively unused.
  const SENTINEL_KEY = "__columnWidths_inmemory__";
  const [memRecord, setMemRecord] = useState<ColumnWidthsRecord>({});
  const [settingRecord, updateSettingRecord] = useSetting<ColumnWidthsRecord>(
    storageKey ?? SENTINEL_KEY,
    {},
  );

  const record: ColumnWidthsRecord =
    storageKey === null ? memRecord : settingRecord;

  // Column map for O(1) lookup
  const columnMap = useMemo(() => {
    const m = new Map<string, ColumnSpec>();
    for (const col of columns) m.set(col.name, col);
    return m;
  }, [columns]);

  const widthFor = (name: string): number => {
    const col = columnMap.get(name);
    if (!col) return BASE_WIDTH_BY_CATEGORY.other;
    if (col.fixedWidth !== undefined) return col.fixedWidth;
    if (record[name] !== undefined) return record[name];
    const base = baseWidthFor({ category: col.category, isKey: col.isKey });
    return Math.max(base, col.floorWidth ?? 0);
  };

  // Memoize totalWidth on columns signature + record reference.
  // We include individual column metadata in the deps so a category change also
  // recalculates, but we avoid deep-equality by using the joined name string as
  // a stable proxy for column identity changes (order / addition / removal).
  const columnsSig = columns.map((c) => c.name).join("|");
  const totalWidth = useMemo(
    () => columns.reduce((sum, col) => sum + widthFor(col.name), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columnsSig, record, columnMap],
  );

  const setWidth = (name: string, px: number): void => {
    const clamped = clampWidth(px);
    if (storageKey === null) {
      setMemRecord((prev) => ({ ...prev, [name]: clamped }));
    } else {
      updateSettingRecord((prev) => ({ ...prev, [name]: clamped }));
    }
  };

  const resetWidth = (name: string): void => {
    if (storageKey === null) {
      setMemRecord((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    } else {
      updateSettingRecord((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  };

  return { widthFor, totalWidth, setWidth, resetWidth };
}
