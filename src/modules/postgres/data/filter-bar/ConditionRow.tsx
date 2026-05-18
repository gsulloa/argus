import { Minus, Plus } from "lucide-react";
import { ColumnPicker } from "./ColumnPicker";
import { OperatorPicker } from "./OperatorPicker";
import { ValueInput } from "./ValueInput";
import { operatorsForColumn } from "./operatorRules";
import { coerceValueForOperator } from "./treeMutations";
import { RowApplyButton } from "../../../shared/filter-bar";
import type { ColumnRef, DataColumn, FilterRow, Operator } from "../types";
import styles from "./FilterBar.module.css";

export interface ConditionRowProps {
  row: FilterRow;
  index: number;
  totalRows: number;
  /** True when the row's (column, op, value) triple exists in applied.rows. */
  isApplied: boolean;
  columns: DataColumn[];
  /** First row gets data-filter-focus-target='true'. */
  isFocusTarget?: boolean;
  onChange(next: FilterRow): void;
  onSetEnabled(next: boolean): void;
  onApplyOnly(): void;
  /** + button: insert a new empty row below this index. */
  onInsertBelow(): void;
  /** − button: remove this row (or clear if last). */
  onRemove(): void;
}

function namedColumnMeta(
  column: ColumnRef,
  columns: DataColumn[],
): { dataType: string | null; isNullable: boolean } {
  if (column.kind !== "named") return { dataType: null, isNullable: true };
  const c = columns.find((c) => c.name === column.name);
  return c
    ? { dataType: c.data_type, isNullable: c.is_nullable }
    : { dataType: null, isNullable: true };
}

export function ConditionRow({
  row,
  index,
  isApplied,
  columns,
  isFocusTarget,
  onChange,
  onSetEnabled,
  onApplyOnly,
  onInsertBelow,
  onRemove,
}: ConditionRowProps) {
  const meta = namedColumnMeta(row.column, columns);
  const ops = operatorsForColumn(row.column, meta.dataType, meta.isNullable);

  function onColumnChange(next: ColumnRef) {
    const nextOps = operatorsForColumn(
      next,
      next.kind === "named"
        ? columns.find((c) => c.name === next.name)?.data_type ?? null
        : null,
      next.kind === "named"
        ? columns.find((c) => c.name === next.name)?.is_nullable ?? true
        : true,
    );
    const nextOp: Operator = nextOps.includes(row.op) ? row.op : nextOps[0]!;
    const nextValue = coerceValueForOperator(row.value, nextOp);
    onChange({ ...row, column: next, op: nextOp, value: nextValue });
  }

  function onOpChange(next: Operator) {
    const nextValue = coerceValueForOperator(row.value, next);
    onChange({ ...row, op: next, value: nextValue });
  }

  return (
    <div
      className={[styles.conditionRow, !row.enabled ? styles.conditionRowDisabled : ""].filter(Boolean).join(" ")}
      data-filter-row-index={index}
    >
      {/* Checkbox: gates inclusion in Apply All */}
      <input
        type="checkbox"
        className={styles.rowCheckbox}
        checked={row.enabled}
        aria-label="Include in Apply All"
        data-filter-control="checkbox"
        onChange={(e) => onSetEnabled(e.target.checked)}
      />

      {/* Column picker */}
      <span
        data-filter-focus-target={isFocusTarget ? "true" : undefined}
        style={{ display: "contents" }}
      >
        <span data-filter-control="column" style={{ display: "contents" }}>
          <ColumnPicker
            value={row.column}
            columns={columns}
            onChange={onColumnChange}
          />
        </span>
      </span>

      {/* Operator picker */}
      <span data-filter-control="op" style={{ display: "contents" }}>
        <OperatorPicker value={row.op} options={ops} onChange={onOpChange} />
      </span>

      {/* Value input wrapper — green tint when applied */}
      <span
        className={[styles.valueInputWrapper, isApplied ? styles.appliedTint : ""].filter(Boolean).join(" ")}
        data-filter-control="value"
      >
        <ValueInput
          column={row.column}
          columns={columns}
          op={row.op}
          value={row.value}
          onChange={(v) => onChange({ ...row, value: v })}
        />
      </span>

      {/* Spacer pushes action buttons to the right */}
      <span className={styles.conditionRowSpacer} />

      {/* Per-row Apply / Applied button */}
      <RowApplyButton
        onClick={onApplyOnly}
        applied={isApplied}
        data-filter-control="apply"
      />

      {/* − remove button */}
      <button
        type="button"
        className={styles.iconBtn}
        aria-label="Remove row"
        data-filter-control="remove"
        onClick={onRemove}
      >
        <Minus size={11} />
      </button>

      {/* + insert below button */}
      <button
        type="button"
        className={styles.iconBtn}
        aria-label="Insert row below"
        data-filter-control="insert"
        onClick={onInsertBelow}
      >
        <Plus size={11} />
      </button>
    </div>
  );
}
