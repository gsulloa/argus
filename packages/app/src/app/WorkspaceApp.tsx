/**
 * WorkspaceApp — root component for the `workspace` window (Phase 4).
 *
 * Provider pyramid: full AppProviders (same as ManagerApp per the Phase 3
 * deviation — AppProviders is shared; split is at shell level).
 *
 * FocusedConnectionProvider is now in AppProviders (above TabsProvider) so
 * TabsContext can consume focusedConnectionId for connection-scoped tabs
 * (Phase 5, task 5.1). The redundant wrapper here has been removed.
 */
import { AppProviders } from "./AppProviders";
import { WorkspaceShell } from "@/platform/shell/WorkspaceShell";

export function WorkspaceApp() {
  return (
    <AppProviders>
      <WorkspaceShell />
    </AppProviders>
  );
}
