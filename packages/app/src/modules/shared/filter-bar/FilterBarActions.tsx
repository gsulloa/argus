import type { ReactNode } from "react";
import styles from "./FilterBarActions.module.css";

export interface FilterBarActionsProps {
  left?: ReactNode;
  right?: ReactNode;
  className?: string;
}

export function FilterBarActions({ left, right, className }: FilterBarActionsProps) {
  return (
    <div className={[styles.actions, className].filter(Boolean).join(" ")}>
      {left}
      <div className={styles.spacer} />
      {right}
    </div>
  );
}

export default FilterBarActions;
