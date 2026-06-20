/**
 * Open a cloudwatch-insights tab.
 *
 * Each call opens a new tab with a unique id (Insights query tabs are not
 * deduplicated — the user may have many open).
 */

import { CLOUDWATCH_INSIGHTS_KIND } from "./QueryTab";

interface TabsMinimal {
  open: (input: {
    id?: string;
    kind: string;
    title: string;
    closable?: boolean;
    payload: unknown;
  }) => string;
}

export interface OpenInsightsTabArgs {
  connectionId: string;
  connectionName?: string;
  initialGroups?: string[];
  initialQuery?: string;
}

let globalInsightsQueryCounter = 0;

function nextTitle(args: OpenInsightsTabArgs): string {
  globalInsightsQueryCounter += 1;
  const base = args.connectionName ? `${args.connectionName} — ` : "";
  return `${base}Insights ${globalInsightsQueryCounter}`;
}

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function openInsightsTab(tabs: TabsMinimal, args: OpenInsightsTabArgs): string {
  const id = `cwinsights:${genId()}`;
  tabs.open({
    id,
    kind: CLOUDWATCH_INSIGHTS_KIND,
    title: nextTitle(args),
    closable: true,
    payload: {
      connectionId: args.connectionId,
      connectionName: args.connectionName ?? args.connectionId,
      initialGroups: args.initialGroups ?? [],
      ...(args.initialQuery !== undefined ? { initialQuery: args.initialQuery } : {}),
    },
  });
  return id;
}
