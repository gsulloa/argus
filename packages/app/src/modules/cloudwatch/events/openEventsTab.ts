/**
 * Open a CloudWatch log-stream events tab.
 *
 * Each call opens a new tab; events tabs are not deduplicated since the
 * user may open multiple streams at once.
 */

import { CLOUDWATCH_EVENTS_KIND } from "./EventsTab";

interface TabsMinimal {
  open: (input: {
    id?: string;
    kind: string;
    title: string;
    closable?: boolean;
    payload: unknown;
  }) => string;
}

export interface OpenEventsTabArgs {
  connectionId: string;
  connectionName?: string;
  groupName: string;
  streamName: string;
}

let globalEventsCounter = 0;

function nextTitle(args: OpenEventsTabArgs): string {
  globalEventsCounter += 1;
  const base = args.connectionName ? `${args.connectionName} — ` : "";
  // Shorten long stream names for the title
  const shortStream =
    args.streamName.length > 40
      ? `…${args.streamName.slice(-37)}`
      : args.streamName;
  return `${base}${shortStream} (${globalEventsCounter})`;
}

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function openEventsTab(tabs: TabsMinimal, args: OpenEventsTabArgs): string {
  const id = `cwevents:${genId()}`;
  tabs.open({
    id,
    kind: CLOUDWATCH_EVENTS_KIND,
    title: nextTitle(args),
    closable: true,
    payload: {
      connectionId: args.connectionId,
      connectionName: args.connectionName ?? args.connectionId,
      groupName: args.groupName,
      streamName: args.streamName,
    },
  });
  return id;
}
