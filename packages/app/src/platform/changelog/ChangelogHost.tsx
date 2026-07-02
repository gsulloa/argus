/**
 * ChangelogHost — mounts at the app shell level.
 *
 * Responsibilities:
 *  1. Registers the "Help: Show changelog" command palette entry.
 *  2. Persists `changelog.lastSeenVersion` via useSetting.
 *  3. Auto-opens the viewer after an update (gated on Tauri runtime + loaded setting).
 *  4. Renders <ChangelogViewer />.
 *
 * Gating logic (runs once per session, only in Tauri):
 *   - lastSeen === null  → seed silently to currentVersion, do NOT open.
 *   - semverCompare(lastSeen, currentVersion) < 0  → open with highlightSince=lastSeen,
 *     then write lastSeen=currentVersion.
 *   - otherwise → no-op.
 *
 * Manual open from the palette does NOT change the stored last-seen version.
 */

import { useEffect, useRef, useState } from "react";
import { CommandRegistry } from "@/platform/command-palette/CommandRegistry";
import { useUpdater } from "@/platform/updater";
import { useSetting } from "@/platform/settings/useSetting";
import { semverCompare } from "./parse";
import { ChangelogViewer } from "./ChangelogViewer";

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

export function ChangelogHost() {
  const [open, setOpen] = useState(false);
  const [highlightSince, setHighlightSince] = useState<string | null>(null);

  const { currentVersion } = useUpdater();

  const [lastSeen, setLastSeen, settingLoaded] = useSetting<string | null>(
    "changelog.lastSeenVersion",
    null,
  );

  // Ensure the gating effect runs at most once per session.
  const gatingRan = useRef(false);

  // Register command palette entry.
  useEffect(() => {
    const unregister = CommandRegistry.register({
      id: "argus.help.showChangelog",
      label: "Help: Show changelog",
      group: "Help",
      keywords: [
        "changelog",
        "release",
        "notes",
        "what's new",
        "whats new",
        "version",
        "updates",
      ],
      run: () => {
        // Manual open: show without changing lastSeen, no highlightSince.
        setHighlightSince(null);
        setOpen(true);
      },
    });
    return unregister;
  }, []);

  // Gating effect: auto-open after an update.
  useEffect(() => {
    // Prerequisites:
    //  1. Must be Tauri runtime (not web/dev).
    //  2. currentVersion must be resolved (non-empty).
    //  3. The setting must have loaded from disk.
    //  4. Must not have run yet this session.
    if (!isTauriRuntime()) return;
    if (!currentVersion) return;
    if (!settingLoaded) return;
    if (gatingRan.current) return;

    gatingRan.current = true;

    if (lastSeen === null) {
      // First rollout of this feature — seed silently, do not open.
      setLastSeen(currentVersion);
    } else if (semverCompare(lastSeen, currentVersion) < 0) {
      // User updated — show what changed since their last version.
      setHighlightSince(lastSeen);
      setLastSeen(currentVersion);
      setOpen(true);
    }
    // Otherwise: same version or somehow ahead — no-op.
  }, [currentVersion, settingLoaded, lastSeen, setLastSeen]);

  return (
    <ChangelogViewer
      open={open}
      onOpenChange={setOpen}
      currentVersion={currentVersion}
      highlightSince={highlightSince}
    />
  );
}
