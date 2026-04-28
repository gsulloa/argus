import { useEffect } from "react";
import { CommandRegistry } from "@/platform/command-palette";
import { useConnections } from "@/platform/connection-registry/useConnections";
import type { Connection } from "@/platform/connection-registry/types";
import { POSTGRES_KIND } from "./types";
import { postgresApi } from "./api";
import { usePostgresForm } from "./FormController";
import { useActiveConnections } from "./useActiveConnections";
import { emitSchemaEvent } from "./schema/events";

interface SelectionApi {
  selectedConnectionId: string | null;
}

const NOOP_SELECTION: SelectionApi = { selectedConnectionId: null };

/**
 * Mount the Postgres palette commands. Should be called once at app root.
 */
export function usePostgresCommands(selection: SelectionApi = NOOP_SELECTION) {
  const form = usePostgresForm();
  const { items } = useConnections();
  const { isActive } = useActiveConnections();

  useEffect(() => {
    const postgresConnections = items.filter((c) => c.kind === POSTGRES_KIND);
    const selected = postgresConnections.find(
      (c) => c.id === selection.selectedConnectionId,
    );

    function pickConnection(): Connection | undefined {
      if (selected) return selected;
      // Fallback: if there's exactly one, use it.
      if (postgresConnections.length === 1) return postgresConnections[0];
      return undefined;
    }

    const unregisters: Array<() => void> = [];

    unregisters.push(
      CommandRegistry.register({
        id: "argus.postgres.new",
        label: "Connection: New Postgres…",
        group: "Connections",
        keywords: ["add", "create", "postgres", "psql"],
        run: () => form.openCreate(),
      }),
    );

    unregisters.push(
      CommandRegistry.register({
        id: "argus.postgres.test",
        label: "Connection: Test…",
        group: "Connections",
        keywords: ["postgres", "verify", "ping"],
        run: async () => {
          const c = pickConnection();
          if (!c) {
            console.warn("[argus] postgres test: no connection selected");
            return;
          }
          form.openEdit(c);
        },
      }),
    );

    unregisters.push(
      CommandRegistry.register({
        id: "argus.postgres.connect",
        label: "Connection: Connect…",
        group: "Connections",
        keywords: ["postgres", "open"],
        run: async () => {
          const c = pickConnection();
          if (!c) {
            console.warn("[argus] postgres connect: no connection selected");
            return;
          }
          if (isActive(c.id)) return;
          try {
            await postgresApi.connect(c.id);
          } catch (e) {
            console.error("[argus] connect failed:", e);
          }
        },
      }),
    );

    unregisters.push(
      CommandRegistry.register({
        id: "argus.postgres.disconnect",
        label: "Connection: Disconnect…",
        group: "Connections",
        keywords: ["postgres", "close"],
        run: async () => {
          const c = pickConnection();
          if (!c) return;
          try {
            await postgresApi.disconnect(c.id);
          } catch (e) {
            console.error("[argus] disconnect failed:", e);
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

    unregisters.push(
      CommandRegistry.register({
        id: "argus.schema.refresh",
        label: "Schema: Refresh",
        group: "Schema",
        keywords: ["postgres", "reload", "catalog"],
        run: () => {
          const c = pickActiveConnection();
          if (!c) {
            console.warn("[argus] schema refresh: no active connection");
            return;
          }
          emitSchemaEvent({ type: "invalidate", connectionId: c.id });
        },
      }),
    );

    unregisters.push(
      CommandRegistry.register({
        id: "argus.schema.filter",
        label: "Schema: Filter Visible…",
        group: "Schema",
        keywords: ["postgres", "schemas", "filter", "show"],
        run: () => {
          const c = pickActiveConnection();
          if (!c) {
            console.warn("[argus] schema filter: no active connection");
            return;
          }
          emitSchemaEvent({ type: "openPicker", connectionId: c.id });
        },
      }),
    );

    return () => unregisters.forEach((u) => u());
  }, [form, items, selection.selectedConnectionId, isActive]);
}
