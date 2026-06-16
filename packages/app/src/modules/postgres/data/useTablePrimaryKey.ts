import { useEffect, useState } from "react";
import { AppError } from "@/platform/errors/AppError";
import { dataApi } from "./api";
import type { TableEditMetadata } from "./types";

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

interface State {
  status: "idle" | "loading" | "ready" | "error";
  metadata: TableEditMetadata | null;
  error: AppError | null;
}

const initial: State = { status: "idle", metadata: null, error: null };

/**
 * Fetch the relation's PK columns + enum metadata once per
 * (connection, schema, relation). Returned `metadata.pk_columns` is `null`
 * for views/relations without a primary key — the caller uses that to gate
 * UPDATE/DELETE edit affordances.
 */
export function useTablePrimaryKey(
  connectionId: string,
  schema: string,
  relation: string,
): State & { refresh: () => void } {
  const [state, setState] = useState<State>(initial);

  useEffect(() => {
    if (!isTauriRuntime()) {
      setState({ status: "ready", metadata: { pk_columns: null, enums: {} }, error: null });
      return;
    }
    let cancelled = false;
    setState({ status: "loading", metadata: null, error: null });
    dataApi
      .tablePrimaryKey(connectionId, schema, relation, "auto")
      .then((md) => {
        if (cancelled) return;
        setState({ status: "ready", metadata: md, error: null });
      })
      .catch((e) => {
        if (cancelled) return;
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        setState({ status: "error", metadata: null, error: err });
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, schema, relation]);

  function refresh() {
    setState({ status: "idle", metadata: null, error: null });
    setState({ status: "loading", metadata: null, error: null });
    dataApi
      .tablePrimaryKey(connectionId, schema, relation, "auto")
      .then((md) => setState({ status: "ready", metadata: md, error: null }))
      .catch((e) => {
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        setState({ status: "error", metadata: null, error: err });
      });
  }

  return { ...state, refresh };
}
