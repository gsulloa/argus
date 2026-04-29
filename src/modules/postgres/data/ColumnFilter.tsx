import { useEffect, useMemo, useRef, useState } from "react";
import { Filter as FilterIcon } from "lucide-react";
import type { DataColumn, Filter, FilterValue } from "./types";
import { categorize, operatorsFor } from "./typeHelpers";
import styles from "./ColumnFilter.module.css";

interface Props {
  column: DataColumn;
  current: Filter | null;
  onChange(next: Filter | null): void;
}

type DraftOp = Filter["op"];

interface Draft {
  op: DraftOp;
  value: string;
  min: string;
  max: string;
}

function draftFromFilter(f: Filter | null, defaultOp: DraftOp): Draft {
  if (!f) {
    return { op: defaultOp, value: "", min: "", max: "" };
  }
  switch (f.op) {
    case "BETWEEN":
      return {
        op: f.op,
        value: "",
        min: String(f.min),
        max: String(f.max),
      };
    case "IS NULL":
    case "IS NOT NULL":
      return { op: f.op, value: "", min: "", max: "" };
    default:
      return { op: f.op, value: String(f.value), min: "", max: "" };
  }
}

function coerceValue(raw: string, dataType: string): FilterValue | { error: string } {
  const trimmed = raw.trim();
  const lower = dataType.toLowerCase();
  if (lower === "boolean") {
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    return { error: "expected 'true' or 'false'" };
  }
  const cat = categorize(dataType);
  if (cat === "numeric") {
    if (trimmed === "") return { error: "value required" };
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return { error: "not a number" };
    return n;
  }
  return raw;
}

function buildFilter(
  column: string,
  draft: Draft,
  dataType: string,
): Filter | { error: string } {
  switch (draft.op) {
    case "IS NULL":
    case "IS NOT NULL":
      return { op: draft.op, column };
    case "BETWEEN": {
      const min = coerceValue(draft.min, dataType);
      if (typeof min === "object") return { error: `min: ${min.error}` };
      const max = coerceValue(draft.max, dataType);
      if (typeof max === "object") return { error: `max: ${max.error}` };
      return { op: "BETWEEN", column, min, max };
    }
    default: {
      const v = coerceValue(draft.value, dataType);
      if (typeof v === "object") return { error: v.error };
      return { op: draft.op, column, value: v };
    }
  }
}

export function ColumnFilter({ column, current, onChange }: Props) {
  const category = useMemo(() => categorize(column.data_type), [column.data_type]);
  const ops = useMemo(
    () => operatorsFor(category, column.is_nullable),
    [category, column.is_nullable],
  );
  const defaultOp = ops[0] ?? "=";

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftFromFilter(current, defaultOp));
  const [error, setError] = useState<string | null>(null);

  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Sync draft when popover opens (to reflect external state).
  useEffect(() => {
    if (open) {
      setDraft(draftFromFilter(current, defaultOp));
      setError(null);
    }
  }, [open, current, defaultOp]);

  // Outside click / Escape closes the popover.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const tgt = e.target as Node;
      if (popoverRef.current?.contains(tgt) || triggerRef.current?.contains(tgt)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isActive = current !== null;
  const needsValue = draft.op !== "IS NULL" && draft.op !== "IS NOT NULL";
  const isRange = draft.op === "BETWEEN";

  function apply() {
    const built = buildFilter(column.name, draft, column.data_type);
    if ("error" in built) {
      setError(built.error);
      return;
    }
    setError(null);
    onChange(built);
    setOpen(false);
  }

  function clear() {
    setError(null);
    onChange(null);
    setOpen(false);
  }

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        ref={triggerRef}
        className={styles.trigger}
        data-active={isActive ? "true" : "false"}
        aria-label={`Filter ${column.name}`}
        title={isActive ? `Filter on ${column.name}` : `Filter ${column.name}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <FilterIcon size={11} />
      </button>
      {open && (
        <div
          ref={popoverRef}
          className={styles.popover}
          role="dialog"
          aria-label={`Filter ${column.name}`}
          style={{ top: "calc(100% + 4px)", left: 0 }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className={styles.row}>
            <label className={styles.label} htmlFor={`op-${column.name}`}>
              Operator
            </label>
            <select
              id={`op-${column.name}`}
              className={styles.select}
              value={draft.op}
              onChange={(e) =>
                setDraft((d) => ({ ...d, op: e.target.value as DraftOp }))
              }
            >
              {ops.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
          </div>
          {needsValue && !isRange && (
            <div className={styles.row}>
              <label className={styles.label} htmlFor={`val-${column.name}`}>
                Value
              </label>
              <input
                id={`val-${column.name}`}
                className={styles.input}
                value={draft.value}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, value: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") apply();
                }}
                autoFocus
              />
            </div>
          )}
          {isRange && (
            <div className={styles.range}>
              <div className={styles.row}>
                <label className={styles.label} htmlFor={`min-${column.name}`}>
                  Min
                </label>
                <input
                  id={`min-${column.name}`}
                  className={styles.input}
                  value={draft.min}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, min: e.target.value }))
                  }
                  autoFocus
                />
              </div>
              <div className={styles.row}>
                <label className={styles.label} htmlFor={`max-${column.name}`}>
                  Max
                </label>
                <input
                  id={`max-${column.name}`}
                  className={styles.input}
                  value={draft.max}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, max: e.target.value }))
                  }
                />
              </div>
            </div>
          )}
          {error && <div className={styles.error}>{error}</div>}
          <div className={styles.actions}>
            <button type="button" className={styles.btn} onClick={clear}>
              {isActive ? "Clear" : "Cancel"}
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={apply}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
