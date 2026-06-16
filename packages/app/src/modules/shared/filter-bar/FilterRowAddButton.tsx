import type { ReactNode } from "react";
import styles from "./FilterRowAddButton.module.css";

export interface FilterRowAddButtonProps {
  children: ReactNode;
  onClick: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function FilterRowAddButton({
  children,
  onClick,
  type = "button",
  disabled,
  className,
  "data-testid": testId,
}: FilterRowAddButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={[styles.addButton, className].filter(Boolean).join(" ")}
    >
      {children}
    </button>
  );
}

export default FilterRowAddButton;
