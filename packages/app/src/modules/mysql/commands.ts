import { useEffect } from "react";
import { CommandRegistry } from "@/platform/command-palette";
import { useConnections } from "@/platform/connection-registry/useConnections";
import type { Connection } from "@/platform/connection-registry/types";
import { useTabs } from "@/platform/shell/tabs";
import { MYSQL_KIND } from "./types";
import { mysqlApi } from "./api";
import { useMysqlForm } from "./FormController";
import { useActiveMysqlConnections } from "./useActiveConnections";
import { openMysqlQueryTab } from "./openMysqlQueryTab";
import { emitMysqlSchemaEvent, refreshConnection } from "./schema/events";

interface SelectionApi {
  selectedConnectionId: string | null;
}

const NOOP_SELECTION: SelectionApi = { selectedConnectionId: null };

/**
 * Mount the MySQL palette commands. Should be called once at app root.
 */
export function useMysqlCommands(selection: SelectionApi = NOOP_SELECTION) {
  const form = useMysqlForm();
  const { items } = useConnections();
  const { isActive } = useActiveMysqlConnections();
  const tabs = useTabs();

  useEffect(() => {
    const mysqlConnections = items.filter((c) => c.kind === MYSQL_KIND);
    const selected = mysqlConnections.find(
      (c) => c.id === selection.selectedConnectionId,
    );

    function pickConnection(): Connection | undefined {
      if (selected) return selected;
      // Fallback: if there's exactly one, use it.
      if (mysqlConnections.length === 1) return mysqlConnections[0];
      return undefined;
    }

    const unregisters: Array<() => void> = [];

    // §16.1 — Register "Connection: New MySQL…" palette command
    unregisters.push(
      CommandRegistry.register({
        id: "argus.mysql.new",
        label: "Connection: New MySQL…",
        group: "Connections",
        keywords: ["add", "create", "mysql", "mariadb"],
        run: () => form.openCreate(),
      }),
    );

    // §16.2 — Wire shared connection commands to route by kind === "mysql"
    unregisters.push(
      CommandRegistry.register({
        id: "argus.mysql.test",
        label: "Connection: Test MySQL…",
        group: "Connections",
        keywords: ["mysql", "verify", "ping"],
        run: async () => {
          const c = pickConnection();
          if (!c) {
            console.warn("[argus] mysql test: no connection selected");
            return;
          }
          form.openEdit(c);
        },
      }),
    );

    unregisters.push(
      CommandRegistry.register({
        id: "argus.mysql.connect",
        label: "Connection: Connect MySQL…",
        group: "Connections",
        keywords: ["mysql", "open"],
        run: async () => {
          const c = pickConnection();
          if (!c) {
            console.warn("[argus] mysql connect: no connection selected");
            return;
          }
          if (isActive(c.id)) return;
          try {
            await mysqlApi.connect(c.id);
          } catch (e) {
            console.error("[argus] mysql connect failed:", e);
          }
        },
      }),
    );

    unregisters.push(
      CommandRegistry.register({
        id: "argus.mysql.disconnect",
        label: "Connection: Disconnect MySQL…",
        group: "Connections",
        keywords: ["mysql", "close"],
        run: async () => {
          const c = pickConnection();
          if (!c) return;
          try {
            await mysqlApi.disconnect(c.id);
          } catch (e) {
            console.error("[argus] mysql disconnect failed:", e);
          }
        },
      }),
    );

    function pickActiveConnection(): Connection | undefined {
      const c = pickConnection();
      if (!c) return undefined;
      if (!isActive(c.id)) return undefined;
      return c;
    }

    // §16.3 — Wire Schema: Refresh for MySQL connections
    unregisters.push(
      CommandRegistry.register({
        id: "argus.mysql.schema.refresh",
        label: "Schema: Refresh (MySQL)",
        group: "Schema",
        keywords: ["mysql", "reload", "catalog"],
        run: () => {
          const c = pickActiveConnection();
          if (!c) {
            console.warn("[argus] mysql schema refresh: no active connection");
            return;
          }
          refreshConnection(c.id);
        },
      }),
    );

    // §16.3 — Wire Schema: Filter Visible… for MySQL connections
    unregisters.push(
      CommandRegistry.register({
        id: "argus.mysql.schema.filter",
        label: "Schema: Filter Visible… (MySQL)",
        group: "Schema",
        keywords: ["mysql", "databases", "filter", "show"],
        run: () => {
          const c = pickActiveConnection();
          if (!c) {
            console.warn("[argus] mysql schema filter: no active connection");
            return;
          }
          emitMysqlSchemaEvent({ type: "openPicker", connectionId: c.id });
        },
      }),
    );

    // §16.3 — Wire SQL: New Query for MySQL connections
    unregisters.push(
      CommandRegistry.register({
        id: "argus.mysql.sql.newQuery",
        label: "SQL: New Query (MySQL)",
        group: "SQL",
        keywords: ["mysql", "query", "sql", "editor", "run"],
        run: () => {
          const c = pickActiveConnection();
          if (!c) {
            console.warn("[argus] mysql new query: no active connection");
            return;
          }
          openMysqlQueryTab(tabs, {
            connectionId: c.id,
            connectionName: c.name,
            sql: "",
          });
        },
      }),
    );

    // §16.3 — Wire SQL: New Query Here for MySQL connections
    // Context-aware: emits backtick-quoted SQL based on what is focused
    unregisters.push(
      CommandRegistry.register({
        id: "argus.mysql.sql.newQueryHere",
        label: "SQL: New Query Here (MySQL)",
        group: "SQL",
        keywords: ["mysql", "query", "here", "context"],
        run: () => {
          const c = pickActiveConnection();
          if (!c) {
            console.warn("[argus] mysql new query here: no active connection");
            return;
          }
          // Without focused schema/table context, open empty buffer.
          // Phase F2/G will extend this to supply schema/relation context.
          openMysqlQueryTab(tabs, {
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
// Helpers: backtick-safe SQL templates for SQL: New Query Here (§16.3)
// ---------------------------------------------------------------------------

/**
 * Escape a MySQL identifier by wrapping in backticks and doubling any
 * embedded backtick characters.
 */
export function mysqlQuoteIdent(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

/**
 * Build the context-aware SQL snippet for "SQL: New Query Here":
 * - Connection focused → empty buffer
 * - Schema focused → `USE \`schema\`;`
 * - Table/view focused → `SELECT * FROM \`schema\`.\`relation\` LIMIT 100;`
 */
export function buildNewQueryHereSql(
  context: "connection" | "schema" | "table",
  schema?: string,
  relation?: string,
): string {
  if (context === "schema" && schema) {
    return `USE ${mysqlQuoteIdent(schema)};\n\n`;
  }
  if (context === "table" && schema && relation) {
    return `SELECT * FROM ${mysqlQuoteIdent(schema)}.${mysqlQuoteIdent(relation)} LIMIT 100;\n`;
  }
  return "";
}
