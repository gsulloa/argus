/**
 * useUnsavedDraft — task 11.1
 *
 * Aggregates the three draft sources in the DynamoDB data view tab into a
 * single `hasUnsavedDraft` boolean.
 *
 * Sources:
 *   1. Tabla inline cell editor  — set via `setInlineCellDirty`.
 *   2. Inspector JSON editor     — set via `setInspectorDirty`.
 *   3. Insert modal              — set via `setInsertModalDirty`.
 */

import { useState, useCallback } from "react";

export interface UseUnsavedDraftReturn {
  hasUnsavedDraft: boolean;
  setInlineCellDirty: (dirty: boolean) => void;
  setInspectorDirty: (dirty: boolean) => void;
  setInsertModalDirty: (dirty: boolean) => void;
}

export function useUnsavedDraft(): UseUnsavedDraftReturn {
  const [inlineCellDirty, setInlineCellDirty] = useState(false);
  const [inspectorDirty, setInspectorDirty] = useState(false);
  const [insertModalDirty, setInsertModalDirty] = useState(false);

  const hasUnsavedDraft = inlineCellDirty || inspectorDirty || insertModalDirty;

  return {
    hasUnsavedDraft,
    setInlineCellDirty: useCallback((d: boolean) => setInlineCellDirty(d), []),
    setInspectorDirty: useCallback((d: boolean) => setInspectorDirty(d), []),
    setInsertModalDirty: useCallback((d: boolean) => setInsertModalDirty(d), []),
  };
}
