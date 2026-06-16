import { useEffect, useState } from "react";
import { CommandRegistry } from "@/platform/command-palette/CommandRegistry";
import { SettingsPanel } from "./components/SettingsPanel";

/**
 * Mounts at the app shell level (inside AiSettingsProvider).
 * Registers the "AI: Configure providers" and "AI: Focus chat panel" command
 * palette entries and hosts the SettingsPanel modal so the Radix Dialog focus
 * trap works correctly.
 */
export function AiSettingsHost() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const unregisterConfigure = CommandRegistry.register({
      id: "ai.configureProviders",
      label: "AI: Configure providers",
      group: "AI",
      keywords: ["ai", "provider", "claude", "openai", "anthropic", "codex"],
      run: () => setOpen(true),
    });
    const unregisterFocus = CommandRegistry.register({
      id: "ai.focusChatPanel",
      label: "AI: Focus chat panel",
      group: "AI",
      keywords: ["chat", "ai", "sql"],
      run: () => {
        window.dispatchEvent(new CustomEvent("argus:ai:openPanel"));
      },
    });
    return () => {
      unregisterConfigure();
      unregisterFocus();
    };
  }, []);

  return <SettingsPanel open={open} onOpenChange={setOpen} />;
}
