import styles from "./RowApplyButton.module.css";

export interface RowApplyButtonProps {
  onClick: () => void;
  "aria-label"?: string;
  title?: string;
  disabled?: boolean;
  /** When true, renders "Applied" label with green styling. */
  applied?: boolean;
  /** data attribute for keyboard shortcut routing. */
  "data-filter-control"?: string;
}

export function RowApplyButton({
  onClick,
  "aria-label": ariaLabel,
  title,
  disabled,
  applied,
  "data-filter-control": dataFilterControl,
}: RowApplyButtonProps) {
  return (
    <button
      type="button"
      className={[styles.applyBtn, applied ? styles.applied : ""].filter(Boolean).join(" ")}
      aria-label={ariaLabel ?? (applied ? "Applied — click to re-apply" : "Apply only this row")}
      title={title ?? (applied ? "Applied — click to re-apply" : "Apply only this row (replaces active filter)")}
      disabled={disabled}
      data-filter-control={dataFilterControl}
      onClick={onClick}
    >
      {applied ? "Applied" : "Apply"}
    </button>
  );
}

export default RowApplyButton;
