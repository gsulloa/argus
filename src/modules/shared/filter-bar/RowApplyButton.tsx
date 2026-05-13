import { Play } from "lucide-react";
import styles from "./RowApplyButton.module.css";

export interface RowApplyButtonProps {
  onClick: () => void;
  "aria-label": string;
  title?: string;
  disabled?: boolean;
}

export function RowApplyButton({
  onClick,
  "aria-label": ariaLabel,
  title,
  disabled,
}: RowApplyButtonProps) {
  return (
    <button
      type="button"
      className={styles.applyBtn}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      <Play size={11} />
    </button>
  );
}

export default RowApplyButton;
