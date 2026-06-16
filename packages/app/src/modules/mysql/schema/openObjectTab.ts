/**
 * Routes MySQL tree-node activations to the appropriate tab kind.
 *
 * Tables/views → `mysql-table-data` tab.
 * Routines/triggers/events/indexes/foreign keys → `mysql-object-placeholder`.
 * Group nodes → toggle expand only (caller handles, not this function).
 */

import type { useTabs } from "@/platform/shell/tabs";

// ---------------------------------------------------------------------------
// Tab kind constants
// ---------------------------------------------------------------------------

/** Tab kind for MySQL table/view data viewer. */
export const MYSQL_TABLE_DATA_KIND = "mysql-table-data";

/** Tab kind for placeholder (routines, triggers, events, indexes, FKs). */
export const MYSQL_OBJECT_PLACEHOLDER_KIND = "mysql-object-placeholder";

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

export interface MysqlTableDataPayload {
  connectionId: string;
  connectionName: string;
  schema: string;
  relation: string;
  relationKind: "table" | "view";
}

export interface MysqlObjectPlaceholderPayload {
  connectionId: string;
  connectionName: string;
  schema: string;
  /** Object kind: routine | trigger | event | index | foreign_key */
  kind: string;
  name: string;
  /** For routines: "procedure" | "function" */
  routineKind?: "procedure" | "function";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const KIND_TITLE: Record<string, string> = {
  table: "Table",
  view: "View",
  routine: "Routine",
  trigger: "Trigger",
  event: "Event",
  index: "Index",
  foreign_key: "FK",
};

function dataTabId(p: MysqlTableDataPayload): string {
  return `mytbl:${p.connectionId}:${p.schema}:${p.relation}`;
}

function dataTabTitle(p: MysqlTableDataPayload): string {
  const kindLabel = KIND_TITLE[p.relationKind] ?? p.relationKind;
  return `${kindLabel}: ${p.schema}.${p.relation}`;
}

function placeholderTabId(p: MysqlObjectPlaceholderPayload): string {
  return `myobj:${p.connectionId}:${p.schema}:${p.kind}:${p.name}`;
}

function placeholderTabTitle(p: MysqlObjectPlaceholderPayload): string {
  const kindLabel = KIND_TITLE[p.kind] ?? p.kind;
  return `${kindLabel}: ${p.schema}.${p.name}`;
}

const VIEWER_KINDS = new Set(["table", "view"]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface OpenObjectTabArgs {
  connectionId: string;
  connectionName: string;
  schema: string;
  /** Object kind string from the tree leaf. */
  kind: string;
  name: string;
  routineKind?: "procedure" | "function";
}

export function openMysqlObjectTab(
  tabs: ReturnType<typeof useTabs>,
  args: OpenObjectTabArgs,
): string {
  if (VIEWER_KINDS.has(args.kind)) {
    const payload: MysqlTableDataPayload = {
      connectionId: args.connectionId,
      connectionName: args.connectionName,
      schema: args.schema,
      relation: args.name,
      relationKind: args.kind as "table" | "view",
    };
    return tabs.open({
      id: dataTabId(payload),
      kind: MYSQL_TABLE_DATA_KIND,
      title: dataTabTitle(payload),
      payload,
      closable: true,
    });
  }

  const payload: MysqlObjectPlaceholderPayload = {
    connectionId: args.connectionId,
    connectionName: args.connectionName,
    schema: args.schema,
    kind: args.kind,
    name: args.name,
    ...(args.routineKind ? { routineKind: args.routineKind } : {}),
  };
  return tabs.open({
    id: placeholderTabId(payload),
    kind: MYSQL_OBJECT_PLACEHOLDER_KIND,
    title: placeholderTabTitle(payload),
    payload,
    closable: true,
  });
}
