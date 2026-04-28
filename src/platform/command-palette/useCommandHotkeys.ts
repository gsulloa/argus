import { useEffect, useState } from "react";
import { CommandRegistry, type Command } from "./CommandRegistry";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function matches(e: KeyboardEvent, h: Command["hotkey"]): boolean {
  if (!h) return false;
  if (e.key.toLowerCase() !== h.key.toLowerCase()) return false;
  const wantMod = h.mod ?? true;
  if (wantMod) {
    if (isMac && (!e.metaKey || e.ctrlKey)) return false;
    if (!isMac && (!e.ctrlKey || e.metaKey)) return false;
  }
  if ((h.shift ?? false) !== e.shiftKey) return false;
  if ((h.alt ?? false) !== e.altKey) return false;
  return true;
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return t.isContentEditable;
}

/**
 * Activates registered commands by their hotkey, without opening the palette.
 * Listens to the window keydown event, so works regardless of focus context
 * (except inside text inputs, where typing is preserved).
 */
export function useCommandHotkeys() {
  const [, setVersion] = useState(0);
  useEffect(() => CommandRegistry.subscribe(() => setVersion((v) => v + 1)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      for (const cmd of CommandRegistry.list()) {
        if (cmd.hotkey && matches(e, cmd.hotkey)) {
          e.preventDefault();
          void cmd.run();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
