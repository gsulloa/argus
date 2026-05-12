/**
 * useDynamoTablesPaletteCommands — Task group 11.
 *
 * Registers palette commands for DynamoDB table browsing:
 *
 *  1. Static "Tables: Refresh" command (always registered, keepOpen: true).
 *     When no Dynamo connection is focused, shows a toast fallback rather than
 *     an inline chooser (see report for rationale).
 *
 *  2. Dynamic per-table commands: one Command per cached table name for every
 *     connection whose cache is in "ready" status. Re-registered whenever the
 *     allConnections snapshot changes.
 *
 * Mount once near app root (inside DynamoTablesCacheProvider + TabsProvider).
 */

import { useEffect } from "react";
import { CommandRegistry } from "@/platform/command-palette";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { useTabs } from "@/platform/shell/tabs";
import { useToast } from "@/platform/toast";
import { DYNAMO_KIND } from "@/modules/dynamo/types";
import { useActiveDynamoConnections } from "@/modules/dynamo/useActiveConnections";
import { useDynamoTableCacheRegistry } from "./CacheProvider";
import { openPlaceholderTab } from "./openPlaceholderTab";

interface SelectionApi {
  selectedConnectionId: string | null;
}

const NOOP_SELECTION: SelectionApi = { selectedConnectionId: null };

export function useDynamoTablesPaletteCommands(selection: SelectionApi = NOOP_SELECTION) {
  const { allConnections, getCache, refresh } = useDynamoTableCacheRegistry();
  const { items: allConnItems } = useConnections();
  const { isActive } = useActiveDynamoConnections();
  const tabs = useTabs();
  const toast = useToast();

  // Build a map of connectionId → connection name for label construction.
  const connNameById = (() => {
    const m = new Map<string, string>();
    for (const c of allConnItems) {
      if (c.kind === DYNAMO_KIND) m.set(c.id, c.name);
    }
    return m;
  })();

  // -------------------------------------------------------------------------
  // §11.1 — Static "Tables: Refresh" command
  // -------------------------------------------------------------------------
  useEffect(() => {
    const unregister = CommandRegistry.register({
      id: "argus.dynamo.tables.refresh",
      label: "Tables: Refresh",
      group: "Tables",
      keywords: ["dynamo", "tables", "refresh", "reload", "cache"],
      keepOpen: true,
      run: () => {
        // Try focused connection first, then fall back to the only active dynamo.
        const focusedId = selection.selectedConnectionId;
        if (focusedId && isActive(focusedId) && connNameById.has(focusedId)) {
          refresh(focusedId);
          return;
        }

        // Fallback: find all currently active dynamo connections that have a cache.
        const activeDynamoWithCache = allConnections.filter(
          (snap) => connNameById.has(snap.connectionId) && isActive(snap.connectionId),
        );

        if (activeDynamoWithCache.length === 1) {
          refresh(activeDynamoWithCache[0]!.connectionId);
          return;
        }

        // Toast fallback (no inline chooser this wave — see report).
        toast.show("Focus a DynamoDB connection in the sidebar first", "info");
      },
    });
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.selectedConnectionId, isActive, refresh, allConnections, toast]);

  // -------------------------------------------------------------------------
  // §11.2 / 11.3 / 11.4 — Dynamic per-table commands
  //
  // We register/unregister in a useEffect that watches allConnections.
  // Every time allConnections changes (cache ready/dropped/appended),
  // we tear down the old set of commands and register the new set.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const unregisters: Array<() => void> = [];

    for (const snap of allConnections) {
      if (snap.tables.status !== "ready") continue;

      const { connectionId } = snap;
      const connectionName = connNameById.get(connectionId);
      if (!connectionName) continue;

      const { names } = snap.tables;
      const cache = getCache(connectionId);

      for (const tableName of names) {
        const id = `argus.dynamo.openTable:${connectionId}:${tableName}`;
        const describe =
          cache?.describe.get(tableName)?.status === "ready"
            ? cache.describe.get(tableName)!
            : null;

        unregisters.push(
          CommandRegistry.register({
            id,
            label: `${connectionName} · ${tableName}`,
            group: "Tables",
            keywords: [connectionName, tableName, "dynamo"],
            run: () => {
              const cachedDescribe =
                describe?.status === "ready" ? describe.value : null;
              openPlaceholderTab(tabs, {
                connectionId,
                connectionName,
                tableName,
                describe: cachedDescribe,
              });
            },
          }),
        );
      }
    }

    return () => {
      for (const u of unregisters) u();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allConnections, tabs, getCache]);
}
