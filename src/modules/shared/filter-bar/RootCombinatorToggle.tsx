import styles from "./RootCombinatorToggle.module.css";

export interface RootCombinatorToggleProps {
  value: "AND" | "OR";
  onChange: (next: "AND" | "OR") => void;
  "aria-label"?: string;
}

const OPTIONS: Array<"AND" | "OR"> = ["AND", "OR"];

export function RootCombinatorToggle({
  value,
  onChange,
  "aria-label": ariaLabel = "Root combinator",
}: RootCombinatorToggleProps) {
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const currentIndex = OPTIONS.indexOf(value);
      const nextIndex =
        e.key === "ArrowRight"
          ? (currentIndex + 1) % OPTIONS.length
          : (currentIndex - 1 + OPTIONS.length) % OPTIONS.length;
      onChange(OPTIONS[nextIndex]!);
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={styles.toggle}
      onKeyDown={handleKeyDown}
    >
      {OPTIONS.map((opt, i) => {
        const isActive = opt === value;
        const isFirst = i === 0;
        const isLast = i === OPTIONS.length - 1;
        const classNames = [
          styles.option,
          isActive ? styles.optionActive : undefined,
          isFirst ? styles.optionFirst : undefined,
          isLast ? styles.optionLast : styles.optionNotLast,
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={isActive}
            className={classNames}
            onClick={() => {
              if (!isActive) onChange(opt);
            }}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

export default RootCombinatorToggle;
