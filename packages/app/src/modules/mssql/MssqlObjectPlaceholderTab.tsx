/**
 * MSSQL Object Placeholder tab.
 *
 * Tab kind: "mssql-object-placeholder"
 * Payload: MssqlObjectPlaceholderPayload (from openObjectTab.ts)
 *
 * Rendered for MSSQL objects that don't have a full viewer in v1:
 * procedures, functions, triggers, sequences, indexes, foreign-keys,
 * check-constraints, default-constraints.
 *
 * Mirrors MysqlObjectPlaceholderTab with MSSQL-specific kinds.
 */

import { useEffect, useState } from "react";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import type { Tab } from "@/platform/shell/tabs/types";
import { AppError } from "@/platform/errors/AppError";
import { schemaApi } from "./schema/api";
import type { MssqlObjectPlaceholderPayload } from "./schema/openObjectTab";
import { MSSQL_OBJECT_PLACEHOLDER_KIND } from "./schema/openObjectTab";
import styles from "@/platform/shell/tabs/postgres-object-placeholder.module.css";

const KIND_LABEL: Record<string, string> = {
  table: "Table",
  view: "View",
  procedure: "Procedure",
  function: "Function",
  trigger: "Trigger",
  sequence: "Sequence",
  index: "Index",
  foreign_key: "Foreign Key",
  check_constraint: "Check Constraint",
  default_constraint: "Default Constraint",
};

function isPayload(v: unknown): v is MssqlObjectPlaceholderPayload {
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

interface RoutineSignatureState {
  status: "idle" | "loading" | "loaded" | "error";
  args?: string;
  returns?: string | null;
  errorMessage?: string;
}

function RoutineSignatureLine({ payload }: { payload: MssqlObjectPlaceholderPayload }) {
  const [state, setState] = useState<RoutineSignatureState>({ status: "idle" });

  const isProcedureOrFunction =
    payload.kind === "procedure" || payload.kind === "function";

  useEffect(() => {
    if (!isProcedureOrFunction) return;
    let cancelled = false;
    setState({ status: "loading" });
    schemaApi
      .getRoutineSignature(
        payload.connectionId,
        payload.schema,
        payload.name,
        payload.routineKind ?? payload.kind,
      )
      .then((sig) => {
        if (cancelled) return;
        const parts = sig.parameters.map(
          (p) => `${p.mode} ${p.name ?? ""} ${p.data_type}`.trim(),
        );
        setState({ status: "loaded", args: parts.join(", "), returns: sig.returns });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        setState({ status: "error", errorMessage: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [
    payload.connectionId,
    payload.schema,
    payload.name,
    payload.kind,
    payload.routineKind,
    isProcedureOrFunction,
  ]);

  if (!isProcedureOrFunction) return null;

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
  if (state.status === "loaded") {
    return (
      <span className={styles.signature}>
        ({state.args})
        {state.returns ? <> → {state.returns}</> : null}
      </span>
    );
  }
  return null;
}

function MssqlObjectPlaceholderTabRoot({ tab }: { tab: Tab; active: boolean }) {
  if (!isPayload(tab.payload)) {
    return <div className={styles.root}>Invalid MSSQL object placeholder payload.</div>;
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
          <RoutineSignatureLine payload={p} />
        </h2>
        <div className={styles.connection}>via {p.connectionName}</div>
        {p.functionType && (
          <div className={styles.connection} style={{ marginTop: 4 }}>
            Type: {p.functionType}
          </div>
        )}
        <p className={styles.message}>
          Viewer not implemented yet — coming in a future change.
        </p>
      </div>
    </div>
  );
}

// Register the tab kind.
TabRegistry.register(MSSQL_OBJECT_PLACEHOLDER_KIND, MssqlObjectPlaceholderTabRoot);

export { MssqlObjectPlaceholderTabRoot };
