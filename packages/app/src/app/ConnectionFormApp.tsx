/**
 * ConnectionFormApp — root component for the `connection-form` window.
 *
 * Reads the intent from Rust (via `connection_form_intent`) on mount and
 * listens for `connection-form:intent-changed` events (when an already-open
 * form is re-triggered for a different connection). Dispatches to the
 * correct engine-specific ConnectionForm based on `intent.kind`.
 *
 * On save → emits `connections:registry-changed` so Manager/Workspace windows
 * refresh. On cancel → closes the window.
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppProviders } from "./AppProviders";
import { useConnections } from "@/platform/connection-registry/useConnections";

// Engine forms (simple mode: postgres, mysql, mssql)
import { ConnectionForm as PostgresConnectionForm } from "@/modules/postgres/ConnectionForm";
import { MysqlConnectionForm } from "@/modules/mysql/ConnectionForm";
import { MssqlConnectionForm } from "@/modules/mssql/ConnectionForm";

// Engine forms (FormMode object: dynamo, athena, cloudwatch)
import { DynamoConnectionForm } from "@/modules/dynamo/ConnectionForm";
import { AthenaConnectionForm } from "@/modules/athena/ConnectionForm";
import { CloudwatchConnectionForm } from "@/modules/cloudwatch/ConnectionForm";

// Kind constants
import { POSTGRES_KIND } from "@/modules/postgres/types";
import { MYSQL_KIND } from "@/modules/mysql/types";
import { MSSQL_KIND } from "@/modules/mssql/types";
import { DYNAMO_KIND } from "@/modules/dynamo/types";
import { ATHENA_KIND } from "@/modules/athena/types";
import { CLOUDWATCH_KIND } from "@/modules/cloudwatch/types";

import type { Connection } from "@/platform/connection-registry/types";

interface FormIntent {
  mode: "create" | "edit" | "duplicate";
  kind: string;
  connectionId?: string;
  subMode?: string;
}

// ---------------------------------------------------------------------------
// ConnectionFormWindow — inner component (needs AppProviders context)
// ---------------------------------------------------------------------------

function ConnectionFormWindow() {
  const [intent, setIntent] = useState<FormIntent | null>(null);
  const { items } = useConnections();

  // Load initial intent from Rust and subscribe to re-trigger events
  useEffect(() => {
    void invoke<FormIntent | null>("connection_form_intent").then((i) => {
      if (i) setIntent(i);
    });

    const unlistenPromise = listen<FormIntent>(
      "connection-form:intent-changed",
      (e) => setIntent(e.payload),
    );

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // Update document title
  useEffect(() => {
    if (!intent) return;
    if (intent.mode === "edit") {
      document.title = "Edit connection";
    } else if (intent.mode === "duplicate") {
      document.title = "Duplicate connection";
    } else {
      document.title = "New connection";
    }
  }, [intent]);

  if (!intent) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: "var(--text-muted, #A0A2AD)", fontSize: 13 }}>
        Loading…
      </div>
    );
  }

  const initial: Connection | undefined = intent.connectionId
    ? items.find((c) => c.id === intent.connectionId)
    : undefined;

  const handleClose = () => {
    void getCurrentWindow().close();
  };

  const handleSaved = () => {
    void emit("connections:registry-changed");
  };

  const handleConnected = () => {
    void emit("connections:registry-changed");
  };

  // Dispatch by kind
  switch (intent.kind) {
    case POSTGRES_KIND:
      return (
        <PostgresConnectionForm
          open
          mode={intent.mode}
          initial={initial}
          onOpenChange={(o) => { if (!o) handleClose(); }}
          onSaved={handleSaved}
          onConnected={handleConnected}
        />
      );
    case MYSQL_KIND:
      return (
        <MysqlConnectionForm
          open
          mode={intent.mode}
          initial={initial}
          onOpenChange={(o) => { if (!o) handleClose(); }}
          onSaved={handleSaved}
          onConnected={handleConnected}
        />
      );
    case MSSQL_KIND:
      return (
        <MssqlConnectionForm
          open
          mode={intent.mode}
          initial={initial}
          onOpenChange={(o) => { if (!o) handleClose(); }}
          onSaved={handleSaved}
          onConnected={handleConnected}
        />
      );
    case DYNAMO_KIND: {
      const dynamoMode =
        intent.mode === "create"
          ? ({ kind: "create" } as const)
          : intent.subMode === "credentials-only" && initial
            ? ({ kind: "credentials-only", connection: initial } as const)
            : intent.mode === "duplicate" && initial
              ? ({ kind: "duplicate", connection: initial } as const)
              : initial
                ? ({ kind: "edit", connection: initial } as const)
                : ({ kind: "create" } as const);
      return (
        <DynamoConnectionForm
          open
          mode={dynamoMode}
          onOpenChange={(o) => { if (!o) handleClose(); }}
          onSaved={handleSaved}
          onConnected={handleConnected}
        />
      );
    }
    case ATHENA_KIND: {
      const athenaMode =
        intent.mode === "create"
          ? ({ kind: "create" } as const)
          : intent.mode === "duplicate" && initial
            ? ({ kind: "duplicate", connection: initial } as const)
            : initial
              ? ({ kind: "edit", connection: initial } as const)
              : ({ kind: "create" } as const);
      return (
        <AthenaConnectionForm
          open
          mode={athenaMode}
          onOpenChange={(o) => { if (!o) handleClose(); }}
          onSaved={handleSaved}
          onConnected={handleConnected}
        />
      );
    }
    case CLOUDWATCH_KIND: {
      const cwMode =
        intent.mode === "create"
          ? ({ kind: "create" } as const)
          : intent.mode === "duplicate" && initial
            ? ({ kind: "duplicate", connection: initial } as const)
            : initial
              ? ({ kind: "edit", connection: initial } as const)
              : ({ kind: "create" } as const);
      return (
        <CloudwatchConnectionForm
          open
          mode={cwMode}
          onOpenChange={(o) => { if (!o) handleClose(); }}
          onSaved={handleSaved}
          onConnected={handleConnected}
        />
      );
    }
    default:
      return (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: "var(--text-muted, #A0A2AD)", fontSize: 13 }}>
          Unknown connection kind: {intent.kind}
        </div>
      );
  }
}

// ---------------------------------------------------------------------------
// ConnectionFormApp — exported root
// ---------------------------------------------------------------------------

export function ConnectionFormApp() {
  return (
    <AppProviders>
      <ConnectionFormWindow />
    </AppProviders>
  );
}
