/**
 * useMysqlTabLifecycle — singleton effect that closes open MySQL tabs when
 * the owning connection is disconnected or deleted (§23.8).
 *
 * Two signals are observed:
 *
 *   1. `mysql:active-changed` (Tauri backend event): fires whenever the set of
 *      active MySQL connections changes. When a connection that previously had
 *      open MySQL tabs is no longer in the active list, we close those tabs.
 *
 *   2. Connection list change from `useConnections`: when a connection id that
 *      previously appeared in `items` is no longer present, the connection has
 *      been deleted. We close its MySQL tabs.
 *
 * Mount this hook once at app root (inside Shell, alongside MysqlCommands).
 *
 * All MySQL tab kinds carry `connectionId` in their payload, so we close any
 * tab with a `connectionId` matching the disconnected connection, regardless
 * of kind ("mysql-query", "mysql-table-data", "mysql-object-placeholder").
 */

import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTabs } from "@/platform/shell/tabs";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { MYSQL_KIND } from "./types";
import { mysqlApi } from "./api";

function isTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

/** Close all MySQL tabs for the given connection id. */
function closeMysqlTabsForConnection(
  tabs: ReturnType<typeof useTabs>,
  connectionId: string,
): void {
  const toClose = tabs.tabs.filter((t) => {
    const payload = t.payload as { connectionId?: unknown } | null | undefined;
    return (
      typeof payload === "object" &&
      payload !== null &&
      payload.connectionId === connectionId
    );
  });
  for (const tab of toClose) {
    tabs.close(tab.id);
  }
}

export function useMysqlTabLifecycle() {
  const tabs = useTabs();
  const { items: allConnections } = useConnections();

  // ---------------------------------------------------------------------------
  // 23.8a — Close tabs when a MySQL connection becomes inactive
  //
  // `mysql:active-changed` fires when any MySQL connection connects or
  // disconnects. We compare the newly-active set against the previous active
  // set and close tabs for any connection that dropped out.
  // ---------------------------------------------------------------------------
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let prevActiveIds = new Set<string>();

    // Bootstrap with the initial active list.
    mysqlApi
      .listActive()
      .then((list) => {
        prevActiveIds = new Set(list.map((c) => c.id));
      })
      .catch(() => {
        // non-fatal — prevActiveIds stays empty
      });

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<unknown>("mysql:active-changed", () => {
      mysqlApi
        .listActive()
        .then((list) => {
          const nextActiveIds = new Set(list.map((c) => c.id));

          // Close tabs for connections that were active but are now inactive.
          for (const id of prevActiveIds) {
            if (!nextActiveIds.has(id)) {
              closeMysqlTabsForConnection(tabsRef.current, id);
            }
          }

          prevActiveIds = nextActiveIds;
        })
        .catch(() => {
          // non-fatal — leave tabs open on error
        });
    })
      .then((u) => {
        if (cancelled) {
          u();
        } else {
          unlisten = u;
        }
      })
      .catch(() => {
        // tauri event listen failed — non-fatal
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []); // mount-only; tabsRef keeps the close function current

  // ---------------------------------------------------------------------------
  // 23.8b — Close tabs when a MySQL connection is deleted
  //
  // `useConnections` re-renders when items changes. We track the previous list
  // of MySQL connection ids and close tabs for any id that disappeared.
  // ---------------------------------------------------------------------------
  const prevMysqlIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const currentIds = new Set(
      allConnections.filter((c) => c.kind === MYSQL_KIND).map((c) => c.id),
    );

    const prev = prevMysqlIdsRef.current;

    // First mount: populate prev and exit without closing anything.
    if (prev.size === 0 && currentIds.size > 0) {
      prevMysqlIdsRef.current = currentIds;
      return;
    }

    // Detect deleted connections.
    for (const id of prev) {
      if (!currentIds.has(id)) {
        closeMysqlTabsForConnection(tabsRef.current, id);
      }
    }

    prevMysqlIdsRef.current = currentIds;
  }, [allConnections]);
}
