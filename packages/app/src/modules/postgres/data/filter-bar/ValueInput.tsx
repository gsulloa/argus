import { useState } from "react";
import { categorize } from "../typeHelpers";
import type {
  ColumnRef,
  DataColumn,
  FilterScalar,
  FilterValue,
  Operator,
} from "../types";
import styles from "./FilterBar.module.css";
import { noAutoCorrectProps } from "../../../shared/text-input-hygiene";

interface Props {
  column: ColumnRef;
  columns: DataColumn[];
  op: Operator;
  value: FilterValue | undefined;
  onChange(next: FilterValue | undefined): void;
}

function namedColumn(column: ColumnRef, columns: DataColumn[]): DataColumn | null {
  if (column.kind !== "named") return null;
  return columns.find((c) => c.name === column.name) ?? null;
}

function inputTypeForCategory(cat: string): "text" | "number" | "date" | "datetime-local" {
  if (cat === "numeric") return "number";
  if (cat === "date") return "date";
  return "text";
}

function parseScalar(raw: string, cat: string): FilterScalar {
  if (cat === "numeric") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  return raw;
}

function asScalarStringForDisplay(v: FilterValue | undefined): string {
  if (v === undefined) return "";
  if (Array.isArray(v) || (typeof v === "object" && v !== null)) return "";
  return String(v);
}

export function ValueInput({ column, columns, op, value, onChange }: Props) {
  if (op === "IS NULL" || op === "IS NOT NULL") {
    return null;
  }

  const named = namedColumn(column, columns);
  const cat = categorize(named?.data_type ?? "text");

  if (op === "BETWEEN") {
    const obj =
      value && typeof value === "object" && !Array.isArray(value)
        ? value
        : { min: "" as FilterScalar, max: "" as FilterScalar };
    const inputType = inputTypeForCategory(cat);
    return (
      <span className={styles.between}>
        <input
          {...noAutoCorrectProps}
          type={inputType}
          className={`${styles.valueInput} ${styles.betweenInput}`}
          value={String(obj.min ?? "")}
          aria-label="Minimum"
          onChange={(e) =>
            onChange({ ...obj, min: parseScalar(e.target.value, cat) })
          }
        />
        <span className={styles.betweenSep}>and</span>
        <input
          {...noAutoCorrectProps}
          type={inputType}
          className={`${styles.valueInput} ${styles.betweenInput}`}
          value={String(obj.max ?? "")}
          aria-label="Maximum"
          onChange={(e) =>
            onChange({ ...obj, max: parseScalar(e.target.value, cat) })
          }
        />
      </span>
    );
  }

  if (op === "In" || op === "NotIn") {
    const arr = Array.isArray(value) ? value : [];
    return (
      <ChipInput
        values={arr}
        category={cat}
        onChange={(next) => onChange(next.length ? next : [])}
      />
    );
  }

  if (cat === "boolean") {
    const cur =
      typeof value === "boolean"
        ? String(value)
        : asScalarStringForDisplay(value);
    return (
      <select
        className={styles.opSelect}
        value={cur}
        onChange={(e) => onChange(e.target.value === "true")}
        aria-label="Value"
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  const inputType = inputTypeForCategory(cat);
  return (
    <input
      {...noAutoCorrectProps}
      type={inputType}
      className={styles.valueInput}
      value={asScalarStringForDisplay(value)}
      aria-label="Value"
      placeholder={
        op === "Contains" || op === "StartsWith" || op === "EndsWith"
          ? "search…"
          : "value"
      }
      onChange={(e) => onChange(parseScalar(e.target.value, cat))}
    />
  );
}

interface ChipInputProps {
  values: FilterScalar[];
  category: string;
  onChange(next: FilterScalar[]): void;
}

function ChipInput({ values, category, onChange }: ChipInputProps) {
  const [draft, setDraft] = useState("");

  function commit() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onChange([...values, parseScalar(trimmed, category)]);
    setDraft("");
  }

  return (
    <span className={styles.chips}>
      {values.map((v, i) => (
        <span key={`${i}-${String(v)}`} className={styles.chip}>
          <span>{String(v)}</span>
          <button
            type="button"
            className={styles.chipRemove}
            aria-label={`Remove ${String(v)}`}
            onClick={() => onChange(values.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        {...noAutoCorrectProps}
        className={styles.chipInput}
        data-chip-input="true"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            e.stopPropagation();
            commit();
          } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
            e.preventDefault();
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder={values.length === 0 ? "type then Enter…" : ""}
      />
    </span>
  );
}
