import type { CSSProperties } from "react";
import { GripVertical, Minus, Plus } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ColumnPicker } from "./ColumnPicker";
import { OperatorPicker } from "./OperatorPicker";
import { ValueInput, RawExpressionInput } from "./ValueInput";
import { operatorsForColumn } from "./operatorRules";
import { coerceValueForOperator } from "./treeMutations";
import { categorize } from "../typeHelpers";
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
  const isRaw = row.column.kind === "raw";
  const meta = namedColumnMeta(row.column, columns);
  const ops = operatorsForColumn(row.column, meta.dataType, meta.isNullable);

  function onColumnChange(next: ColumnRef) {
    const nextType =
      next.kind === "named"
        ? columns.find((c) => c.name === next.name)?.data_type ?? null
        : null;
    const nextOps = operatorsForColumn(
      next,
      nextType,
      next.kind === "named"
        ? columns.find((c) => c.name === next.name)?.is_nullable ?? true
        : true,
    );
    // An unset row stays unset across a column change — nothing is auto-selected
    // and the value is left verbatim (including for boolean columns, whose eager
    // `true` seeding waits until a real operator is picked).
    if (row.op === null && next.kind !== "raw") {
      onChange({ ...row, column: next });
      return;
    }
    const nextOp: Operator =
      row.op !== null && nextOps.includes(row.op) ? row.op : nextOps[0]!;
    let nextValue = coerceValueForOperator(row.value, nextOp);
    // Boolean columns render a two-option select (true/false) with no "empty"
    // state; seed a concrete `true` when switching to one so the row is
    // complete immediately (the value input also enforces this as a fallback).
    if (
      nextType &&
      categorize(nextType) === "boolean" &&
      typeof nextValue !== "boolean" &&
      nextOp !== "IS NULL" &&
      nextOp !== "IS NOT NULL"
    ) {
      nextValue = true;
    }
    onChange({ ...row, column: next, op: nextOp, value: nextValue });
  }

  function onOpChange(next: Operator) {
    const nextValue = coerceValueForOperator(row.value, next);
    onChange({ ...row, op: next, value: nextValue });
  }

  const sortable = useSortable({ id: row.id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    ...(sortable.isDragging ? { opacity: 0.5, zIndex: 1 } : null),
  };

  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={[
        styles.conditionRow,
        !row.enabled ? styles.conditionRowDisabled : "",
        sortable.isDragging ? styles.conditionRowDragging : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-filter-row-index={index}
    >
      {/* Drag handle: reorders rows (pointer + keyboard) */}
      <button
        type="button"
        className={styles.dragHandle}
        aria-label="Reorder filter row"
        data-filter-control="drag"
        {...sortable.attributes}
        {...sortable.listeners}
      >
        <GripVertical size={11} />
      </button>

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

      {/* Operator picker — hidden for raw rows */}
      {!isRaw && (
        <span data-filter-control="op" style={{ display: "contents" }}>
          <OperatorPicker value={row.op} options={ops} onChange={onOpChange} />
        </span>
      )}

      {/* Value input wrapper — green tint when applied */}
      <span
        className={[styles.valueInputWrapper, isApplied ? styles.appliedTint : ""].filter(Boolean).join(" ")}
        data-filter-control="value"
      >
        {isRaw ? (
          <RawExpressionInput
            value={typeof row.value === "string" ? row.value : ""}
            onChange={(v) => onChange({ ...row, value: v })}
          />
        ) : (
          <ValueInput
            column={row.column}
            columns={columns}
            op={row.op}
            value={row.value}
            onChange={(v) => onChange({ ...row, value: v })}
          />
        )}
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
