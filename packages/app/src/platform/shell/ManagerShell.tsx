import { useRef, useState } from "react";
import { Search } from "lucide-react";
import { Palette } from "@/platform/command-palette";
import { usePalette, useCommandHotkeys } from "@/platform/command-palette";
import { useShortcuts } from "@/platform/shell/useShortcuts";
import { VersionIndicator } from "@/platform/shell/VersionIndicator";
import { FeedbackHost, FeedbackAffordance } from "@/platform/feedback";
import { ConnectionsSection } from "@/platform/shell/Sidebar";
import { SidebarScrollContext } from "@/platform/shell/sidebarScroll";
import { APP_DISPLAY_NAME } from "@/platform/app-identity";
import * as Dialog from "@radix-ui/react-dialog";
import logoUrl from "@/assets/logo.svg";
import { noAutoCorrectProps } from "@/modules/shared/text-input-hygiene";
import dialogStyles from "./Dialog.module.css";
import styles from "./ManagerShell.module.css";

/**
 * ManagerShell — the UI for the `manager` window.
 *
 * Layout (Decision 10 — picker, not transplanted sidebar):
 *   - Brand header: logo + app name, picker-prominent sizing
 *   - Search bar: inline filter by name / host
 *   - Scrollable connections list (ConnectionsSection in manager mode)
 *   - Footer with VersionIndicator
 *
 * Shortcuts (per spec):
 *   - ⌘K / ⌘⇧P → command palette
 *   - ⌘,         → Manager Settings (placeholder modal)
 *   - ⌘P / ⌥⌘P / ⌘W → inert (no tabs, no table index in Manager)
 */
export function ManagerShell() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [filterQuery, setFilterQuery] = useState("");

  return (
    <SidebarScrollContext.Provider value={scrollRef}>
      <div className={styles.root}>
        {/* ── Picker header ────────────────────────────────── */}
        <header className={styles.header}>
          <img src={logoUrl} alt="" className={styles.headerMark} />
          <span className={styles.headerName}>{APP_DISPLAY_NAME}</span>
        </header>

        {/* ── Inline search ───────────────────────────────── */}
        <div className={styles.searchBar}>
          <span className={styles.searchIcon} aria-hidden="true">
            <Search size={13} strokeWidth={1.6} />
          </span>
          <input
            type="search"
            {...noAutoCorrectProps}
            placeholder="Filter connections…"
            className={styles.searchInput}
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setFilterQuery("");
            }}
            aria-label="Filter connections"
          />
          {filterQuery && (
            <button
              type="button"
              className={styles.searchClear}
              aria-label="Clear filter"
              onClick={() => setFilterQuery("")}
            >
              ×
            </button>
          )}
        </div>

        {/* ── Scrollable connection list ───────────────────── */}
        <div ref={scrollRef} className={styles.scroll}>
          <ConnectionsSection mode="manager" filterQuery={filterQuery} />
        </div>

        {/* ── Footer ──────────────────────────────────────── */}
        <footer className={styles.footer}>
          <FeedbackAffordance />
          <VersionIndicator />
        </footer>
      </div>

      {/* Shortcuts and palette mounted outside the scroll to avoid layout issues. */}
      <ManagerShortcuts />
      <Palette />
      {/* Feedback form host: registers the "Send feedback" palette command,
          listens for the affordance event, and renders the dialog. */}
      <FeedbackHost />
    </SidebarScrollContext.Provider>
  );
}

function ManagerShortcuts() {
  const palette = usePalette();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Register command-palette hotkeys (⌘K synonyms registered via the command registry).
  useCommandHotkeys();

  useShortcuts([
    // ⌘K → command palette
    { key: "k", whenInInput: true, handler: () => palette.show() },
    // ⌘⇧P → command palette (synonym)
    { key: "p", shift: true, whenInInput: true, handler: () => palette.show() },
    // ⌘, → Manager settings placeholder
    { key: ",", whenInInput: true, handler: () => setSettingsOpen(true) },
    // ⌘P, ⌥⌘P, ⌘W → explicitly inert in the Manager (no tabs, no table index).
    // Registering them with a no-op handler + preventDefault ensures they don't
    // bubble to any underlying element (e.g. a focused input).
    { key: "p", whenInInput: true, handler: () => undefined },
    { key: "p", alt: true, whenInInput: true, handler: () => undefined },
    { key: "w", whenInInput: true, handler: () => undefined },
  ]);

  return (
    <Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.overlay} />
        <Dialog.Content className={dialogStyles.content}>
          <Dialog.Title className={dialogStyles.title}>Settings</Dialog.Title>
          <Dialog.Description className={dialogStyles.description}>
            Application settings will appear here in a future release.
          </Dialog.Description>
          <div className={dialogStyles.footer}>
            <button
              className={dialogStyles.primary}
              onClick={() => setSettingsOpen(false)}
            >
              Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
