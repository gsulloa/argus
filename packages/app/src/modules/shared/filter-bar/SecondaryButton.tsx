import type { ReactNode } from "react";
import styles from "./SecondaryButton.module.css";

export interface SecondaryButtonProps {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function SecondaryButton({
  children,
  onClick,
  type = "button",
  disabled,
  ariaLabel,
  className,
}: SecondaryButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={[styles.button, className].filter(Boolean).join(" ")}
    >
      {children}
    </button>
  );
}

export default SecondaryButton;
