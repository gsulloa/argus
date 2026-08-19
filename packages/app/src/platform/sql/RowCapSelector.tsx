/**
 * Shared row-limit control (`openspec/changes/configurable-result-row-cap`,
 * tasks 5.2/5.4). Reads/writes the `sql.rowCap` setting via `useRowCap`.
 *
 * Factoring: the toolbar trigger and the truncation banner's "Raise limit"
 * action must open the *same* menu (same presets, same custom-value flow,
 * same validation) even though they live in two different components. This
 * file exports:
 *
 * - `RowCapMenu({ trigger })` — the Radix dropdown (presets + custom entry)
 *   plus the *single* `useRowCap()` call for the whole control. `trigger`
 *   may be a plain node (as `TruncationBanner`'s static "Raise limit" button
 *   uses it) or a `(rowCap: number) => ReactNode` render prop for callers
 *   that need to display the live value on the trigger itself.
 *
 *   The render-prop keeps a trigger's label sourced from the same hook
 *   instance that writes it, so no caller needs its own `useRowCap()`.
 *
 * - `RowCapSelector({ compact })` — the toolbar-facing trigger button that
 *   wraps `RowCapMenu` with a render-prop trigger. `compact` (default
 *   `true`) shows the abbreviated `Limit: 10k` form for tight toolbar real
 *   estate; `compact={false}` shows the fully spelled-out
 *   `Limit: 10,000 rows` form for contexts with more room (e.g. a future
 *   settings page).
 *
 * Cross-component live sync — a banner's "Raise limit" updating an
 * already-mounted toolbar control, in this tab or another one — is handled by
 * `useSetting`'s subscriber registry, so every mounted `useRowCap()` sees the
 * write. No lifted instance or shared store is needed here.
 */
import { useCallback, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import { HARD_ROW_CAP, clampRowCap, formatRowCapShort, useRowCap } from "./useRowCap";
import styles from "./RowCapSelector.module.css";

const PRESETS = [1000, 10000, 50000, 100000];

export interface RowCapMenuProps {
  trigger: React.ReactNode | ((rowCap: number) => React.ReactNode);
}

/** The shared dropdown: presets + "Custom…" numeric entry. */
export function RowCapMenu({ trigger }: RowCapMenuProps) {
  const [rowCap, setRowCap] = useRowCap();
  const [open, setOpen] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [customError, setCustomError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const resetCustom = useCallback(() => {
    setCustomMode(false);
    setCustomValue("");
    setCustomError(false);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) resetCustom();
    },
    [resetCustom],
  );

  const commitCustom = useCallback(() => {
    // customValue is always digits-only (see onChange below), but guard
    // empty/garbage input the same way a paste could introduce it.
    const parsed = customValue.trim() === "" ? NaN : Number(customValue);
    const clamped = clampRowCap(parsed);
    if (clamped === null) {
      setCustomError(true);
      return;
    }
    setRowCap(clamped);
    setOpen(false);
    resetCustom();
  }, [customValue, setRowCap, resetCustom]);

  const renderedTrigger = typeof trigger === "function" ? trigger(rowCap) : trigger;

  return (
    <DropdownMenu.Root open={open} onOpenChange={handleOpenChange}>
      <DropdownMenu.Trigger asChild>{renderedTrigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={styles.content} align="start" sideOffset={4}>
          {customMode ? (
            <div className={styles.customRow}>
              <input
                ref={inputRef}
                type="number"
                inputMode="numeric"
                min={1}
                max={HARD_ROW_CAP}
                step={1}
                autoFocus
                placeholder="Rows (1–1,000,000)"
                className={styles.customInput}
                data-invalid={customError || undefined}
                value={customValue}
                onChange={(e) => {
                  setCustomValue(e.target.value);
                  setCustomError(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitCustom();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    resetCustom();
                  }
                }}
              />
              <button
                type="button"
                className={styles.customApply}
                onClick={commitCustom}
                aria-label="Apply custom row limit"
              >
                Apply
              </button>
              {customError ? (
                <span className={styles.customErrorMsg} role="alert">
                  Enter a whole number from 1 to 1,000,000.
                </span>
              ) : null}
            </div>
          ) : (
            <>
              {PRESETS.map((preset) => (
                <DropdownMenu.Item
                  key={preset}
                  className={styles.item}
                  data-selected={rowCap === preset || undefined}
                  onSelect={() => setRowCap(preset)}
                >
                  {formatRowCapShort(preset)}
                </DropdownMenu.Item>
              ))}
              <DropdownMenu.Separator className={styles.separator} />
              <DropdownMenu.Item
                className={styles.item}
                // Keep the menu open — the custom field renders in place of
                // the preset list rather than closing into a separate modal.
                onSelect={(e) => {
                  e.preventDefault();
                  setCustomMode(true);
                }}
              >
                Custom…
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export interface RowCapSelectorProps {
  /** Abbreviated `Limit: 10k` (default) vs spelled-out `Limit: 10,000 rows`. */
  compact?: boolean;
}

/** Toolbar-facing trigger button. Always reflects the current `sql.rowCap`. */
export function RowCapSelector({ compact = true }: RowCapSelectorProps) {
  return (
    <RowCapMenu
      trigger={(rowCap) => {
        const label = compact
          ? `Limit: ${formatRowCapShort(rowCap)}`
          : `Limit: ${rowCap.toLocaleString()} rows`;
        return (
          <button
            type="button"
            className={styles.trigger}
            aria-label="Row limit"
            title="Row limit"
            data-testid="row-cap-trigger"
          >
            <span className={styles.triggerLabel}>{label}</span>
            <ChevronDown size={10} className={styles.chevron} />
          </button>
        );
      }}
    />
  );
}
