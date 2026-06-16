import { Search, X } from "lucide-react";
import { type ChangeEvent, type KeyboardEvent } from "react";
import styles from "./TableSearchInput.module.css";
import { noAutoCorrectProps } from "../../shared/text-input-hygiene";

interface Props {
  value: string;
  onChange: (value: string) => void;
  matches: number;
  total: number;
}

export function TableSearchInput({ value, onChange, matches, total }: Props) {
  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onChange("");
    }
  }
  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    onChange(e.target.value);
  }
  const showIndicator = value.length > 0;
  return (
    <div className={styles.root}>
      <span className={styles.icon} aria-hidden>
        <Search size={12} />
      </span>
      <input
        {...noAutoCorrectProps}
        className={styles.input}
        type="text"
        value={value}
        placeholder="Search tables…"
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        aria-label="Search DynamoDB tables"
      />
      {showIndicator && (
        <span className={styles.indicator} aria-live="polite">
          {matches} of {total}
        </span>
      )}
      {value.length > 0 && (
        <button
          type="button"
          className={styles.clear}
          onClick={() => onChange("")}
          aria-label="Clear search"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
