import { useEffect, useState } from "react";
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
  /**
   * `null` only for a row rehydrated from a v0.8.6 record whose operator was
   * cleared by that release's `Operator: Unset` — see `FilterRow` in `../types`.
   * The control is then picked from the retained value's shape so the value
   * stays visible and editable.
   */
  op: Operator | null;
  value: FilterValue | undefined;
  onChange(next: FilterValue | undefined): void;
}

function namedColumn(column: ColumnRef, columns: DataColumn[]): DataColumn | null {
  if (column.kind !== "named") return null;
  return columns.find((c) => c.name === column.name) ?? null;
}

function inputTypeForCategory(cat: string): "text" | "date" | "datetime-local" {
  if (cat === "date") return "date";
  return "text";
}

/**
 * Returns the appropriate `inputMode` for numeric columns so mobile/assistive
 * tech shows a numeric keypad while still using `type="text"` (which never
 * blanks on non-numeric characters).
 *
 * Returns `undefined` for non-numeric categories so the attribute is omitted.
 */
function inputModeForCategory(
  cat: string,
  dataType: string | undefined,
): React.HTMLAttributes<HTMLInputElement>["inputMode"] | undefined {
  if (cat !== "numeric") return undefined;
  const t = (dataType ?? "").toLowerCase();
  // Fractional types get "decimal"; everything else (int family) gets "numeric".
  if (
    t === "real" ||
    t === "float4" ||
    t === "float8" ||
    t === "double precision" ||
    t.startsWith("numeric") ||
    t.startsWith("decimal")
  ) {
    return "decimal";
  }
  return "numeric";
}

/**
 * Splits a raw string into individual value fragments.
 *
 * For all categories: split on commas and newlines.
 * For numeric category only: also split on runs of whitespace (so pasting a
 * space-separated list of IDs yields one chip per ID). Whitespace-splitting is
 * intentionally NOT applied to text columns because multi-word text values
 * (e.g. "New York") should not be split.
 */
export function splitValues(raw: string, category: string): string[] {
  const delimiter = category === "numeric" ? /[,\n\s]+/ : /[,\n]+/;
  return raw
    .split(delimiter)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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

  // With no operator selected there is no operator to derive the control from,
  // so derive it from the SHAPE of the retained value instead. The point of
  // unsetting is that the user's value stays visible and editable — never
  // render nothing here.
  const isUnset = op === null;

  if (isUnset ? Array.isArray(value) : op === "In" || op === "NotIn") {
    const arr = Array.isArray(value) ? value : [];
    return (
      <ChipInput
        values={arr}
        category={cat}
        onChange={(next) => onChange(next.length ? next : [])}
      />
    );
  }

  if (
    op === "BETWEEN" ||
    (isUnset && !!value && typeof value === "object" && !Array.isArray(value))
  ) {
    const obj =
      value && typeof value === "object" && !Array.isArray(value)
        ? value
        : { min: "" as FilterScalar, max: "" as FilterScalar };
    const inputType = inputTypeForCategory(cat);
    const inputMode = inputModeForCategory(cat, named?.data_type);
    return (
      <span className={styles.between}>
        <input
          {...noAutoCorrectProps}
          type={inputType}
          inputMode={inputMode}
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
          inputMode={inputMode}
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

  if (cat === "boolean") {
    // While unset, suppress the eager `true` commit — the row is incomplete by
    // definition, and writing a value the user never chose would be a surprise.
    // Picking an operator re-enables it and the row self-heals.
    return (
      <BooleanValueInput
        value={value}
        onChange={onChange}
        commitDefault={!isUnset}
      />
    );
  }

  const inputType = inputTypeForCategory(cat);
  const inputMode = inputModeForCategory(cat, named?.data_type);
  return (
    <input
      {...noAutoCorrectProps}
      type={inputType}
      inputMode={inputMode}
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

/**
 * Boolean value control. The underlying `<select>` only has `true` / `false`
 * options, so a model value of `""` (the generic empty-row placeholder) would
 * paint "true" visually WITHOUT committing it — selecting the already-shown
 * option fires no `change` event, and the row stays incomplete and is silently
 * dropped from the query. To avoid that, whenever the model value is not already
 * a boolean we eagerly commit `true` (matching the displayed option) so the row
 * carries a concrete value. This only mutates the draft; it never triggers a
 * fetch (fetch is gated on Apply).
 */
function BooleanValueInput({
  value,
  onChange,
  commitDefault = true,
}: {
  value: FilterValue | undefined;
  onChange(next: FilterValue | undefined): void;
  /** `false` while the row's operator is unset — see `ValueInput`. */
  commitDefault?: boolean;
}) {
  const isBool = typeof value === "boolean";
  useEffect(() => {
    if (!isBool && commitDefault) onChange(true);
  }, [isBool, commitDefault, onChange]);
  // Display the committed boolean; before the effect commits, show "true"
  // (the value we are about to commit) so the control never appears blank.
  const cur = isBool ? String(value) : "true";
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

export function RawExpressionInput({
  value,
  onChange,
}: {
  value: string;
  onChange(next: string): void;
}) {
  return (
    <input
      {...noAutoCorrectProps}
      type="text"
      className={`${styles.valueInput} ${styles.rawInput}`}
      value={value}
      aria-label="Raw SQL expression"
      placeholder="data->>'estado' = 'activo'"
      onChange={(e) => onChange(e.target.value)}
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

  function commitRaw(raw: string) {
    const fragments = splitValues(raw, category);
    if (fragments.length === 0) return;
    const newChips = fragments.map((f) => parseScalar(f, category));
    onChange([...values, ...newChips]);
    setDraft("");
  }

  function commit() {
    commitRaw(draft);
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
        onPaste={(e) => {
          const pasted = e.clipboardData.getData("text");
          const combined = draft + pasted;
          // Only split-and-commit when the combined text contains a delimiter;
          // otherwise fall through to the default paste so the user can keep typing.
          const hasDelimiter = /[,\n]/.test(combined) || (category === "numeric" && /\s/.test(combined.trim()));
          if (hasDelimiter) {
            e.preventDefault();
            commitRaw(combined);
          }
          // No delimiter → let default paste append to draft naturally.
        }}
        onBlur={commit}
        placeholder={values.length === 0 ? "type then Enter…" : ""}
      />
    </span>
  );
}
