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

// ---------------------------------------------------------------------------
// Tab-switch (activate) guard — same pattern as close, consulted by TabStrip
// ---------------------------------------------------------------------------

/**
 * Handler signature for intercepting a tab-switch. The handler receives the
 * tab id that is about to be *deactivated* (i.e., the currently active tab
 * that may have unsaved state). Return `true` to allow the switch, `false` to
 * cancel it. The handler is responsible for surfacing any confirmation UI.
 */
type ActivateHandler = (leavingTabId: string) => boolean | Promise<boolean>;

const activateHandlers = new Map<string, ActivateHandler>();

export function registerActivateHandler(tabId: string, handler: ActivateHandler) {
  activateHandlers.set(tabId, handler);
}

export function unregisterActivateHandler(tabId: string) {
  activateHandlers.delete(tabId);
}

/**
 * Consult the activate handler for the tab that is about to be *left*.
 * Returns `true` (allow switch) when no handler is registered.
 */
export async function shouldActivateTab(leavingTabId: string): Promise<boolean> {
  const h = activateHandlers.get(leavingTabId);
  if (!h) return true;
  try {
    return await h(leavingTabId);
  } catch (e) {
    console.warn("[tabs] activate handler threw, allowing switch:", e);
    return true;
  }
}

/**
 * React hook: register an activate (switch-away) handler for the given tab id
 * for the lifetime of the component.
 */
export function useActivateConfirm(tabId: string, handler: ActivateHandler) {
  useEffect(() => {
    registerActivateHandler(tabId, handler);
    return () => unregisterActivateHandler(tabId);
  }, [tabId, handler]);
}
