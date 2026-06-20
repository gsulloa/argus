import { AppProviders } from "@/app/AppProviders";
import { ManagerShell } from "@/platform/shell/ManagerShell";

/**
 * Manager window root.
 *
 * Uses the full AppProviders pyramid (same as WorkspaceApp) for consistency
 * and safety — including unused providers is cheap and avoids divergent subsets.
 * The windows differ only in the shell they render.
 */
export function ManagerApp() {
  return (
    <AppProviders>
      <ManagerShell />
    </AppProviders>
  );
}
