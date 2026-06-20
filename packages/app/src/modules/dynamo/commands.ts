import { useEffect } from "react";
import { CommandRegistry } from "@/platform/command-palette";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { useTabs } from "@/platform/shell/tabs";
import { DYNAMO_KIND } from "./types";
import { dynamoApi } from "./api";
import { useDynamoForm } from "./FormController";
import { useActiveDynamoConnections } from "./useActiveConnections";
import { openDynamoPartiQLTab } from "./sql";

interface SelectionApi {
  selectedConnectionId: string | null;
}

const NOOP_SELECTION: SelectionApi = { selectedConnectionId: null };

/**
 * Mount the DynamoDB palette commands. Should be called once at app root.
 */
export function useDynamoCommands(selection: SelectionApi = NOOP_SELECTION) {
  const form = useDynamoForm();
  const { items } = useConnections();
  const { isActive } = useActiveDynamoConnections();
  const tabs = useTabs();

  useEffect(() => {
    const dynamoConnections = items.filter((c) => c.kind === DYNAMO_KIND);
    const selected = dynamoConnections.find(
      (c) => c.id === selection.selectedConnectionId,
    );

    function pickConnection() {
      if (selected) return selected;
      // Fallback: if there's exactly one dynamo connection, use it.
      if (dynamoConnections.length === 1) return dynamoConnections[0];
      return undefined;
    }

    const unregisters: Array<() => void> = [];

    // §13.1 — New DynamoDB
    unregisters.push(
      CommandRegistry.register({
        id: "argus.dynamo.new",
        label: "Connection: New DynamoDB…",
        group: "Connections",
        keywords: ["add", "create", "dynamodb", "aws", "new"],
        run: () => form.openCreate(),
      }),
    );

    // §13.2 — Test (with chooser fallback: open edit form when no selection)
    unregisters.push(
      CommandRegistry.register({
        id: "argus.dynamo.test",
        label: "Connection: Test… (DynamoDB)",
        group: "Connections",
        keywords: ["test", "dynamodb", "aws", "verify", "ping"],
        run: async () => {
          const c = pickConnection();
          if (!c) {
            // No dynamo connections at all — open create form.
            if (dynamoConnections.length === 0) {
              form.openCreate();
              return;
            }
            console.warn("[argus] dynamo test: no connection selected");
            return;
          }
          form.openEdit(c);
        },
      }),
    );

    // §13.2 — Connect
    unregisters.push(
      CommandRegistry.register({
        id: "argus.dynamo.connect",
        label: "Connection: Connect… (DynamoDB)",
        group: "Connections",
        keywords: ["connect", "dynamodb", "aws"],
        run: async () => {
          const c = pickConnection();
          if (!c) {
            console.warn("[argus] dynamo connect: no connection selected");
            return;
          }
          if (isActive(c.id)) return;
          try {
            await dynamoApi.connect(c.id);
          } catch (e) {
            console.error("[argus] dynamo connect failed:", e);
          }
        },
      }),
    );

    // §13.2 — Disconnect
    unregisters.push(
      CommandRegistry.register({
        id: "argus.dynamo.disconnect",
        label: "Connection: Disconnect… (DynamoDB)",
        group: "Connections",
        keywords: ["disconnect", "dynamodb", "aws"],
        run: async () => {
          const c = pickConnection();
          if (!c) return;
          try {
            await dynamoApi.disconnect(c.id);
          } catch (e) {
            console.error("[argus] dynamo disconnect failed:", e);
          }
        },
      }),
    );

    // New PartiQL query for the focused/active DynamoDB connection
    unregisters.push(
      CommandRegistry.register({
        id: "argus.dynamo.newPartiQLQuery",
        label: "Dynamo: New PartiQL query",
        group: "Dynamo",
        keywords: ["partiql", "query", "dynamodb", "aws", "new", "editor", "sql"],
        run: () => {
          const c = pickConnection();
          if (!c) {
            console.warn("[argus] dynamo new PartiQL query: no connection selected");
            return;
          }
          if (!isActive(c.id)) {
            console.warn("[argus] dynamo new PartiQL query: connection not active");
            return;
          }
          openDynamoPartiQLTab(tabs, c.id, c.name);
        },
      }),
    );

    return () => unregisters.forEach((u) => u());
  }, [form, items, selection.selectedConnectionId, isActive, tabs]);
}
