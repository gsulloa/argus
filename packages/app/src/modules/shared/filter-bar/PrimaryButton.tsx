import type { ReactNode } from "react";
import styles from "./PrimaryButton.module.css";

export interface PrimaryButtonProps {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  dirty?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function PrimaryButton({
  children,
  onClick,
  type = "button",
  disabled,
  dirty,
  ariaLabel,
  className,
}: PrimaryButtonProps) {
  const classNames = [
    styles.button,
    dirty ? styles.dirty : undefined,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={classNames}
    >
      {children}
    </button>
  );
}

export default PrimaryButton;
