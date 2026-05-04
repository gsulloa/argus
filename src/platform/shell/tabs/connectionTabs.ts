import type { Tab } from "./types";

/**
 * Filter `tabs` to those whose payload references a given connection id.
 * Tab kinds that own a connection (table viewers, SQL query tabs) all carry
 * `connectionId: string` on their payload; tabs without that field (welcome,
 * settings) are excluded.
 *
 * Pure: no React state, safe to call from event handlers and effects.
 */
export function listConnectionTabs(tabs: Tab[], connectionId: string): Tab[] {
  return tabs.filter((t) => {
    const payload = t.payload as { connectionId?: unknown } | null | undefined;
    return (
      typeof payload === "object" &&
      payload !== null &&
      payload.connectionId === connectionId
    );
  });
}
