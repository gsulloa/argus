import {
  POSTGRES_OBJECT_PLACEHOLDER_KIND,
  type PostgresObjectPlaceholderPayload,
} from "@/platform/shell/tabs/postgres-object-placeholder";
import {
  POSTGRES_TABLE_DATA_KIND,
  type PostgresTableDataPayload,
} from "@/modules/postgres/data/TableViewerTab";
import type { useTabs } from "@/platform/shell/tabs";
import type { RelationKind } from "@/modules/postgres/data/types";

const KIND_TITLE: Record<string, string> = {
  table: "Table",
  view: "View",
  materialized_view: "Mat View",
  function: "Function",
  sequence: "Sequence",
  type: "Type",
  extension: "Extension",
  index: "Index",
  trigger: "Trigger",
};

/** Stable id for the placeholder tab. Functions disambiguate by OID so two
 *  overloads of the same name route to distinct tabs. */
function placeholderTabId(p: PostgresObjectPlaceholderPayload): string {
  const disc = p.kind === "function" && p.oid !== undefined ? `#${p.oid}` : "";
  return `pgobj:${p.connectionId}:${p.schema}:${p.kind}:${p.name}${disc}`;
}

function placeholderTitle(p: PostgresObjectPlaceholderPayload): string {
  const kindLabel = KIND_TITLE[p.kind] ?? p.kind;
  return `${kindLabel}: ${p.schema}.${p.name}`;
}

/** Stable id for the data viewer tab. */
function dataTabId(p: PostgresTableDataPayload): string {
  return `pgtbl:${p.connectionId}:${p.schema}:${p.relation}`;
}

function dataTabTitle(p: PostgresTableDataPayload): string {
  const kindLabel = KIND_TITLE[
    p.relationKind === "materialized-view" ? "materialized_view" : p.relationKind
  ];
  return `${kindLabel}: ${p.schema}.${p.relation}`;
}

const VIEWER_KINDS = new Set<string>(["table", "view", "materialized_view"]);

function relationKindFor(kind: string): RelationKind | null {
  if (kind === "table") return "table";
  if (kind === "view") return "view";
  if (kind === "materialized_view") return "materialized-view";
  return null;
}

export function openObjectTab(
  tabs: ReturnType<typeof useTabs>,
  payload: PostgresObjectPlaceholderPayload,
): string {
  const relationKind = VIEWER_KINDS.has(payload.kind)
    ? relationKindFor(payload.kind)
    : null;

  if (relationKind) {
    const dataPayload: PostgresTableDataPayload = {
      connectionId: payload.connectionId,
      connectionName: payload.connectionName,
      schema: payload.schema,
      relation: payload.name,
      relationKind,
    };
    return tabs.open({
      id: dataTabId(dataPayload),
      kind: POSTGRES_TABLE_DATA_KIND,
      title: dataTabTitle(dataPayload),
      payload: dataPayload,
      closable: true,
    });
  }

  return tabs.open({
    id: placeholderTabId(payload),
    kind: POSTGRES_OBJECT_PLACEHOLDER_KIND,
    title: placeholderTitle(payload),
    payload,
    closable: true,
  });
}
