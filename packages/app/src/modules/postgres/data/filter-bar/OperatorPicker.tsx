import type { Operator } from "../types";
import styles from "./FilterBar.module.css";

interface Props {
  value: Operator;
  options: Operator[];
  onChange(next: Operator): void;
}

export function OperatorPicker({ value, options, onChange }: Props) {
  // If the current operator isn't in the option set (e.g. column type
  // changed), surface it anyway so the user can still see what they had —
  // the OperatorPicker doesn't auto-coerce, the parent does.
  const showCurrent = options.includes(value) ? options : [value, ...options];
  return (
    <select
      className={styles.opSelect}
      value={value}
      onChange={(e) => onChange(e.target.value as Operator)}
      aria-label="Operator"
    >
      {showCurrent.map((op) => (
        <option key={op} value={op}>
          {op}
        </option>
      ))}
    </select>
  );
}
