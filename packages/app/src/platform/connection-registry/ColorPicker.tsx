/**
 * ColorPicker — shared swatch row for picking a connection color.
 *
 * Renders a "no color" option followed by one swatch per palette entry.
 * Uses radio-group semantics: role="radiogroup" on the container,
 * role="radio" + aria-checked on each swatch. Keyboard-accessible via
 * arrow keys and Space/Enter.
 *
 * See: openspec/changes/connection-colors/design.md (Decision 5, Decision 6)
 */

import { useId, useRef } from "react";
import {
  CONNECTION_COLORS,
  connectionColorVar,
  type ConnectionColor,
} from "./colors";
import styles from "./ColorPicker.module.css";

export interface ColorPickerProps {
  /** Currently selected color key, or null for "no color". */
  value: string | null;
  /** Called with the new key (or null to clear) when the user picks a swatch. */
  onChange: (next: string | null) => void;
  /** Optional id for the group element (for aria-labelledby wiring). */
  id?: string;
  /** Optional visible label text rendered above the swatch row. */
  label?: string;
}

export function ColorPicker({ value, onChange, id, label }: ColorPickerProps) {
  const groupId = useId();
  const labelId = useId();
  const groupRef = useRef<HTMLDivElement>(null);

  // Build ordered list: [null, ...palette keys]
  const options: Array<{ key: string | null; label: string }> = [
    { key: null, label: "No color" },
    ...CONNECTION_COLORS.map((c) => ({ key: c.key, label: c.label })),
  ];

  function handleClick(key: string | null) {
    onChange(key);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, idx: number) {
    const swatches = groupRef.current?.querySelectorAll<HTMLButtonElement>(
      "[role='radio']",
    );
    if (!swatches) return;

    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      const next = swatches[(idx + 1) % swatches.length];
      next?.focus();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      const prev = swatches[(idx - 1 + swatches.length) % swatches.length];
      prev?.focus();
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      onChange(options[idx]?.key ?? null);
    }
  }

  return (
    <div className={styles.wrapper}>
      {label && (
        <span id={labelId} className={styles.label}>
          {label}
        </span>
      )}
      <div
        ref={groupRef}
        id={id ?? groupId}
        role="radiogroup"
        aria-labelledby={label ? labelId : undefined}
        className={styles.row}
      >
        {options.map((opt, idx) => {
          const isSelected = value === opt.key;
          const colorStyle =
            opt.key !== null
              ? ({ "--swatch-color": connectionColorVar(opt.key as ConnectionColor) } as React.CSSProperties)
              : undefined;

          return (
            <button
              key={opt.key ?? "__none__"}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-label={opt.label}
              title={opt.label}
              className={`${styles.swatch} ${opt.key === null ? styles.swatchNone : styles.swatchColor}`}
              style={colorStyle}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => handleClick(opt.key)}
              onKeyDown={(e) => handleKeyDown(e, idx)}
              data-selected={isSelected || undefined}
            />
          );
        })}
      </div>
    </div>
  );
}
