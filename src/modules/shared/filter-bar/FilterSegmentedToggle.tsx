import type { ReactNode } from "react";
import styles from "./FilterSegmentedToggle.module.css";

export interface SegmentOption {
  id: string;
  label: string;
  badge?: ReactNode;
}

export interface FilterSegmentedToggleProps {
  options: SegmentOption[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
}

export function FilterSegmentedToggle({
  options,
  value,
  onChange,
  ariaLabel,
}: FilterSegmentedToggleProps) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={styles.toggle}>
      {options.map((opt, i) => {
        const isActive = opt.id === value;
        const isLast = i === options.length - 1;
        const classNames = [
          styles.option,
          isActive ? styles.optionActive : undefined,
          isLast ? styles.optionLast : styles.optionNotLast,
          i === 0 ? styles.optionFirst : undefined,
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            className={classNames}
            onClick={() => onChange(opt.id)}
          >
            {opt.label}
            {opt.badge}
          </button>
        );
      })}
    </div>
  );
}

export default FilterSegmentedToggle;
