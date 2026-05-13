/**
 * useDataViewLifecycle — module-level singleton effect that closes any open
 * dynamo-data-view tabs when the owning connection is disconnected or deleted.
 *
 * Two signals are observed:
 *
 *   1. `dynamo:active-changed` (Tauri backend event): fires whenever the set of
 *      active Dynamo connections changes. When a connection that previously had
 *      open data-view tabs is no longer in the active list, we close those tabs.
 *
 *   2. Connection list change from `useConnections`: when a connection id that
 *      previously appeared in `items` is no longer present, the connection has
 *      been deleted. We close its data-view tabs.
 *
 * Mount this hook once at app root (inside Shell, alongside DynamoCommands).
 * It reads `tabs` from `useTabs` and `items` from `useConnections` — both are
 * stable context values that do not require cleanup on unmount beyond the
 * standard event unlisten.
 *
 * Decision: hook lives at module level (not in DataViewTab) so that closing
 * happens even when all data-view tabs have already been unmounted (unlikely,
 * but keeps the lifecycle model clean).
 *
 * Only tabs with kind "dynamo-data-view" and a matching `connectionId` in their
 * payload are affected. Other tab kinds are untouched.
 */

import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTabs } from "@/platform/shell/tabs";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { DYNAMO_KIND } from "@/modules/dynamo/types";
import { dynamoApi } from "@/modules/dynamo/api";
import { DYNAMO_DATA_VIEW_KIND } from "./DataViewTab";

function isTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

/** Close all dynamo-data-view tabs for the given connection id. */
function closeDataViewTabsForConnection(
  tabs: ReturnType<typeof useTabs>,
  connectionId: string,
): void {
  const toClose = tabs.tabs.filter((t) => {
    if (t.kind !== DYNAMO_DATA_VIEW_KIND) return false;
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

export function useDataViewLifecycle() {
  const tabs = useTabs();
  const { items: allConnections } = useConnections();

  // ---------------------------------------------------------------------------
  // 15.1 — Close tabs when a Dynamo connection becomes inactive
  //
  // `dynamo:active-changed` fires when any Dynamo connection connects or
  // disconnects. We compare the newly-active set against the previous active
  // set and close tabs for any connection that dropped out.
  // ---------------------------------------------------------------------------
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
    if (!isTauriRuntime()) return;

    // Keep a ref to the previous active set so we can detect transitions.
    let prevActiveIds = new Set<string>();

    // Bootstrap with the initial active list.
    dynamoApi
      .listActive()
      .then((list) => {
        prevActiveIds = new Set(list.map((c) => c.id));
      })
      .catch(() => {
        // non-fatal — prevActiveIds stays empty; worst case we close extra tabs
        // on the first event (unlikely, treat as acceptable)
      });

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<unknown>("dynamo:active-changed", () => {
      // Fetch the updated active list.
      dynamoApi
        .listActive()
        .then((list) => {
          const nextActiveIds = new Set(list.map((c) => c.id));

          // Close tabs for connections that were active but are now inactive.
          for (const id of prevActiveIds) {
            if (!nextActiveIds.has(id)) {
              closeDataViewTabsForConnection(tabsRef.current, id);
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
  // 15.2 — Close tabs when a Dynamo connection is deleted
  //
  // `useConnections` re-renders when items changes. We track the previous list
  // of Dynamo connection ids and close data-view tabs for any id that disappeared.
  // ---------------------------------------------------------------------------
  const prevDynamoIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const currentIds = new Set(
      allConnections.filter((c) => c.kind === DYNAMO_KIND).map((c) => c.id),
    );

    const prev = prevDynamoIdsRef.current;

    // First mount: populate prev and exit without closing anything.
    if (prev.size === 0 && currentIds.size > 0) {
      prevDynamoIdsRef.current = currentIds;
      return;
    }

    // Detect deleted connections.
    for (const id of prev) {
      if (!currentIds.has(id)) {
        closeDataViewTabsForConnection(tabsRef.current, id);
      }
    }

    prevDynamoIdsRef.current = currentIds;
  }, [allConnections]);
}
