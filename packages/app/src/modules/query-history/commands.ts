import { useEffect } from "react";
import { CommandRegistry } from "@/platform/command-palette";
import { useTabs } from "@/platform/shell/tabs";
import { openHistoryTab } from "./openHistoryTab";

/**
 * Register the History palette command. Mount once at the app root.
 */
export function useQueryHistoryCommands() {
  const tabs = useTabs();

  useEffect(() => {
    return CommandRegistry.register({
      id: "argus.history.open",
      label: "History: Open",
      group: "History",
      keywords: ["recent", "queries", "log", "history"],
      run: () => {
        openHistoryTab(tabs);
      },
    });
  }, [tabs]);
}
