import { useEffect } from "react";

/**
 * Per-tab dirty-state summary, registered by tab renderers that hold edit
 * buffers. The disconnect-confirmation dialog reads this registry to list the
 * unsaved work that would be lost if a connection were torn down.
 *
 * Single consumer by design: do not grow this into a general "tab state" bus.
 */
export interface DirtySummary {
  connectionId: string;
  /** Human label for what is dirty — usually the table name. */
  label: string;
}

const summaries = new Map<string, DirtySummary>();

export function registerDirtySummary(tabId: string, summary: DirtySummary) {
  summaries.set(tabId, summary);
}

export function unregisterDirtySummary(tabId: string) {
  summaries.delete(tabId);
}

export function listDirtySummaries(connectionId: string): DirtySummary[] {
  const out: DirtySummary[] = [];
  for (const s of summaries.values()) {
    if (s.connectionId === connectionId) out.push(s);
  }
  return out;
}

export function listAllDirtySummaries(): DirtySummary[] {
  return Array.from(summaries.values());
}

/**
 * React hook: register a dirty summary for the given tab while `summary` is
 * non-null; unregister automatically on unmount or when summary becomes null.
 */
export function useDirtySummary(tabId: string, summary: DirtySummary | null) {
  useEffect(() => {
    if (summary === null) {
      unregisterDirtySummary(tabId);
      return;
    }
    registerDirtySummary(tabId, summary);
    return () => unregisterDirtySummary(tabId);
  }, [tabId, summary?.connectionId, summary?.label]);
}

/** Test-only: clear the registry between tests. */
export function _resetDirtySummariesForTests() {
  summaries.clear();
}
