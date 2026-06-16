import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ColumnRef, DataColumn } from "../types";
import styles from "./FilterBar.module.css";
import { noAutoCorrectProps } from "../../../shared/text-input-hygiene";

interface Props {
  value: ColumnRef;
  columns: DataColumn[];
  onChange(next: ColumnRef): void;
}

export function ColumnPicker({ value, columns, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const label =
    value.kind === "any_column" ? "Any column" : value.name || "(choose column)";

  const filteredColumns = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return columns;
    return columns.filter((c) => c.name.toLowerCase().includes(q));
  }, [columns, query]);

  function pick(next: ColumnRef) {
    onChange(next);
    setOpen(false);
    setQuery("");
  }

  return (
    <span className={styles.columnPicker}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.columnTrigger}
        data-any={value.kind === "any_column" ? "true" : "false"}
        aria-haspopup="listbox"
        aria-expanded={open ? "true" : "false"}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label}
        </span>
        <ChevronDown size={11} />
      </button>
      {open && (
        <div ref={popoverRef} className={styles.columnPopover} role="listbox">
          <input
            {...noAutoCorrectProps}
            className={styles.columnSearch}
            placeholder="Search columns…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <button
            type="button"
            className={styles.columnOption}
            data-active={value.kind === "any_column" ? "true" : "false"}
            onClick={() => pick({ kind: "any_column" })}
          >
            <span>Any column</span>
            <span className={styles.columnOptionType}>all text-castable</span>
          </button>
          {filteredColumns.map((c) => {
            const active = value.kind === "named" && value.name === c.name;
            return (
              <button
                key={c.name}
                type="button"
                className={styles.columnOption}
                data-active={active ? "true" : "false"}
                onClick={() => pick({ kind: "named", name: c.name })}
              >
                <span>{c.name}</span>
                <span className={styles.columnOptionType}>{c.data_type}</span>
              </button>
            );
          })}
          {filteredColumns.length === 0 && (
            <span className={styles.columnOption} style={{ color: "var(--text-subtle)" }}>
              No matches
            </span>
          )}
        </div>
      )}
    </span>
  );
}
