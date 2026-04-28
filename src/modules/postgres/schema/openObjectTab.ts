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

/** Stable tab id so re-activating the same object focuses the existing tab. */
function tabIdFor(p: PostgresObjectPlaceholderPayload): string {
  const sig = p.signature ?? "";
  return `pgobj:${p.connectionId}:${p.schema}:${p.kind}:${p.name}#${sig}`;
}

function titleFor(p: PostgresObjectPlaceholderPayload): string {
  const kindLabel = KIND_TITLE[p.kind] ?? p.kind;
  return `${kindLabel}: ${p.schema}.${p.name}`;
}

export function openObjectTab(
  tabs: ReturnType<typeof useTabs>,
  payload: PostgresObjectPlaceholderPayload,
): string {
  return tabs.open({
    id: tabIdFor(payload),
    kind: POSTGRES_OBJECT_PLACEHOLDER_KIND,
    title: titleFor(payload),
    payload,
    closable: true,
  });
}
