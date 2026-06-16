/**
 * §23.7 — MySQL Object Placeholder tab.
 *
 * Tab kind: "mysql-object-placeholder"
 * Payload: MysqlObjectPlaceholderPayload (from openObjectTab.ts)
 *
 * Rendered for MySQL objects that don't have a full viewer in v1:
 * routines, triggers, events, indexes, foreign-keys.
 * Mirrors the style of postgres-object-placeholder.
 */

import { useEffect, useState } from "react";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import type { Tab } from "@/platform/shell/tabs/types";
import { AppError } from "@/platform/errors/AppError";
import { schemaApi } from "./schema/api";
import type { MysqlObjectPlaceholderPayload } from "./schema/openObjectTab";
import { MYSQL_OBJECT_PLACEHOLDER_KIND } from "./schema/openObjectTab";
import styles from "@/platform/shell/tabs/postgres-object-placeholder.module.css";

const KIND_LABEL: Record<string, string> = {
  table: "Table",
  view: "View",
  routine: "Routine",
  trigger: "Trigger",
  event: "Event",
  index: "Index",
  foreign_key: "Foreign Key",
};

function isPayload(v: unknown): v is MysqlObjectPlaceholderPayload {
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
  errorMessage?: string;
}

function RoutineSignatureLine({ payload }: { payload: MysqlObjectPlaceholderPayload }) {
  const [state, setState] = useState<RoutineSignatureState>({ status: "idle" });

  useEffect(() => {
    if (payload.kind !== "routine" || !payload.routineKind) return;
    let cancelled = false;
    setState({ status: "loading" });
    schemaApi
      .getRoutineSignature(
        payload.connectionId,
        payload.schema,
        payload.name,
        payload.routineKind,
      )
      .then((sig) => {
        if (cancelled) return;
        // Build a param list string: "IN name TYPE, OUT name TYPE, ..."
        const parts = sig.parameters.map(
          (p) => `${p.mode} ${p.name} ${p.data_type}`,
        );
        setState({ status: "loaded", args: parts.join(", ") });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        setState({ status: "error", errorMessage: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [payload.connectionId, payload.schema, payload.name, payload.kind, payload.routineKind]);

  if (payload.kind !== "routine" || !payload.routineKind) return null;

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

function MysqlObjectPlaceholderTabRoot({ tab }: { tab: Tab; active: boolean }) {
  if (!isPayload(tab.payload)) {
    return <div className={styles.root}>Invalid MySQL object placeholder payload.</div>;
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
        <p className={styles.message}>
          Viewer not implemented yet — coming in a future change.
        </p>
      </div>
    </div>
  );
}

// Register the tab kind.
TabRegistry.register(MYSQL_OBJECT_PLACEHOLDER_KIND, MysqlObjectPlaceholderTabRoot);

export { MysqlObjectPlaceholderTabRoot };
