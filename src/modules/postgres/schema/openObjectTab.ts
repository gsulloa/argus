import {
  POSTGRES_OBJECT_PLACEHOLDER_KIND,
  type PostgresObjectPlaceholderPayload,
} from "@/platform/shell/tabs/postgres-object-placeholder";
import type { useTabs } from "@/platform/shell/tabs";

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

export function openObjectTab(
  tabs: ReturnType<typeof useTabs>,
  payload: PostgresObjectPlaceholderPayload,
): string {
  return tabs.open({
    id: placeholderTabId(payload),
    kind: POSTGRES_OBJECT_PLACEHOLDER_KIND,
    title: placeholderTitle(payload),
    payload,
    closable: true,
  });
}
