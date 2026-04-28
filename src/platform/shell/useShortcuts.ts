import { useEffect } from "react";

export type ShortcutHandler = (e: KeyboardEvent) => void;

export interface ShortcutBinding {
  /** Key as `event.key` lowercase. Examples: "k", "w", "\\", "," */
  key: string;
  /** Require Cmd on macOS, Ctrl elsewhere. Defaults to true. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  handler: ShortcutHandler;
  /** When true, fires even when focus is in an input/textarea. */
  whenInInput?: boolean;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function eventMatches(e: KeyboardEvent, b: ShortcutBinding): boolean {
  if (e.key.toLowerCase() !== b.key.toLowerCase()) return false;
  const mod = b.mod ?? true;
  const wantMod = mod ? (isMac ? e.metaKey : e.ctrlKey) : true;
  const wantNonMod = mod ? (isMac ? !e.ctrlKey : !e.metaKey) : true;
  if (mod && (!wantMod || !wantNonMod)) return false;
  if ((b.shift ?? false) !== e.shiftKey) return false;
  if ((b.alt ?? false) !== e.altKey) return false;
  return true;
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.isContentEditable) return true;
  return false;
}

export function useShortcuts(bindings: ShortcutBinding[]) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      for (const b of bindings) {
        if (!eventMatches(e, b)) continue;
        if (!b.whenInInput && isTypingTarget(e.target)) continue;
        e.preventDefault();
        b.handler(e);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bindings]);
}
