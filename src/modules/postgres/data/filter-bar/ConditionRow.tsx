import { AlertTriangle, X } from "lucide-react";
import { ColumnPicker } from "./ColumnPicker";
import { OperatorPicker } from "./OperatorPicker";
import { ValueInput } from "./ValueInput";
import { operatorsForColumn } from "./operatorRules";
import { coerceValueForOperator } from "./treeMutations";
import type { ColumnRef, Condition, DataColumn, Operator } from "../types";
import styles from "./FilterBar.module.css";

interface Props {
  condition: Condition;
  columns: DataColumn[];
  onChange(next: Condition): void;
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

export function ConditionRow({ condition, columns, onChange, onRemove }: Props) {
  const meta = namedColumnMeta(condition.column, columns);
  const ops = operatorsForColumn(condition.column, meta.dataType, meta.isNullable);

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
    // Keep the operator if it's still valid; otherwise fall back to the
    // first option (typically "=").
    const nextOp: Operator = nextOps.includes(condition.op) ? condition.op : nextOps[0]!;
    const nextValue = coerceValueForOperator(condition.value, nextOp);
    onChange({ column: next, op: nextOp, value: nextValue });
  }

  function onOpChange(next: Operator) {
    const nextValue = coerceValueForOperator(condition.value, next);
    onChange({ ...condition, op: next, value: nextValue });
  }

  return (
    <span className={styles.row}>
      <ColumnPicker
        value={condition.column}
        columns={columns}
        onChange={onColumnChange}
      />
      {condition.column.kind === "any_column" && (
        <span
          className={styles.warnIcon}
          title="Searches every text-castable column — slow on large tables."
          aria-label="Any column performance warning"
        >
          <AlertTriangle size={12} />
        </span>
      )}
      <OperatorPicker value={condition.op} options={ops} onChange={onOpChange} />
      <ValueInput
        column={condition.column}
        columns={columns}
        op={condition.op}
        value={condition.value}
        onChange={(v) => onChange({ ...condition, value: v })}
      />
      <button
        type="button"
        className={styles.removeBtn}
        aria-label="Remove condition"
        onClick={onRemove}
      >
        <X size={11} />
      </button>
    </span>
  );
}
