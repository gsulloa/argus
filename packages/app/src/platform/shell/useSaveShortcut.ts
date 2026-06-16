import { useEffect, type RefObject } from "react";

export interface SaveShortcutOptions {
  /** Only listen while this tab is active so background tabs don't double-fire. */
  active: boolean;
  /** Root element of the tab; ⌘S fires when focus is inside it (or nowhere). */
  rootRef: RefObject<HTMLElement | null>;
  /** Save callback. The caller is responsible for no-op-when-clean. */
  onSave: () => void;
}

/**
 * Window-level ⌘S / Ctrl+S handler shared by the SQL data viewers.
 *
 * Issue #88: the shortcut must save regardless of where focus sits inside the
 * tab — including when nothing is focused — so users don't silently lose edits
 * after clicking away from the grid. It fires when the tab is active AND focus
 * is null / on `document.body` / within `rootRef`, EXCEPT when focus is inside a
 * CodeMirror editor (`.cm-editor`), which owns its own ⌘S.
 */
export function useSaveShortcut({ active, rootRef, onSave }: SaveShortcutOptions) {
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (
        !(
          (e.metaKey || e.ctrlKey) &&
          e.key.toLowerCase() === "s" &&
          !e.shiftKey &&
          !e.altKey
        )
      ) {
        return;
      }
      const focused = document.activeElement as HTMLElement | null;
      // Leave ⌘S to a focused CodeMirror surface (it may bind its own save).
      if (focused?.closest(".cm-editor")) return;
      // Save when focus is absent (body/null) or anywhere inside this tab.
      const root = rootRef.current;
      const focusInTab =
        focused === null ||
        focused === document.body ||
        (root !== null && root.contains(focused));
      if (!focusInTab) return;
      e.preventDefault();
      onSave();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, rootRef, onSave]);
}
