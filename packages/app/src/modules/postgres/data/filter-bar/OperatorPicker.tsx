import type { Operator } from "../types";
import styles from "./FilterBar.module.css";

interface Props {
  /**
   * `null` only for rows rehydrated from a v0.8.6 filter record whose operators
   * were cleared by that release's `Operator: Unset`. No current UI path
   * produces it — see `FilterRow` in `../types`.
   */
  value: Operator | null;
  options: Operator[];
  onChange(next: Operator): void;
}

/** Sentinel `<option>` value for the unset placeholder — never emitted. */
const UNSET_VALUE = "";

export function OperatorPicker({ value, options, onChange }: Props) {
  const isUnset = value === null;
  // If the current operator isn't in the option set (e.g. column type
  // changed), surface it anyway so the user can still see what they had —
  // the OperatorPicker doesn't auto-coerce, the parent does.
  const showCurrent =
    isUnset || options.includes(value) ? options : [value, ...options];
  return (
    <select
      className={[styles.opSelect, isUnset ? styles.opSelectUnset : ""]
        .filter(Boolean)
        .join(" ")}
      value={isUnset ? UNSET_VALUE : value}
      onChange={(e) => onChange(e.target.value as Operator)}
      aria-label="Operator"
    >
      {/* Placeholder shown only while unset. Disabled, so the picker can never
          be used to RE-enter the unset state — and since v0.8.6's operator-
          clearing Unset is gone, nothing else can either. */}
      {isUnset && (
        <option value={UNSET_VALUE} disabled>
          —
        </option>
      )}
      {showCurrent.map((op) => (
        <option key={op} value={op}>
          {op}
        </option>
      ))}
    </select>
  );
}
