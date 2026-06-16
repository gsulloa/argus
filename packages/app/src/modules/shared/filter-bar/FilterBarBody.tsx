import type { ReactNode } from "react";
import styles from "./FilterBarBody.module.css";

export interface FilterBarBodyProps {
  children: ReactNode;
  className?: string;
}

export function FilterBarBody({ children, className }: FilterBarBodyProps) {
  return (
    <div className={[styles.body, className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}

export default FilterBarBody;
