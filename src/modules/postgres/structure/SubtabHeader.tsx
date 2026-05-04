import styles from "./SubtabHeader.module.css";

export type Subtab = "data" | "structure" | "raw";

interface Props {
  active: Subtab;
  onChange(next: Subtab): void;
}

const TABS: { id: Subtab; label: string; shortcut: string }[] = [
  { id: "data", label: "Data", shortcut: "1" },
  { id: "structure", label: "Structure", shortcut: "2" },
  { id: "raw", label: "Raw", shortcut: "3" },
];

export function SubtabHeader({ active, onChange }: Props) {
  return (
    <div className={styles.bar} role="tablist" aria-label="Table viewer subtabs">
      {TABS.map((t) => (
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
    </div>
  );
}
