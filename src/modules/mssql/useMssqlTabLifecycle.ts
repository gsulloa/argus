/**
 * useMssqlTabLifecycle — singleton effect that closes open MSSQL tabs when
 * the owning connection is disconnected or deleted (§23.8).
 *
 * Two signals are observed:
 *
 *   1. `mssql:active-changed` (Tauri backend event): fires whenever the set of
 *      active MSSQL connections changes. When a connection that previously had
 *      open MSSQL tabs is no longer in the active list, we close those tabs.
 *
 *   2. Connection list change from `useConnections`: when a connection id that
 *      previously appeared in `items` is no longer present, the connection has
 *      been deleted. We close its MSSQL tabs.
 *
 * Mount this hook once at app root (inside Shell, alongside MssqlCommands).
 *
 * All MSSQL tab kinds carry `connectionId` in their payload, so we close any
 * tab with a `connectionId` matching the disconnected connection, regardless
 * of kind ("mssql-query", "mssql-table-data", "mssql-object-placeholder").
 */

import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTabs } from "@/platform/shell/tabs";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { MSSQL_KIND } from "./types";
import { mssqlApi } from "./api";

function isTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

/** Close all MSSQL tabs for the given connection id. */
function closeMssqlTabsForConnection(
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

export function useMssqlTabLifecycle() {
  const tabs = useTabs();
  const { items: allConnections } = useConnections();

  // ---------------------------------------------------------------------------
  // 23.8a — Close tabs when a MSSQL connection becomes inactive
  //
  // `mssql:active-changed` fires when any MSSQL connection connects or
  // disconnects. We compare the newly-active set against the previous active
  // set and close tabs for any connection that dropped out.
  // ---------------------------------------------------------------------------
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let prevActiveIds = new Set<string>();

    // Bootstrap with the initial active list.
    mssqlApi
      .listActive()
      .then((list) => {
        prevActiveIds = new Set(list.map((c) => c.id));
      })
      .catch(() => {
        // non-fatal — prevActiveIds stays empty
      });

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<unknown>("mssql:active-changed", () => {
      mssqlApi
        .listActive()
        .then((list) => {
          const nextActiveIds = new Set(list.map((c) => c.id));

          // Close tabs for connections that were active but are now inactive.
          for (const id of prevActiveIds) {
            if (!nextActiveIds.has(id)) {
              closeMssqlTabsForConnection(tabsRef.current, id);
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
  // 23.8b — Close tabs when a MSSQL connection is deleted
  //
  // `useConnections` re-renders when items changes. We track the previous list
  // of MSSQL connection ids and close tabs for any id that disappeared.
  // ---------------------------------------------------------------------------
  const prevMssqlIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const currentIds = new Set(
      allConnections.filter((c) => c.kind === MSSQL_KIND).map((c) => c.id),
    );

    const prev = prevMssqlIdsRef.current;

    // First mount: populate prev and exit without closing anything.
    if (prev.size === 0 && currentIds.size > 0) {
      prevMssqlIdsRef.current = currentIds;
      return;
    }

    // Detect deleted connections.
    for (const id of prev) {
      if (!currentIds.has(id)) {
        closeMssqlTabsForConnection(tabsRef.current, id);
      }
    }

    prevMssqlIdsRef.current = currentIds;
  }, [allConnections]);
}
