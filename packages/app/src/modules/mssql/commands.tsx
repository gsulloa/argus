import { useEffect } from "react";
import { CommandRegistry } from "@/platform/command-palette";
import { useConnections } from "@/platform/connection-registry/useConnections";
import type { Connection } from "@/platform/connection-registry/types";
import { useTabs } from "@/platform/shell/tabs";
import { MSSQL_KIND } from "./types";
import { mssqlApi } from "./api";
import { useMssqlForm } from "./FormController";
import { useActiveMssqlConnections } from "./useActiveConnections";
import { openMssqlQueryTab } from "./openMssqlQueryTab";

interface SelectionApi {
  selectedConnectionId: string | null;
}

const NOOP_SELECTION: SelectionApi = { selectedConnectionId: null };

/**
 * Mount the MS SQL Server palette commands. Should be called once at app root.
 */
export function useMssqlCommands(selection: SelectionApi = NOOP_SELECTION) {
  const form = useMssqlForm();
  const { items } = useConnections();
  const { isActive } = useActiveMssqlConnections();
  const tabs = useTabs();

  useEffect(() => {
    const mssqlConnections = items.filter((c) => c.kind === MSSQL_KIND);
    const selected = mssqlConnections.find(
      (c) => c.id === selection.selectedConnectionId,
    );

    function pickConnection(): Connection | undefined {
      if (selected) return selected;
      if (mssqlConnections.length === 1) return mssqlConnections[0];
      return undefined;
    }

    function pickActiveConnection(): Connection | undefined {
      const c = pickConnection();
      if (!c) return undefined;
      if (!isActive(c.id)) return undefined;
      return c;
    }

    const unregisters: Array<() => void> = [];

    // §16.1 — Register "Connection: New MS SQL Server…" palette command
    unregisters.push(
      CommandRegistry.register({
        id: "argus.mssql.new",
        label: "Connection: New MS SQL Server…",
        group: "Connections",
        keywords: ["add", "create", "mssql", "sqlserver", "microsoft", "sql server"],
        run: () => form.openCreate(),
      }),
    );

    // §16.2 — Wire shared connection commands for MS SQL Server
    unregisters.push(
      CommandRegistry.register({
        id: "argus.mssql.test",
        label: "Connection: Test MS SQL Server…",
        group: "Connections",
        keywords: ["mssql", "verify", "ping", "sql server"],
        run: async () => {
          const c = pickConnection();
          if (!c) {
            console.warn("[argus] mssql test: no connection selected");
            return;
          }
          form.openEdit(c);
        },
      }),
    );

    unregisters.push(
      CommandRegistry.register({
        id: "argus.mssql.connect",
        label: "Connection: Connect MS SQL Server…",
        group: "Connections",
        keywords: ["mssql", "open", "sql server"],
        run: async () => {
          const c = pickConnection();
          if (!c) {
            console.warn("[argus] mssql connect: no connection selected");
            return;
          }
          if (isActive(c.id)) return;
          try {
            await mssqlApi.connect(c.id);
          } catch (e) {
            console.error("[argus] mssql connect failed:", e);
          }
        },
      }),
    );

    unregisters.push(
      CommandRegistry.register({
        id: "argus.mssql.disconnect",
        label: "Connection: Disconnect MS SQL Server…",
        group: "Connections",
        keywords: ["mssql", "close", "sql server"],
        run: async () => {
          const c = pickConnection();
          if (!c) return;
          try {
            await mssqlApi.disconnect(c.id);
          } catch (e) {
            console.error("[argus] mssql disconnect failed:", e);
          }
        },
      }),
    );

    // §16.3 — Wire SQL: New Query for MS SQL Server
    unregisters.push(
      CommandRegistry.register({
        id: "argus.mssql.sql.newQuery",
        label: "SQL: New Query (MS SQL Server)",
        group: "SQL",
        keywords: ["mssql", "query", "sql", "editor", "run", "sql server"],
        run: () => {
          const c = pickActiveConnection();
          if (!c) {
            console.warn("[argus] mssql new query: no active connection");
            return;
          }
          openMssqlQueryTab(tabs, {
            connectionId: c.id,
            connectionName: c.name,
            sql: "",
          });
        },
      }),
    );

    // §16.3 — Wire SQL: New Query Here for MS SQL Server
    unregisters.push(
      CommandRegistry.register({
        id: "argus.mssql.sql.newQueryHere",
        label: "SQL: New Query Here (MS SQL Server)",
        group: "SQL",
        keywords: ["mssql", "query", "here", "context", "sql server"],
        run: () => {
          const c = pickActiveConnection();
          if (!c) {
            console.warn("[argus] mssql new query here: no active connection");
            return;
          }
          // Without focused schema/table context, open empty buffer.
          // Phase F2/G will extend this to supply schema/relation context.
          openMssqlQueryTab(tabs, {
            connectionId: c.id,
            connectionName: c.name,
            sql: "",
          });
        },
      }),
    );

    return () => unregisters.forEach((u) => u());
  }, [form, items, selection.selectedConnectionId, isActive, tabs]);
}

// ---------------------------------------------------------------------------
// Helpers: bracket-safe SQL templates for SQL: New Query Here (§16.3)
// ---------------------------------------------------------------------------

/**
 * Escape an MS SQL Server identifier by wrapping in square brackets and
 * doubling any embedded `]` characters.
 */
export function mssqlQuoteIdent(name: string): string {
  return "[" + name.replace(/]/g, "]]") + "]";
}

/**
 * Build the context-aware SQL snippet for "SQL: New Query Here":
 * - Connection focused → empty buffer
 * - Schema focused → `-- schema: [schema]\n` comment header
 *   (USE switches databases in SQL Server, not schemas)
 * - Table/view focused → `SELECT TOP 100 * FROM [schema].[relation];`
 */
export function buildNewQueryHereSql(
  context: "connection" | "schema" | "table",
  schema?: string,
  relation?: string,
): string {
  if (context === "schema" && schema) {
    return `-- schema: ${mssqlQuoteIdent(schema)}\n\n`;
  }
  if (context === "table" && schema && relation) {
    return `SELECT TOP 100 * FROM ${mssqlQuoteIdent(schema)}.${mssqlQuoteIdent(relation)};\n`;
  }
  return "";
}
