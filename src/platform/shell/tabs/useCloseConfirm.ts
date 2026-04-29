import { useEffect } from "react";

/**
 * Lightweight close-interceptor registry. A tab kind that wants to gate
 * its own close (e.g. dirty buffer in the table viewer) registers a
 * `(tabId) => boolean | Promise<boolean>` handler keyed by `tabId`. The
 * `TabStrip`'s close button consults this registry before invoking
 * `tabs.close(tabId)`.
 *
 * Returning `true` (or resolving to `true`) means "go ahead and close".
 * Returning `false` cancels the close.
 *
 * The handler is unregistered automatically when the tab unmounts.
 */
type CloseHandler = (tabId: string) => boolean | Promise<boolean>;

const handlers = new Map<string, CloseHandler>();

export function registerCloseHandler(tabId: string, handler: CloseHandler) {
  handlers.set(tabId, handler);
}

export function unregisterCloseHandler(tabId: string) {
  handlers.delete(tabId);
}

export async function shouldCloseTab(tabId: string): Promise<boolean> {
  const h = handlers.get(tabId);
  if (!h) return true;
  try {
    return await h(tabId);
  } catch (e) {
    console.warn("[tabs] close handler threw, allowing close:", e);
    return true;
  }
}

/**
 * React hook: register a close handler for the given tab id for the
 * lifetime of the component.
 */
export function useCloseConfirm(tabId: string, handler: CloseHandler) {
  useEffect(() => {
    registerCloseHandler(tabId, handler);
    return () => unregisterCloseHandler(tabId);
  }, [tabId, handler]);
}
