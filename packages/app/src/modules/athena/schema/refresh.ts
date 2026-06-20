/**
 * Force a full reload of one Athena connection's schema tree: drop its
 * process-wide schema + columns caches and signal the mounted tree (via the
 * `athena:schema-refresh` window event) to reset its local state and refetch.
 *
 * Single entry point used by the toolbar refresh button and the global
 * `Cmd+R` / `Ctrl+R` accelerator.
 */

import { athenaColumnsCache } from "../sql/columnsCache";
import { athenaSchemaCache } from "./globalSchemaCache";

export function refreshConnection(connectionId: string): void {
  athenaSchemaCache.invalidate(connectionId);
  athenaColumnsCache.clearConnection(connectionId);
  window.dispatchEvent(new CustomEvent("athena:schema-refresh", { detail: connectionId }));
}
