import type { Tab } from "./types";
import { TabRegistry } from "./TabRegistry";
import styles from "./postgres-object-placeholder.module.css";

export const POSTGRES_OBJECT_PLACEHOLDER_KIND = "postgres-object-placeholder";

export interface PostgresObjectPlaceholderPayload {
  connectionId: string;
  connectionName: string;
  schema: string;
  kind: string;
  name: string;
  /** Set for functions, where overload signatures are part of identity. */
  signature?: string;
}

const KIND_LABEL: Record<string, string> = {
  table: "Table",
  view: "View",
  materialized_view: "Materialized View",
  function: "Function",
  sequence: "Sequence",
  type: "Type",
  extension: "Extension",
  index: "Index",
  trigger: "Trigger",
};

function isPayload(v: unknown): v is PostgresObjectPlaceholderPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.connectionId === "string" &&
    typeof o.connectionName === "string" &&
    typeof o.schema === "string" &&
    typeof o.kind === "string" &&
    typeof o.name === "string"
  );
}

function PostgresObjectPlaceholderTab({ tab }: { tab: Tab }) {
  if (!isPayload(tab.payload)) {
    return <div className={styles.root}>Invalid placeholder payload.</div>;
  }
  const p = tab.payload;
  const kindLabel = KIND_LABEL[p.kind] ?? p.kind;
  return (
    <div className={styles.root}>
      <div className={styles.card}>
        <div className={styles.kind}>{kindLabel}</div>
        <h2 className={styles.title}>
          <span className={styles.schema}>{p.schema}.</span>
          <span className={styles.name}>{p.name}</span>
          {p.signature !== undefined && (
            <span className={styles.signature}>({p.signature})</span>
          )}
        </h2>
        <div className={styles.connection}>via {p.connectionName}</div>
        <p className={styles.message}>
          Viewer not implemented yet — coming in a future change.
        </p>
      </div>
    </div>
  );
}

TabRegistry.register(POSTGRES_OBJECT_PLACEHOLDER_KIND, PostgresObjectPlaceholderTab);
