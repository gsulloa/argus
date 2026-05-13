import type { ReactNode } from "react";
import styles from "./FilterBarHeader.module.css";

export interface FilterBarHeaderProps {
  children: ReactNode;
  className?: string;
}

export function FilterBarHeader({ children, className }: FilterBarHeaderProps) {
  return (
    <div className={[styles.header, className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}

export default FilterBarHeader;
