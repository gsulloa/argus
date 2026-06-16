import type { ReactNode } from "react";
import styles from "./FilterTypeBadge.module.css";

export interface FilterTypeBadgeProps {
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}

export function FilterTypeBadge({ children, className, "aria-label": ariaLabel }: FilterTypeBadgeProps) {
  return (
    <span
      className={[styles.badge, className].filter(Boolean).join(" ")}
      aria-label={ariaLabel}
    >
      {children}
    </span>
  );
}

export default FilterTypeBadge;
