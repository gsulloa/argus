import type { ReactNode } from "react";
import styles from "./FilterBarShell.module.css";

export interface FilterBarShellProps {
  children: ReactNode;
  className?: string;
}

export function FilterBarShell({ children, className }: FilterBarShellProps) {
  return (
    <div className={[styles.shell, className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}

export default FilterBarShell;
