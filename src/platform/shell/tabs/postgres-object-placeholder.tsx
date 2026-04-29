import { useEffect, useState } from "react";
import type { Tab } from "./types";
import { TabRegistry } from "./TabRegistry";
import { schemaApi } from "@/modules/postgres/schema/api";
import { AppError } from "@/platform/errors/AppError";
import styles from "./postgres-object-placeholder.module.css";

export const POSTGRES_OBJECT_PLACEHOLDER_KIND = "postgres-object-placeholder";

export interface PostgresObjectPlaceholderPayload {
  connectionId: string;
  connectionName: string;
  schema: string;
  kind: string;
  name: string;
  /**
   * Function OID — distinguishes overloads in the tab id. When set, the tab
   * lazily resolves the signature via `schemaApi.getFunctionSignature`.
   */
  oid?: number;
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

interface SignatureState {
  status: "idle" | "loading" | "loaded" | "error";
  args?: string;
  returnType?: string | null;
  errorMessage?: string;
}

function FunctionSignatureLine({
  payload,
}: {
  payload: PostgresObjectPlaceholderPayload;
}) {
  const [state, setState] = useState<SignatureState>({ status: "idle" });
  useEffect(() => {
    if (payload.kind !== "function" || payload.oid === undefined) return;
    let cancelled = false;
    setState({ status: "loading" });
    schemaApi
      .getFunctionSignature(payload.connectionId, payload.schema, payload.name, payload.oid)
      .then((sig) => {
        if (cancelled) return;
        setState({
          status: "loaded",
          args: sig.args_signature,
          returnType: sig.return_type,
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        setState({ status: "error", errorMessage: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [payload.connectionId, payload.schema, payload.name, payload.oid, payload.kind]);

  if (payload.kind !== "function" || payload.oid === undefined) return null;
  if (state.status === "loading") {
    return <span className={styles.signature}>(loading…)</span>;
  }
  if (state.status === "error") {
    return (
      <span className={styles.signature} title={state.errorMessage}>
        (signature unavailable)
      </span>
    );
  }
  if (state.status === "loaded" && state.args !== undefined) {
    return <span className={styles.signature}>({state.args})</span>;
  }
  return null;
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
          <FunctionSignatureLine payload={p} />
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
