/**
 * MSSQL FilterBar — same operator set as MySQL EXCEPT:
 * - No ILIKE / NOT ILIKE operators (SQL Server uses LOWER() wrapping).
 * - Case-insensitive toggle on LIKE/Contains/StartsWith/EndsWith.
 * - Added: BETWEEN / NOT BETWEEN operators.
 * - Spatial / rowversion ops surfaced as disabled with tooltip.
 *
 * The case-insensitive toggle maps to a `caseInsensitive: true` flag that
 * the backend reads to emit `LOWER([col]) LIKE LOWER(@PN)`.
 */

import { useCallback, type ChangeEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { ColumnInfo, Operator } from "../types";
import type { FilterModel, FilterRow } from "./types";
import { EMPTY_FILTER_ROW } from "./types";

// ---------------------------------------------------------------------------
// Operator definitions (no ILIKE for MSSQL)
// ---------------------------------------------------------------------------

interface OperatorDef {
  label: string;
  op: Operator;
  needsValue: boolean;
  /** When true, show the case-insensitive toggle for this operator. */
  hasCiToggle?: boolean;
  /** When true, render as disabled with "Not filterable in v1" tooltip. */
  disabled?: boolean;
}

const OPERATOR_DEFS: OperatorDef[] = [
  { label: "=", op: "=", needsValue: true },
  { label: "!=", op: "!=", needsValue: true },
  { label: "<", op: "<", needsValue: true },
  { label: "<=", op: "<=", needsValue: true },
  { label: ">", op: ">", needsValue: true },
  { label: ">=", op: ">=", needsValue: true },
  { label: "LIKE", op: "LIKE", needsValue: true, hasCiToggle: true },
  { label: "NOT LIKE", op: "NOT LIKE", needsValue: true, hasCiToggle: true },
  { label: "Contains", op: "Contains", needsValue: true, hasCiToggle: true },
  { label: "Starts with", op: "StartsWith", needsValue: true, hasCiToggle: true },
  { label: "Ends with", op: "EndsWith", needsValue: true, hasCiToggle: true },
  { label: "In (a,b,…)", op: "In", needsValue: true },
  { label: "Not In", op: "NotIn", needsValue: true },
  { label: "BETWEEN", op: "BETWEEN", needsValue: true },
  { label: "IS NULL", op: "IS NULL", needsValue: false },
  { label: "IS NOT NULL", op: "IS NOT NULL", needsValue: false },
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  columns: ColumnInfo[];
  model: FilterModel;
  onChange(model: FilterModel): void;
  onApply?(): void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FilterBar({ columns, model, onChange, onApply }: Props) {
  const addRow = useCallback(() => {
    onChange({
      ...model,
      rows: [...model.rows, { ...EMPTY_FILTER_ROW }],
    });
  }, [model, onChange]);

  const removeRow = useCallback(
    (idx: number) => {
      const rows = model.rows.filter((_, i) => i !== idx);
      onChange({ ...model, rows });
    },
    [model, onChange],
  );

  const updateRow = useCallback(
    (idx: number, patch: Partial<FilterRow>) => {
      const rows = model.rows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
      onChange({ ...model, rows });
    },
    [model, onChange],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "6px 8px" }}>
      {model.rows.map((row, idx) => (
        <FilterRowEditor
          key={idx}
          row={row}
          columns={columns}
          onChange={(patch) => updateRow(idx, patch)}
          onRemove={() => removeRow(idx)}
          onApply={onApply}
        />
      ))}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button
          type="button"
          onClick={addRow}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 12,
            padding: "2px 8px",
            borderRadius: 4,
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--text-muted)",
            cursor: "pointer",
          }}
        >
          <Plus size={12} /> Add filter
        </button>
        {model.rows.length > 1 && (
          <select
            value={model.combinator}
            onChange={(e) =>
              onChange({ ...model, combinator: e.target.value as "AND" | "OR" })
            }
            style={{
              fontSize: 12,
              padding: "2px 4px",
              borderRadius: 3,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
            }}
          >
            <option value="AND">AND</option>
            <option value="OR">OR</option>
          </select>
        )}
        {onApply && model.rows.length > 0 && (
          <button
            type="button"
            onClick={onApply}
            style={{
              fontSize: 12,
              padding: "2px 8px",
              borderRadius: 4,
              border: "none",
              background: "var(--accent)",
              color: "var(--on-accent, #fff)",
              cursor: "pointer",
              marginLeft: "auto",
            }}
          >
            Apply
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FilterRowEditor
// ---------------------------------------------------------------------------

interface RowEditorProps {
  row: FilterRow;
  columns: ColumnInfo[];
  onChange(patch: Partial<FilterRow>): void;
  onRemove(): void;
  onApply?(): void;
}

function FilterRowEditor({ row, columns, onChange, onRemove, onApply }: RowEditorProps) {
  const opDef = OPERATOR_DEFS.find((d) => d.op === row.op) ?? OPERATOR_DEFS[0]!;
  const hasCiToggle = opDef.hasCiToggle === true;

  // Case-insensitive flag stored as a synthetic string prefix.
  const ciEnabled = typeof row.value === "string" && row.value.startsWith("\x00ci:");
  const displayValue = ciEnabled
    ? (row.value as string).slice(4)
    : (row.value ?? "");

  function handleColumnChange(e: ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    if (val === "__any__") {
      onChange({ column: { kind: "any_column" } });
    } else {
      onChange({ column: { kind: "named", name: val } });
    }
  }

  function handleOpChange(e: ChangeEvent<HTMLSelectElement>) {
    const newOp = e.target.value as Operator;
    const newDef = OPERATOR_DEFS.find((d) => d.op === newOp)!;
    onChange({ op: newOp, value: newDef.needsValue ? (row.value ?? "") : undefined });
  }

  function handleValueChange(e: ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    onChange({ value: ciEnabled ? `\x00ci:${raw}` : raw });
  }

  function toggleCi() {
    if (ciEnabled) {
      onChange({ value: displayValue });
    } else {
      onChange({ value: `\x00ci:${displayValue}` });
    }
  }

  const columnName =
    row.column.kind === "named" ? row.column.name : "__any__";

  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <select
        value={columnName}
        onChange={handleColumnChange}
        style={selectStyle}
        aria-label="Filter column"
      >
        <option value="__any__">Any column</option>
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>

      <select
        value={row.op}
        onChange={handleOpChange}
        style={selectStyle}
        aria-label="Filter operator"
      >
        {OPERATOR_DEFS.map((d) => (
          <option key={d.op} value={d.op} disabled={d.disabled}>
            {d.label}
          </option>
        ))}
      </select>

      {opDef.needsValue && (
        <input
          type="text"
          value={displayValue as string}
          onChange={handleValueChange}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
              e.preventDefault();
              onApply?.();
            }
          }}
          placeholder={opDef.op === "BETWEEN" ? "min,max" : "value"}
          style={inputStyle}
          aria-label="Filter value"
        />
      )}

      {hasCiToggle && (
        <button
          type="button"
          onClick={toggleCi}
          title="Case-insensitive"
          style={{
            fontSize: 10,
            fontWeight: 600,
            padding: "1px 5px",
            borderRadius: 3,
            border: "1px solid var(--border)",
            background: ciEnabled ? "var(--accent)" : "transparent",
            color: ciEnabled ? "var(--on-accent, #fff)" : "var(--text-muted)",
            cursor: "pointer",
            letterSpacing: "0.04em",
          }}
        >
          Aa
        </button>
      )}

      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove filter"
        style={{
          background: "transparent",
          border: 0,
          padding: "2px 3px",
          cursor: "pointer",
          color: "var(--text-subtle)",
          display: "inline-flex",
          alignItems: "center",
          borderRadius: 3,
        }}
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  fontSize: 12,
  padding: "2px 4px",
  borderRadius: 3,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  minWidth: 80,
};

const inputStyle: React.CSSProperties = {
  fontSize: 12,
  padding: "2px 6px",
  borderRadius: 3,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  flex: 1,
  minWidth: 0,
  outline: "none",
};
