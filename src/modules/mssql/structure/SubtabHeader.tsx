import { Filter, RotateCw } from "lucide-react";
import styles from "./SubtabHeader.module.css";

export type Subtab = "data" | "structure" | "raw" | "docs";

interface Props {
  active: Subtab;
  onChange(next: Subtab): void;
  /** When true, shows the Filter toggle button (Data subtab only). */
  filterBarVisible?: boolean;
  onFilterToggle?: () => void;
  /**
   * When provided, only the listed subtab ids are rendered.
   * Defaults to all four tabs when omitted.
   */
  visibleTabs?: Subtab[];
  /** Callback to trigger a reload of the current table query (Data subtab only). */
  onReload?: () => void;
  /** When true, the Reload button is disabled (first-page fetch in flight). */
  reloadDisabled?: boolean;
  /** When true, the Reload icon animates with a spin (in-flight fetch). */
  reloading?: boolean;
}

const TABS: { id: Subtab; label: string; shortcut: string }[] = [
  { id: "data", label: "Data", shortcut: "1" },
  { id: "structure", label: "Structure", shortcut: "2" },
  { id: "raw", label: "Raw", shortcut: "3" },
  { id: "docs", label: "Docs", shortcut: "4" },
];

export function SubtabHeader({ active, onChange, filterBarVisible, onFilterToggle, visibleTabs, onReload, reloadDisabled, reloading }: Props) {
  const displayTabs = visibleTabs
    ? TABS.filter((t) => visibleTabs.includes(t.id))
    : TABS;

  return (
    <div className={styles.bar} role="tablist" aria-label="Table viewer subtabs">
      {displayTabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          className={styles.tab}
          data-active={active === t.id}
          title={`${t.label} (⌘${t.shortcut})`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
      {/* Filter toggle button — only visible on the Data subtab */}
      {active === "data" && onFilterToggle !== undefined && (
        <button
          type="button"
          className={styles.filterToggle}
          data-active={filterBarVisible ? "true" : "false"}
          aria-label="Toggle filter bar"
          aria-pressed={filterBarVisible ?? false}
          title="Toggle filter bar (⌘F)"
          onClick={onFilterToggle}
        >
          <Filter size={13} strokeWidth={2} />
        </button>
      )}
      {/* Reload button — only visible on the Data subtab when onReload is provided */}
      {active === "data" && onReload !== undefined && (
        <button
          type="button"
          className={styles.filterToggle}
          disabled={reloadDisabled}
          aria-label="Reload"
          title="Reload (⌘R)"
          onClick={onReload}
        >
          <RotateCw
            size={13}
            strokeWidth={2}
            className={styles.reloadIcon}
            data-spinning={reloading ? "true" : "false"}
          />
        </button>
      )}
    </div>
  );
}
